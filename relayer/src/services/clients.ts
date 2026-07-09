import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  stringToBytes,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "../config";
import {
  chainlinkAggregatorAbi,
  gasFlowConfigAbi,
} from "../contracts/abis";

let publicClient: PublicClient | null = null;
let walletClient: WalletClient | null = null;

function createTransport() {
  return http(config.rpcUrl, {
    retryCount: 3,
    retryDelay: 1_000,
  });
}

export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: sepolia,
      transport: createTransport(),
    });
  }
  return publicClient;
}

export function getWalletClient(): WalletClient {
  if (!walletClient) {
    walletClient = createWalletClient({
      account: privateKeyToAccount(config.relayerPrivateKey),
      chain: sepolia,
      transport: createTransport(),
    });
  }
  return walletClient;
}

export function getRelayerAddress(): Address {
  const wc = getWalletClient();
  return wc.account!.address;
}

// ── Nonce / delegation helpers ──────────────────────────────────────────

let cachedDelegatorBytecode: Hex | null = null;
const DELEGATOR_NONCE_SLOT = keccak256(stringToBytes("gasflow.delegator.nonce"));

export async function getDelegatorRuntimeBytecode(): Promise<Hex> {
  if (!cachedDelegatorBytecode) {
    cachedDelegatorBytecode = (await getPublicClient().getCode({
      address: config.delegatorAddress,
    })) ?? null;
  }
  return cachedDelegatorBytecode!;
}

export async function getDelegatorNonce(user: Address): Promise<bigint> {
  const value = await getPublicClient().getStorageAt({
    address: user,
    slot: DELEGATOR_NONCE_SLOT,
  });
  return BigInt(value ?? "0x0");
}

export async function checkDelegationStatus(user: Address): Promise<boolean> {
  const code = await getPublicClient().getCode({ address: user });
  if (!code?.startsWith("0xef0100")) return false;
  const delegatedTo = ("0x" + code.slice(8)) as Address;
  return delegatedTo.toLowerCase() === config.delegatorAddress.toLowerCase();
}

// ── On-chain config reads ───────────────────────────────────────────────

export const readConfig = {
  async stakePool(): Promise<Address> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "stakePool",
    })) as Address;
  },

  async minFeeRateBps(): Promise<bigint> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "minFeeRateBps",
    })) as bigint;
  },

  async l1FeeBps(): Promise<bigint> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "l1FeeBps",
    })) as bigint;
  },

  async priceFeeds(token: Address): Promise<{ ethUsdFeed: Address; tokenUsdFeed: Address }> {
    const [ethUsdFeed, tokenUsdFeed] = (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "priceFeeds",
      args: [token],
    })) as [Address, Address];
    return { ethUsdFeed, tokenUsdFeed };
  },

  async feeTokenDecimals(token: Address): Promise<number> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "feeTokenDecimals",
      args: [token],
    })) as number;
  },

  async relayers(addr: Address): Promise<boolean> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "relayers",
      args: [addr],
    })) as boolean;
  },

  async paused(): Promise<boolean> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "paused",
    })) as boolean;
  },

  async delegatorCodeHash(): Promise<`0x${string}`> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "delegatorCodeHash",
    })) as `0x${string}`;
  },

  async STALENESS_THRESHOLD(): Promise<bigint> {
    return (await getPublicClient().readContract({
      address: config.configAddress,
      abi: gasFlowConfigAbi,
      functionName: "STALENESS_THRESHOLD",
    })) as bigint;
  },
};

// ── Price feed helpers ──────────────────────────────────────────────────

export async function readChainlinkPrice(
  feedAddress: Address,
): Promise<{ price: bigint; updatedAt: bigint }> {
  const [, answer, , updatedAt] = (await getPublicClient().readContract({
    address: feedAddress,
    abi: chainlinkAggregatorAbi,
    functionName: "latestRoundData",
  })) as [bigint, bigint, bigint, bigint, bigint];
  return { price: answer, updatedAt };
}

export type { PublicClient, WalletClient };
