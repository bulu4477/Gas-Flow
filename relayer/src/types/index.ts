import { type Address, type Hash, type Hex } from "viem";

/** A single call in a batch, mirroring the Solidity Call struct */
export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** EIP-7702 signed authorization tuple (for initial delegation or switching) */
export interface SignedAuthorization {
  contractAddress: Address;
  chainId: number;
  nonce: number;
  yParity: number;
  r: Hex;
  s: Hex;
}

/** Request body for POST /api/v1/submit */
export interface SubmitRequest {
  user: Address;
  calls: Call[];
  nonce: bigint; // Delegator nonce used when signing the digest
  signature: Hex; // ECDSA signature over (chainId, nonce, calls) digest
  feeToken: Address; // ERC-20 fee token address
  maxFeeAmount: bigint; // Max fee the user authorizes (direct transfer, no permit)
  authGasOverhead: bigint; // EIP-7702 auth gas cost (0 if already delegated)
  deadline: bigint; // Signature expiration timestamp
  authorization?: SignedAuthorization; // Present only for initial delegation / switching
}

/** Request for POST /api/v1/estimate */
export interface EstimateRequest {
  user: Address;
  calls: Call[];
  feeToken: Address;
  /** Real batch signature for accurate gas simulation. If omitted, falls back to placeholder estimate. */
  signature?: Hex;
  /** EIP-7702 authorization tuple; only used if the relayer needs to simulate with auth. */
  authorization?: SignedAuthorization;
}

/** Response from POST /api/v1/estimate */
export interface EstimateResponse {
  nonce: bigint;
  gasEstimate: bigint;
  authGasOverhead: bigint;
  maxFeeAmount: bigint;
  feeToken: Address;
  feeTokenDecimals: number;
  configAddress: Address;
  deadline: bigint;
  relayerAddress: Address;
  rawDigest: Hex;
  ethSignedDigest: Hex;
}

/** Response from GET /api/v1/status/:txHash */
export interface StatusResponse {
  status: "pending" | "confirmed" | "failed";
  blockNumber?: bigint;
  gasUsed?: bigint;
  error?: string;
  batchExecuted?: Array<{
    nonce?: string;
    relayer?: string;
    gasUsed?: string;
    ethCompensation?: string;
    l1Fee?: string;
  }>;
  feeCollected?: Array<{
    token?: string;
    feeAmount?: string;
    ethCompensation?: string;
  }>;
}

/** Response from GET /api/v1/config */
export interface ConfigResponse {
  chainId: number;
  delegatorAddress: Address;
  configAddress: Address;
  stakePoolAddress: Address;
  supportedFeeTokens: Address[];
  minFeeRateBps: bigint;
  l1FeeBps: bigint;
}

/** Response from GET /api/v1/balance */
export interface BalanceResponse {
  relayerAddress: Address;
  ethBalance: bigint;
  minBalance: bigint;
}

/** Tracked state for a user's pending transactions */
export interface UserState {
  address: Address;
  lastKnownNonce: bigint;
  pendingTxHashes: Hash[];
}
