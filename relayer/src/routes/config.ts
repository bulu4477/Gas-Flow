import { readConfig } from "../services/clients";
import { config } from "../config";
import type { ConfigResponse } from "../types/index";

export async function handleConfig(): Promise<ConfigResponse> {
  const [minFeeRateBps, l1FeeBps] = await Promise.all([
    readConfig.minFeeRateBps(),
    readConfig.l1FeeBps(),
  ]);
  return {
    chainId: config.chainId,
    delegatorAddress: config.delegatorAddress,
    configAddress: config.configAddress,
    stakePoolAddress: config.stakePoolAddress,
    supportedFeeTokens: config.supportedFeeTokens,
    minFeeRateBps,
    l1FeeBps,
  };
}
