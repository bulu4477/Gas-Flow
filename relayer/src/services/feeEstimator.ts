import {
  type Address,
  type Hex,
  encodeAbiParameters,
  hashMessage,
  keccak256,
  parseEther,
} from "viem";
import { type Call, type EstimateResponse, type SignedAuthorization } from "../types/index";
import { config } from "../config";
import {
  checkDelegationStatus,
  readConfig,
  readChainlinkPrice,
  getPublicClient,
} from "./clients";
import { nonceManager } from "./nonceManager";
import { withRetry } from "../utils/retry";

const BASE_TX_GAS = 21_000n;
const POST_FEE_OVERHEAD = 135_000n;
const DELEGATOR_EXECUTION_OVERHEAD = 55_000n;
const PER_CALL_OVERHEAD = 5_000n;
const SINGLE_CALL_FALLBACK_GAS = 50_000n;
const SIMULATION_BALANCE = parseEther("1000");
const ESTIMATE_DEADLINE_SECONDS = 15 * 60;

async function estimateGasForCalls(
  user: Address,
  calls: Call[],
): Promise<bigint> {
  const publicClient = getPublicClient();

  let callsGas = 0n;
  for (const call of calls) {
    try {
      const callGas = await publicClient.estimateGas({
        account: user,
        to: call.to,
        data: call.data,
        value: call.value,
        stateOverride: [
          { address: user, balance: SIMULATION_BALANCE },
        ],
      });
      
      callsGas += callGas > BASE_TX_GAS
        ? callGas - BASE_TX_GAS
        : callGas;
    } catch {
      callsGas += SINGLE_CALL_FALLBACK_GAS;
    }
  }

  const rawEstimate =
    callsGas +
    DELEGATOR_EXECUTION_OVERHEAD +
    PER_CALL_OVERHEAD * BigInt(calls.length);

  return (rawEstimate * config.gasEstimateMarginBps) / 10_000n;

  // const gasEstimate = rawEstimate < MIN_EXECUTE_GAS_ESTIMATE
  //   ? MIN_EXECUTE_GAS_ESTIMATE
  //   : rawEstimate;

  // return (gasEstimate * config.gasEstimateMarginBps) / 10_000n;
}

// Empirical EIP-7702 authorization gas costs. These depend on whether the
// account already has delegation code set, not on the batch contents.
const EMPTY_ACCOUNT_AUTH_GAS = 37_500n;
const SWITCH_DELEGATION_AUTH_GAS = 25_000n;

async function estimateAuthGasOverhead(user: Address): Promise<bigint> {
  const isDelegatedToUs = await checkDelegationStatus(user);
  if (isDelegatedToUs) return 0n;

  const code = await getPublicClient().getCode({ address: user });
  if (!code || code === "0x") {
    // Pure EOA, no delegation code yet: writing the designation for the first time.
    return EMPTY_ACCOUNT_AUTH_GAS;
  }

  // Account already has some delegation code (e.g. old GasFlowDelegator or other).
  // Switching the designation is cheaper than writing to an empty account.
  return SWITCH_DELEGATION_AUTH_GAS;
}

export async function estimateFee(
  user: Address,
  calls: Call[],
  feeToken: Address,
  signature?: Hex,
  authorization?: SignedAuthorization,
): Promise<EstimateResponse> {
  const isDelegated = await checkDelegationStatus(user);

  let authGasOverhead = 0n;
  if (!isDelegated) {
    authGasOverhead = await estimateAuthGasOverhead(user);
  }

  const nonce = await nonceManager.getNextNonce(user);

  // Estimate quotes the batch gas model, but does not fully simulate execute().
  // Full execute() reaches GasFlowConfig.processCompensation(), whose delegation
  // code-hash check is only meaningful for the final submit transaction.
  const gasEstimate = await estimateGasForCalls(user, calls) + POST_FEE_OVERHEAD;

  const minFeeRateBps = await readConfig.minFeeRateBps();
  const l1FeeBps = await readConfig.l1FeeBps();

  const { ethUsdFeed, tokenUsdFeed } = await readConfig.priceFeeds(feeToken);
  if (tokenUsdFeed === "0x0000000000000000000000000000000000000000") {
    throw Object.assign(new Error("Fee token not supported"), {
      statusCode: 400,
    });
  }

  const { price: ethUsdPrice } = await withRetry(() => readChainlinkPrice(ethUsdFeed));
  const { price: tokenUsdPrice } = await withRetry(() => readChainlinkPrice(tokenUsdFeed));

  const feeTokenDecimals = await readConfig.feeTokenDecimals(feeToken);

  const gasPrice = await getPublicClient().getGasPrice();
  const totalGas = gasEstimate + authGasOverhead;
  const totalCallValue = calls.reduce((sum, call) => sum + call.value, 0n);
  const ethCompensation =
    (totalGas * gasPrice * (10_000n + l1FeeBps)) / 10_000n + totalCallValue;

  const baseFee =
    (ethCompensation * ethUsdPrice * (10n ** BigInt(feeTokenDecimals))) /
    (10n ** 18n * tokenUsdPrice);

  const feeWithMarkup = (baseFee * minFeeRateBps) / 10_000n;

  const maxFeeAmount =
    (feeWithMarkup * config.feeAmountMarginBps) / 10_000n;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + ESTIMATE_DEADLINE_SECONDS);

  const rawDigest = keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        {
          type: "tuple[]",
          components: [
            { type: "address", name: "to" },
            { type: "uint256", name: "value" },
            { type: "bytes", name: "data" },
          ],
        },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [BigInt(config.chainId), nonce, calls, feeToken, maxFeeAmount, authGasOverhead, deadline],
    ),
  );

  return {
    nonce,
    gasEstimate,
    authGasOverhead,
    maxFeeAmount,
    feeToken,
    feeTokenDecimals,
    configAddress: config.configAddress,
    deadline,
    rawDigest,
    ethSignedDigest: hashMessage({ raw: rawDigest }),
  };
}
