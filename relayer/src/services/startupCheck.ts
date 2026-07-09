import { keccak256, type Address, type Hex } from "viem";
import { config } from "../config";
import {
  readConfig,
  readChainlinkPrice,
  getDelegatorRuntimeBytecode,
  getRelayerAddress,
} from "./clients";
import { logger } from "../utils/logger";

const ZERO_ADDRESS: Address =
  "0x0000000000000000000000000000000000000000";

export async function runStartupChecks(): Promise<void> {
  if (config.configAddress === ZERO_ADDRESS) {
    throw new Error("config-address: config address is zero");
  }
  logger.info("config-address check passed");

  const onchainStakePool = await readConfig.stakePool();
  if (onchainStakePool === ZERO_ADDRESS) {
    logger.warn("stake-pool: on-chain stakePool address is zero");
  } else {
    logger.info("stake-pool check passed");
  }

  const stalenessThreshold = Number(await readConfig.STALENESS_THRESHOLD());
  const now = BigInt(Math.floor(Date.now() / 1000));

  for (const token of config.supportedFeeTokens) {
    const feeds = await readConfig.priceFeeds(token);

    if (feeds.ethUsdFeed === ZERO_ADDRESS || feeds.tokenUsdFeed === ZERO_ADDRESS) {
      logger.warn("price-feeds: token has missing feed", {
        token,
        ethUsdFeed: feeds.ethUsdFeed,
        tokenUsdFeed: feeds.tokenUsdFeed,
      });
    } else {
      logger.info("price-feeds check passed", { token });

      const ethFeed = await readChainlinkPrice(feeds.ethUsdFeed);
      if (now - ethFeed.updatedAt > stalenessThreshold) {
        logger.warn("stale-feed: ethUsdFeed stale", {
          token,
          staleSeconds: Number(now - ethFeed.updatedAt),
        });
      } else {
        logger.info("stale-feed ethUsdFeed passed", { token });
      }

      const tokenFeed = await readChainlinkPrice(feeds.tokenUsdFeed);
      if (now - tokenFeed.updatedAt > stalenessThreshold) {
        logger.warn("stale-feed: tokenUsdFeed stale", {
          token,
          staleSeconds: Number(now - tokenFeed.updatedAt),
        });
      } else {
        logger.info("stale-feed tokenUsdFeed passed", { token });
      }
    }
  }

  const bytecode = await getDelegatorRuntimeBytecode();
  if (!bytecode || bytecode === "0x") {
    throw new Error("delegator-bytecode: delegator bytecode is empty");
  }
  logger.info("delegator-bytecode check passed");

  const designationCode = ("0xef0100" + config.delegatorAddress.slice(2).toLowerCase()) as Hex;
  const codeHash = keccak256(designationCode);
  const expectedHash = await readConfig.delegatorCodeHash();
  if (codeHash !== expectedHash) {
    logger.warn("delegator-code-hash mismatch", {
      expected: expectedHash,
      actual: codeHash,
    });
  } else {
    logger.info("delegator-code-hash check passed");
  }

  const paused = await readConfig.paused();
  if (paused) {
    logger.warn("config-paused: config contract is paused");
  } else {
    logger.info("config-paused check passed");
  }

  const relayerAddr = getRelayerAddress();
  const isWhitelisted = await readConfig.relayers(relayerAddr);
  if (!isWhitelisted) {
    logger.warn("relayer-whitelist: relayer is not whitelisted", {
      relayer: relayerAddr,
    });
  } else {
    logger.info("relayer-whitelist check passed");
  }
}
