// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ──────────────────────────────────────────
//  Interfaces
// ──────────────────────────────────────────

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

interface IGasFlowConfig {
    function stakePool() external view returns (address);
    function relayers(address relayer) external view returns (bool);
    function l1FeeBps() external view returns (uint256);
    function priceFeeds(address token) external view returns (address ethUsdFeed, address tokenUsdFeed);
    function feeTokenDecimals(address token) external view returns (uint8);
    function minFeeRateBps() external view returns (uint256);
    function STALENESS_THRESHOLD() external view returns (uint256);
    function processCompensation(
        address relayer,
        uint256 ethAmount,
        address feeToken,
        uint256 feeAmount
    ) external;
}

/**
 * @title GasFlowDelegator
 * @author GasFlow
 * @notice EIP-7702 delegation contract — the code that runs AT the user's EOA.
 *
 *         CRITICAL: EIP-7702 uses DELEGATECALL semantics.
 *         - address(this) = user's EOA address (NOT the Delegator contract address)
 *         - msg.sender   = whoever called the EOA (usually the relayer)
 *         - storage      = the EOA's own storage (initially all zeroes)
 *
 *         Shared config lives in GasFlowConfig (immutable reference), per-user state
 *         (nonce) lives in the EOA's own storage.
 *
 * ## End-to-end flow:
 *   1. User signs ECDSA over (chainId, nonce, calls) — authorizing the batch
 *   2. Relayer submits a type-0x04 tx with authorization + execute data
*   3. Inside execute(): gas metering starts → verify sig → execute calls →
     *      read oracle prices → close metering → convert fee →
     *      direct transfer(stakePool) → processCompensation (Config validates + compensateRelayer)
 */
