import { isAddress, isHex, type Address, type Hex } from "viem";
import type { EstimateRequest, SubmitRequest, SignedAuthorization } from "../types/index";
import { config } from "../config";

export class ValidationError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

function validateAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ValidationError(`Invalid '${field}'`);
  }
  return value;
}

function validateHex(value: unknown, field: string, expectedByteLength?: number): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length % 2 !== 0) {
    throw new ValidationError(`Invalid '${field}'`);
  }
  if (expectedByteLength !== undefined && (value.length - 2) / 2 !== expectedByteLength) {
    throw new ValidationError(`Invalid '${field}' length`);
  }
  return value;
}

export function validateAuthorization(auth: Record<string, unknown>): SignedAuthorization {
  const contractAddress = validateAddress(auth.contractAddress, "authorization.contractAddress");
  if (contractAddress.toLowerCase() !== config.delegatorAddress.toLowerCase()) {
    throw new ValidationError("authorization.contractAddress must be GasFlowDelegator");
  }
  if (typeof auth.chainId !== "number" && typeof auth.chainId !== "string") {
    throw new ValidationError("authorization.chainId is required");
  }
  const chainId = Number(auth.chainId);
  if (chainId !== config.chainId) {
    throw new ValidationError(`authorization.chainId must be ${config.chainId}`);
  }
  if (typeof auth.nonce !== "number" && typeof auth.nonce !== "string") {
    throw new ValidationError("authorization.nonce must be a number");
  }
  const nonce = Number(auth.nonce);
  if (nonce < 0 || !Number.isInteger(nonce)) {
    throw new ValidationError("authorization.nonce must be a non-negative integer");
  }
  if (typeof auth.yParity !== "number" || ![0, 1].includes(auth.yParity)) {
    throw new ValidationError("authorization.yParity must be 0 or 1");
  }
  const r = validateHex(auth.r, "authorization.r", 32);
  const s = validateHex(auth.s, "authorization.s", 32);
  return { contractAddress, chainId, nonce, yParity: auth.yParity, r, s };
}

function validateCalls(raw: unknown): { to: Address; value: bigint; data: Hex }[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError("'calls' must be a non-empty array");
  }
  if (raw.length > config.maxBatchSize) {
    throw new ValidationError(`Batch size ${raw.length} exceeds ${config.maxBatchSize}`);
  }
  return raw.map((call, i) => {
    if (!call || typeof call !== "object") {
      throw new ValidationError(`call[${i}]: must be an object`);
    }
    const c = call as Record<string, unknown>;
    const to = validateAddress(c.to, `call[${i}].to`);
    const data = validateHex(c.data, `call[${i}].data`);
    const value = c.value !== undefined ? BigInt(c.value as string) : 0n;
    return { to, value, data };
  });
}

export function validateEstimateRequest(body: unknown): EstimateRequest {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be a JSON object");
  }
  const req = body as Record<string, unknown>;
  const user = validateAddress(req.user, "user");
  const calls = validateCalls(req.calls);
  const feeToken = validateAddress(req.feeToken, "feeToken");

  const result: EstimateRequest = { user, calls, feeToken };

  if (req.signature !== undefined) {
    result.signature = validateHex(req.signature, "signature", 65);
  }

  if (req.authorization !== undefined) {
    if (typeof req.authorization !== "object") {
      throw new ValidationError("'authorization' must be an object");
    }
    result.authorization = validateAuthorization(req.authorization as Record<string, unknown>);
  }

  return result;
}

export function validateSubmitRequest(body: unknown): SubmitRequest {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be a JSON object");
  }
  const req = body as Record<string, unknown>;

  const user = validateAddress(req.user, "user");
  const calls = validateCalls(req.calls);

  if (typeof req.nonce !== "number" && typeof req.nonce !== "string") {
    throw new ValidationError("'nonce' is required");
  }
  const nonce = BigInt(req.nonce as string);
  if (nonce < 0n) {
    throw new ValidationError("'nonce' must be non-negative");
  }

  const signature = validateHex(req.signature, "signature");
  const feeToken = validateAddress(req.feeToken, "feeToken");

  if (req.maxFeeAmount === undefined || BigInt(req.maxFeeAmount as string) <= 0n) {
    throw new ValidationError("'maxFeeAmount' must be positive");
  }

  const authGasOverhead = req.authGasOverhead !== undefined ? BigInt(req.authGasOverhead as string) : 0n;
  if (authGasOverhead < 0n) {
    throw new ValidationError("'authGasOverhead' must be non-negative");
  }

  if (typeof req.deadline !== "number" && typeof req.deadline !== "string") {
    throw new ValidationError("'deadline' is required");
  }
  const deadline = BigInt(req.deadline as string);
  if (deadline < BigInt(Math.floor(Date.now() / 1000))) {
    throw new ValidationError("'deadline' has expired");
  }

  let authorization: SignedAuthorization | undefined;
  if (req.authorization) {
    if (typeof req.authorization !== "object") {
      throw new ValidationError("'authorization' must be an object");
    }
    authorization = validateAuthorization(req.authorization as Record<string, unknown>);
  }


  return {
    user,
    calls,
    nonce,
    signature,
    feeToken,
    maxFeeAmount: BigInt(req.maxFeeAmount as string),
    authGasOverhead,
    deadline,
    authorization,
  };
}
