import * as dotenv from "dotenv";
import { type Address, parseEther } from "viem";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
}

function requirePrivateKey(key: string): `0x${string}` {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (normalized.length !== 66) {
    throw new Error(`${key} must be 32 bytes (64 hex chars), got ${normalized.length - 2} hex chars`);
  }
  return normalized as `0x${string}`;
}

export const config = {
  relayerPrivateKey: requirePrivateKey("RELAYER_PRIVATE_KEY"),
  rpcUrl: requireEnv("RPC_URL"),
  chainId: Number(requireEnv("CHAIN_ID")),
  port: Number(process.env.PORT || "3000"),

  relayerApiKey: process.env.RELAYER_API_KEY,
  maxBodySize: Number(process.env.MAX_BODY_SIZE || "1048576"),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS || "100"),

  minRelayerBalance: BigInt(
    process.env.MIN_RELAYER_BALANCE || parseEther("0.1").toString(),
  ),
  maxFeePerGasMultiplier: Number(
    process.env.MAX_FEE_PER_GAS_MULTIPLIER || "3",
  ),
  priorityFee: BigInt(process.env.PRIORITY_FEE || "1000000000"),

  maxBatchSize: Number(process.env.MAX_BATCH_SIZE || "10"),
  simulationTimeoutMs: Number(process.env.SIMULATION_TIMEOUT_MS || "30000"),

  delegatorAddress: requireEnv("DELEGATOR_CONTRACT_ADDRESS") as Address,
  configAddress: requireEnv("CONFIG_CONTRACT_ADDRESS") as Address,
  stakePoolAddress: requireEnv("STAKE_POOL_ADDRESS") as Address,

  supportedFeeTokens: requireEnv("SUPPORTED_FEE_TOKENS")
    .split(",")
    .map(t => t.trim()) as Address[],

  gasEstimateMarginBps: BigInt(
    process.env.GAS_ESTIMATE_MARGIN_BPS || "12000",
  ), // 20% safety margin
  feeAmountMarginBps: BigInt(
    process.env.FEE_AMOUNT_MARGIN_BPS || "11000",
  ), // 10% buffer for price staleness
} as const;