contract GasFlowDelegator is ReentrancyGuardTransient {
    using MessageHashUtils for bytes32;
    using SafeERC20 for IERC20;

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    uint256 public constant MAX_BATCH_SIZE = 10;
    IGasFlowConfig public immutable config;

    /// @dev Gas overhead added AFTER the measured window closes.
    ///      Covers operations that cannot be measured because they depend on gasUsed
    ///      (fee computation → transfer → processCompensation → events), plus the
    ///      base transaction cost (21k) that execute() never "sees" via gasleft().
    ///      Measured window now includes: config reads, sig verify, nonce SSTORE,
    ///      _executeBatch, and oracle price reads (split out of _ethToStable).
    ///      Remaining unmeasured: IERC20.transfer (~13k), processCompensation
    ///      (~72k incl. oracle validate + receiveFee + compensateRelayer), events
    ///      (~5k), fee math (~2k), intrinsic tx cost (21k). Total ≈ 113k → rounded
    ///      to 115k to keep a small safety margin for relayer.
    uint256 public constant POST_FEE_OVERHEAD = 150000;

    event CallExecuted(address indexed to, uint256 value);
    event BatchExecuted(
        uint256 indexed nonce,
        address indexed relayer,
        uint256 gasUsed,
        uint256 ethCompensation,
        uint256 l1Fee
    );
    event FeeCollected(
        address indexed token,
        uint256 feeAmount,
        uint256 ethCompensation
    );

    error CallingConfig();

    /*    ------------ Constructor ------------    */
    constructor(address _config) {
        require(_config != address(0), "Delegator: zero config");
        config = IGasFlowConfig(_config);
    }

    /*    ---------- Read Functions -----------    */
    function nonce() public view returns (uint256 n) {
        bytes32 slot = keccak256("gasflow.delegator.nonce");
        assembly {
            n := sload(slot)
        }
    }

    /**
     * @dev Verifies an EIP-191 personal_sign signature over the full execution intent.
     */
    function _verifySignature(
        Call[] calldata calls,
        bytes calldata signature,
        address feeToken,
        uint256 maxFeeAmount,
        uint256 authGasOverhead,
        uint256 deadline,
        address sender
    ) internal view {
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                nonce(),
                calls,
                feeToken,
                maxFeeAmount,
                authGasOverhead,
                deadline,
                sender
            )
        );
        address recovered = ECDSA.recover(digest.toEthSignedMessageHash(), signature);
        require(recovered == address(this), "Delegator: invalid signature");
    }

    function _readPrice(address feed, string memory label) internal view returns (int256) {
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = AggregatorV3Interface(feed).latestRoundData();

        require(answer > 0, string.concat("Delegator: non-positive ", label, " price"));
        require(updatedAt != 0, string.concat("Delegator: stale ", label, " price"));
        require(answeredInRound >= roundId, string.concat("Delegator: stale ", label, " price"));
        require(
            block.timestamp - updatedAt <= config.STALENESS_THRESHOLD(),
            string.concat("Delegator: stale ", label, " price")
        );

        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
        if (feedDecimals < 18) {
            return answer * int256(10 ** (18 - feedDecimals));
        }
        if (feedDecimals > 18) {
            return answer / int256(10 ** (feedDecimals - 18));
        }
        return answer;
    }

    function _readOraclePrices(
        address feeToken,
        address ethUsdFeed,
        address tokenUsdFeed
    )
        internal
        view
        returns (uint8 tokenDec, int256 ethUsd, int256 tokenUsd)
    {
        tokenDec = config.feeTokenDecimals(feeToken);
        ethUsd = _readPrice(ethUsdFeed, "ETH");
        tokenUsd = _readPrice(tokenUsdFeed, "token");
    }

    function _computeFee(
        uint256 ethAmount,
        uint8 tokenDec,
        int256 ethUsd,
        int256 tokenUsd
    ) internal pure returns (uint256) {
        return (ethAmount * uint256(ethUsd) * (10 ** tokenDec))
            / (1e18 * uint256(tokenUsd));
    }

    /*    ---------- Write Functions -----------    */
    /**
     * @notice Execute a batch of calls with gas sponsorship.
     * @param calls             The sequence of contract calls the user wants to make.
     * @param signature         ECDSA signature over (chainId, nonce, calls) signed by user's EOA.
     * @param feeToken          The stablecoin token the user pays fees in (e.g., USDC).
     * @param maxFeeAmount      Maximum fee the user authorizes (relayer estimates off-chain).
     * @param authGasOverhead   EIP-7702 authorization gas cost, passed by relayer.
     *                          0 for already-delegated users (no authorizationList).
     *                          ~12500 for non-empty accounts, ~37500 for empty accounts.
     *                          Relayer measures this off-chain via differential gas estimation.
     */
    function execute(
        Call[] calldata calls,
        bytes calldata signature,
        address feeToken,
        uint256 maxFeeAmount,
        uint256 authGasOverhead,
        uint256 deadline
    ) external payable nonReentrant {
        // ── Step 1: Start gas metering at the very beginning ──
        uint256 gasStart = gasleft();
        require(config.relayers(msg.sender), "Delegator: not relayer");
        require(calls.length <= MAX_BATCH_SIZE, "Delegator: batch too large");
        require(block.timestamp <= deadline, "Delegator: expired");
        uint256 totalCallValue;
        for (uint256 i = 0; i < calls.length; i++) {
            if(calls[i].to == address(config)) {
                revert CallingConfig();
            }
            totalCallValue += calls[i].value;
        }
        require(msg.value == totalCallValue, "Delegator: msg.value mismatch");
        require(authGasOverhead <= 50_000, "auth overhead too high");
        address stakePool = config.stakePool();
        require(stakePool != address(0), "Delegator: stake pool not set");
        (address ethUsdFeed, address tokenUsdFeed) = config.priceFeeds(feeToken);
        require(ethUsdFeed != address(0), "Delegator: unsupported fee token");

        // ── Step 2: Verify ECDSA signature ──
        _verifySignature(calls, signature, feeToken, maxFeeAmount, authGasOverhead, deadline, msg.sender);

        // ── Step 3: Execute batch ──
        uint256 currentNonce = nonce();
        _setNonce(currentNonce + 1);
        _executeBatch(calls);

        // ── Step 4: Read oracle prices (inside measurement window) ──
        (uint8 tokenDec, int256 ethUsd, int256 tokenUsd) =
            _readOraclePrices(feeToken, ethUsdFeed, tokenUsdFeed);

        // ── Step 5: Close measurement window + compute compensation ──
        uint256 gasUsed = gasStart - gasleft() + POST_FEE_OVERHEAD + authGasOverhead;
        uint256 baseEthCompensation = gasUsed * tx.gasprice;
        uint256 l1Fee = (baseEthCompensation * config.l1FeeBps()) / 10000;
        uint256 ethCompensation = baseEthCompensation + l1Fee + msg.value;

        // ── Step 6: Convert to stablecoin (pure math, no external calls) ──
        uint256 baseFee = _computeFee(ethCompensation, tokenDec, ethUsd, tokenUsd);
        uint256 feeAmount = (baseFee * config.minFeeRateBps()) / 10000;
        require(feeAmount <= maxFeeAmount, "Delegator: fee exceeds max");
        require(feeAmount > 0, "Delegator: fee too small");

        emit FeeCollected(feeToken, feeAmount, ethCompensation);

        // ── Step 7: Direct transfer to stakePool (no permit/allowance needed) ──
        IERC20(feeToken).safeTransfer(stakePool, feeAmount);

        // ── Step 8: Process compensation via Config (oracle validate + compensateRelayer) ──
        config.processCompensation(
            msg.sender,
            ethCompensation,
            feeToken,
            feeAmount
        );

        emit BatchExecuted(currentNonce, msg.sender, gasUsed, ethCompensation, l1Fee);
    }

    function _executeBatch(Call[] calldata calls) internal {
        for (uint256 i = 0; i < calls.length; i++) {
            _executeCall(calls[i]);
        }
    }

    function _executeCall(Call calldata callItem) internal {
        (bool success, bytes memory returndata) =
        callItem.to.call{value: callItem.value}(callItem.data);

        if (!success) {
            assembly {
                revert(add(returndata, 32), mload(returndata))
            }
        }
    }

    function _setNonce(uint256 n) internal {
        bytes32 slot = keccak256("gasflow.delegator.nonce");
        assembly {
            sstore(slot, n)
        }
    }

    fallback() external payable {}
    receive() external payable {}
}