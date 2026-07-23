// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";


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
 * @notice EIP-7702 delegate code executed in the user's EOA context.
 * @dev address(this) is the user EOA. msg.sender must be a whitelisted relayer.
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

    /// @dev Extra gas added for post-metering fee transfer, compensation, events, and intrinsic tx cost.
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

    /// @dev Verifies the user's EIP-191 signature over the full batch intent.
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
     * @notice Executes user-authorized calls and pays the relayer from the stake pool.
     * @dev The signed digest binds chainId, nonce, calls, fee token, max fee,
     *      auth overhead, deadline, and msg.sender relayer.
     */
    function execute(
        Call[] calldata calls,
        bytes calldata signature,
        address feeToken,
        uint256 maxFeeAmount,
        uint256 authGasOverhead,
        uint256 deadline
    ) external payable nonReentrant {
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

        _verifySignature(calls, signature, feeToken, maxFeeAmount, authGasOverhead, deadline, msg.sender);

        uint256 currentNonce = nonce();
        _setNonce(currentNonce + 1);
        _executeBatch(calls);

        (uint8 tokenDec, int256 ethUsd, int256 tokenUsd) =
            _readOraclePrices(feeToken, ethUsdFeed, tokenUsdFeed);

        uint256 gasUsed = gasStart - gasleft() + POST_FEE_OVERHEAD + authGasOverhead;
        uint256 baseEthCompensation = gasUsed * tx.gasprice;
        uint256 l1Fee = (baseEthCompensation * config.l1FeeBps()) / 10000;
        uint256 ethCompensation = baseEthCompensation + l1Fee + msg.value;

        uint256 baseFee = _computeFee(ethCompensation, tokenDec, ethUsd, tokenUsd);
        uint256 feeAmount = (baseFee * config.minFeeRateBps()) / 10000;
        require(feeAmount <= maxFeeAmount, "Delegator: fee exceeds max");
        require(feeAmount > 0, "Delegator: fee too small");

        emit FeeCollected(feeToken, feeAmount, ethCompensation);

        IERC20(feeToken).safeTransfer(stakePool, feeAmount);

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