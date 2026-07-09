import { getPublicClient, getRelayerAddress } from "../services/clients";
import { config } from "../config";
import type { BalanceResponse } from "../types/index";

export async function handleBalance(): Promise<BalanceResponse> {
  const publicClient = getPublicClient();
  const relayerAddress = getRelayerAddress();
  const ethBalance = await publicClient.getBalance({ address: relayerAddress });
  return { relayerAddress, ethBalance, minBalance: config.minRelayerBalance };
}
