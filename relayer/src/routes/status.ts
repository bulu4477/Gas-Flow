import { type Hash, parseAbi, parseEventLogs } from "viem";
import { getPublicClient } from "../services/clients";
import { metrics } from "../utils/metrics";
import { logger } from "../utils/logger";
import type { StatusResponse } from "../types/index";

const batchExecutedAbi = parseAbi([
  "event BatchExecuted(uint256 indexed nonce, address indexed relayer, uint256 gasUsed, uint256 ethCompensation, uint256 l1Fee)",
]);

const feeCollectedAbi = parseAbi([
  "event FeeCollected(address indexed token, uint256 feeAmount, uint256 ethCompensation)",
]);

export async function handleStatus(txHash: Hash): Promise<StatusResponse> {
  const publicClient = getPublicClient();
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt) {
      if (receipt.status === "success") {
        metrics.recordGasUsed(receipt.gasUsed);
      }

      const batchExecuted = parseEventLogs({
        abi: batchExecutedAbi,
        eventName: "BatchExecuted",
        logs: receipt.logs,
      });
      const feeCollected = parseEventLogs({
        abi: feeCollectedAbi,
        eventName: "FeeCollected",
        logs: receipt.logs,
      });

      return {
        status: receipt.status === "success" ? "confirmed" : "failed",
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        batchExecuted: batchExecuted.map((log) => ({
          nonce: log.args.nonce?.toString(),
          relayer: log.args.relayer,
          gasUsed: log.args.gasUsed?.toString(),
          ethCompensation: log.args.ethCompensation?.toString(),
          l1Fee: log.args.l1Fee?.toString(),
        })),
        feeCollected: feeCollected.map((log) => ({
          token: log.args.token,
          feeAmount: log.args.feeAmount?.toString(),
          ethCompensation: log.args.ethCompensation?.toString(),
        })),
      };
    }
    return { status: "pending" };
  } catch (error) {
    logger.error("Status lookup failed", {
      txHash,
      error: error instanceof Error ? error.message : String(error),
    });
    throw Object.assign(new Error("Transaction not found"), { statusCode: 404 });
  }
}
