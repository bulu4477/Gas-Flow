import { formatEther } from "viem";
import { getPublicClient, getRelayerAddress } from "./clients";
import { config } from "../config";
import { logger } from "../utils/logger";

export async function checkRelayerBalance(): Promise<bigint> {
  const publicClient = getPublicClient();
  const relayer = getRelayerAddress();

  const balance = await publicClient.getBalance({ address: relayer });

  if (balance < config.minRelayerBalance) {
    logger.warn("Relayer ETH balance low", {
      relayer,
      balance: formatEther(balance),
      threshold: formatEther(config.minRelayerBalance),
    });
  }

  return balance;
}

export function startBalanceMonitor(intervalMs = 60_000): NodeJS.Timeout {
  logger.info("Balance monitor started", { intervalSeconds: intervalMs / 1000 });

  checkRelayerBalance().catch((error) => {
    logger.error("Initial balance check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return setInterval(() => {
    checkRelayerBalance().catch((error) => {
      logger.error("Balance check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
}
