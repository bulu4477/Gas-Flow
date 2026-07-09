import {
  type Address,
  type Hex,
  type Authorization,
  type StateOverride,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseEther,
  recoverMessageAddress,
} from "viem";
import { type Call, type SignedAuthorization } from "../types/index";
import { getPublicClient, getRelayerAddress } from "./clients";
import { config } from "../config";
import { gasFlowDelegatorAbi } from "../contracts/abis";
import { withRetry } from "../utils/retry";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";

export const PLACEHOLDER_SIG = ("0x" + "00".repeat(65)) as Hex;
const SIMULATION_BALANCE = parseEther("1000");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Simulation timeout")),
        ms,
      ),
    ),
  ]);
}

export interface SimulationResult {
  success: boolean;
  gasEstimate: bigint;
  error?: string;
}

export async function simulateTransaction(
  user: Address,
  calls: Call[],
  feeToken: Address,
  maxFeeAmount: bigint,
  authGasOverhead: bigint,
  deadline: bigint,
  signature: Hex,
  authorization?: SignedAuthorization,
  stateOverride?: StateOverride,
): Promise<SimulationResult> {
  const publicClient = getPublicClient();
  const relayer = getRelayerAddress();

  const totalCallValue = calls.reduce((sum, call) => sum + call.value, 0n);

  const data = encodeFunctionData({
    abi: gasFlowDelegatorAbi,
    functionName: "execute",
    args: [
      calls,
      signature,
      feeToken,
      maxFeeAmount,
      authGasOverhead,
      deadline,
    ],
  });

  const authorizationList = authorization
    ? [
        {
          address: authorization.contractAddress,
          chainId: authorization.chainId,
          nonce: authorization.nonce,
          r: authorization.r,
          s: authorization.s,
          yParity: authorization.yParity,
        } satisfies Authorization,
      ]
    : undefined;

  // eth_call / eth_estimateGas 中 tx.gasprice 默认是 0，
  // 合约用 tx.gasprice 计算 fee，必须传入当前网络 gas price
  let maxFeePerGas: bigint;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas ?? 0n;
  } catch {
    maxFeePerGas = await publicClient.getGasPrice();
  }

  const simulationStateOverride = stateOverride ?? [
    { address: user, balance: SIMULATION_BALANCE },
  ];

  try {
    logger.info("Simulating tx", {
      user,
      feeToken,
      maxFeeAmount: maxFeeAmount.toString(),
      authGasOverhead: authGasOverhead.toString(),
      hasAuth: !!authorization,
      maxFeePerGas: maxFeePerGas.toString(),
      totalCallValue: totalCallValue.toString(),
    });
    await withRetry(
      () =>
        withTimeout(
            publicClient.call({
              to: user,
              data,
              value: totalCallValue,
              maxFeePerGas,
              authorizationList,
              account: relayer,
              stateOverride: simulationStateOverride,
            }),
          config.simulationTimeoutMs,
        ),
      { retries: 2 },
    );
    const gas = await withRetry(
      () =>
        withTimeout(
          publicClient.estimateGas({
            to: user,
            data,
            value: totalCallValue,
            maxFeePerGas,
            authorizationList,
            account: relayer,
            stateOverride: simulationStateOverride,
          }),
          config.simulationTimeoutMs,
        ),
      { retries: 2 },
    );
    metrics.recordSimulate(true);
    return { success: true, gasEstimate: gas };
  } catch (error) {
    const err = error as Error & Record<string, unknown>;
    const shortMsg = (err.shortMessage as string) ?? "";

    let rawRevertData = "";
    let current = err as Record<string, unknown> | undefined;
    while (current) {
      if (typeof current.data === "string" && current.data.startsWith("0x") && current.data.length > 10) {
        rawRevertData = current.data as string;
        break;
      }
      current = current.cause as Record<string, unknown> | undefined;
    }

    const metaMessages = (err.metaMessages as string[]) ?? [];
    const metaRevertLine = metaMessages.find(m => m.startsWith("Revert reason:") || m.startsWith("0x"));

    const errorMsg = error instanceof Error ? error.message : String(error);

    logger.warn("Simulation failed", {
      user,
      feeToken,
      error: errorMsg,
      shortMessage: shortMsg || undefined,
      metaMessages: metaMessages.length > 0 ? metaMessages : undefined,
      rawRevertData: rawRevertData || undefined,
      metaRevertLine: metaRevertLine || undefined,
    });

    const diagnostics = [
      metaRevertLine ? `Meta: ${metaRevertLine}` : "",
      rawRevertData ? `Raw data: ${rawRevertData}` : "",
    ].filter(Boolean).join("\n");

    const fullError = diagnostics
      ? `${errorMsg}\n${diagnostics}`
      : errorMsg;

    return {
      success: false,
      gasEstimate: 0n,
      error: fullError,
    };
  }
}

function hashBatch(
  chainId: number,
  nonce: bigint,
  calls: Call[],
  feeToken: Address,
  maxFeeAmount: bigint,
  authGasOverhead: bigint,
  deadline: bigint,
): Hex {
  return keccak256(
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
      [BigInt(chainId), nonce, calls, feeToken, maxFeeAmount, authGasOverhead, deadline],
    ),
  );
}

export async function verifySignature(
  user: Address,
  calls: Call[],
  nonce: bigint,
  feeToken: Address,
  maxFeeAmount: bigint,
  authGasOverhead: bigint,
  deadline: bigint,
  signature: Hex,
): Promise<boolean> {
  const digest = hashBatch(config.chainId, nonce, calls, feeToken, maxFeeAmount, authGasOverhead, deadline);
  const recovered = await recoverMessageAddress({
    message: { raw: digest },
    signature,
  });
  return recovered.toLowerCase() === user.toLowerCase();
}

const FALLBACK_GAS_ESTIMATE = 300_000n;

export async function estimateGas(
  user: Address,
  calls: Call[],
  feeToken: Address,
): Promise<bigint> {
  const publicClient = getPublicClient();

  const data = encodeFunctionData({
    abi: gasFlowDelegatorAbi,
    functionName: "execute",
    args: [
      calls,
      PLACEHOLDER_SIG,
      feeToken,
      0n,
      0n,
      BigInt(Math.floor(Date.now() / 1000) + 900),
    ],
  });

  try {
    return await publicClient.estimateGas({
      to: user,
      data,
    });
  } catch (error) {
    logger.warn("estimateGas reverted, using fallback", {
      user,
      error: error instanceof Error ? error.message : String(error),
    });
    return FALLBACK_GAS_ESTIMATE;
  }
}
