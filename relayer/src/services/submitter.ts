import {
  encodeFunctionData,
  type Authorization,
  type Hash,
} from "viem";
import { sepolia } from "viem/chains";
import type { SubmitRequest } from "../types/index";
import { getWalletClient, getPublicClient, getRelayerAddress } from "./clients";
import { config } from "../config";
import { gasFlowDelegatorAbi } from "../contracts/abis";
import { logger } from "../utils/logger";
import { BPS_DIVISOR } from "../utils/constants";

if (config.chainId !== sepolia.id) {
  throw new Error(`Configured chainId ${config.chainId} does not match sepolia (${sepolia.id})`);
}

export async function submitTransaction(
  request: SubmitRequest,
  gasEstimate: bigint,
): Promise<{ txHash: Hash; gasEstimate: bigint }> {
  const walletClient = getWalletClient();
  const publicClient = getPublicClient();

  const data = encodeFunctionData({
    abi: gasFlowDelegatorAbi,
    functionName: "execute",
    args: [
      request.calls,
      request.signature,
      request.feeToken,
      request.maxFeeAmount,
      request.authGasOverhead,
      request.deadline,
    ],
  });

  const gasLimit = (gasEstimate * config.gasEstimateMarginBps) / BPS_DIVISOR;

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;

  try {
    const fees = await publicClient.estimateFeesPerGas();
    const multiplierBps = BigInt(Math.round(config.maxFeePerGasMultiplier * 100));
    maxFeePerGas = (fees.maxFeePerGas! * multiplierBps) / 100n;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas!;
  } catch {
    const gasPrice = await publicClient.getGasPrice();
    const multiplierBps = BigInt(Math.round(config.maxFeePerGasMultiplier * 100));
    maxFeePerGas = (gasPrice * multiplierBps) / 100n;
    maxPriorityFeePerGas = gasPrice;
  }

  const relayerAddress = getRelayerAddress();
  const relayerBalance = await publicClient.getBalance({ address: relayerAddress });
  const totalCallValue = request.calls.reduce(
    (sum, call) => sum + call.value,
    0n,
  );
  const estimatedCost = gasLimit * maxFeePerGas * 2n + totalCallValue;
  if (relayerBalance < estimatedCost) {
    throw Object.assign(
      new Error("Insufficient relayer balance"),
      { statusCode: 503 },
    );
  }

  const authorizationList = request.authorization
    ? [
        {
          address: request.authorization.contractAddress,
          chainId: request.authorization.chainId,
          nonce: request.authorization.nonce,
          r: request.authorization.r,
          s: request.authorization.s,
          yParity: request.authorization.yParity,
        } satisfies Authorization,
      ]
    : undefined;

  const txParams = {
    chain: sepolia,
    to: request.user,
    data,
    value: totalCallValue,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    account: walletClient.account!,
    authorizationList,
  };

  logger.info("Submitting transaction", {
    user: request.user,
    relayer: relayerAddress,
    nonce: request.nonce.toString(),
    gasLimit: gasLimit.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    totalCallValue: totalCallValue.toString(),
  });

  const txHash = await walletClient.sendTransaction(txParams);

  logger.info("Transaction submitted", {
    user: request.user,
    txHash,
    relayer: relayerAddress,
  });

  return { txHash, gasEstimate };
}
