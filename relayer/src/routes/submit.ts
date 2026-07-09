import { keccak256, type Hash } from "viem";
import { validateSubmitRequest } from "../services/validator";
import { acquireUserLock } from "../services/userLock";
import { checkDelegationStatus, getRelayerAddress, readConfig } from "../services/clients";
import { verifySignature, simulateTransaction } from "../services/simulator";
import { submitTransaction } from "../services/submitter";
import { nonceManager } from "../services/nonceManager";
import { idempotencyCache } from "../utils/idempotency";
import { logger } from "../utils/logger";
import type { SubmitRequest } from "../types/index";

function getIdempotencyKey(signature: Hash): string {
  return keccak256(signature);
}

export async function handleSubmit(
  body: unknown,
): Promise<{ txHash: Hash; gasEstimate: bigint }> {
  const request: SubmitRequest = validateSubmitRequest(body);

  const idempotencyKey = getIdempotencyKey(request.signature);
  const cached = idempotencyCache.get(idempotencyKey);
  if (cached) {
    logger.info("Returning cached submit result", {
      user: request.user,
      txHash: cached.txHash,
    });
    return { txHash: cached.txHash, gasEstimate: 0n };
  }

  const release = await acquireUserLock(request.user);
  try {
    logger.info("Submit: checking delegation status", { user: request.user });
    const isDelegated = await checkDelegationStatus(request.user);

    if (!isDelegated && !request.authorization) {
      throw Object.assign(
        new Error("EOA not delegated and no authorization provided"),
        { statusCode: 400 },
      );
    }
    logger.info("Submit: delegation check passed", { user: request.user, isDelegated });

    const relayerAddress = getRelayerAddress();
    logger.info("Submit: checking relayer whitelist", { relayer: relayerAddress });
    const isRelayerWhitelisted = await readConfig.relayers(relayerAddress);
    if (!isRelayerWhitelisted) {
      throw Object.assign(
        new Error("Relayer is not whitelisted"),
        { statusCode: 403 },
      );
    }

    logger.info("Submit: checking paused");
    const paused = await readConfig.paused();
    if (paused) {
      throw Object.assign(
        new Error("GasFlowConfig is paused"),
        { statusCode: 503 },
      );
    }

    logger.info("Submit: getting nonce", { user: request.user, requestNonce: request.nonce.toString() });
    const expectedNonce = await nonceManager.getNextNonce(request.user);
    if (request.nonce !== expectedNonce) {
      throw Object.assign(
        new Error(`Invalid nonce: expected ${expectedNonce}, got ${request.nonce}`),
        { statusCode: 409 },
      );
    }

    if (!nonceManager.reserveNonce(request.user, request.nonce)) {
      throw Object.assign(
        new Error("Nonce already reserved"),
        { statusCode: 409 },
      );
    }
    logger.info("Submit: nonce reserved", { user: request.user, nonce: request.nonce.toString() });

    logger.info("Submit: verifying signature");
    const sigValid = await verifySignature(
      request.user,
      request.calls,
      request.nonce,
      request.feeToken,
      request.maxFeeAmount,
      request.authGasOverhead,
      request.deadline,
      request.signature,
    );
    if (!sigValid) {
      nonceManager.releaseNonce(request.user, request.nonce);
      throw Object.assign(
        new Error("Invalid signature"),
        { statusCode: 401 },
      );
    }
    logger.info("Submit: signature verified");

    logger.info("Submit: simulating transaction");
    const sim = await simulateTransaction(
      request.user,
      request.calls,
      request.feeToken,
      request.maxFeeAmount,
      request.authGasOverhead,
      request.deadline,
      request.signature,
      request.authorization,
    );
    if (!sim.success) {
      logger.warn("Submit: simulation failed", { user: request.user, error: sim.error });
      nonceManager.releaseNonce(request.user, request.nonce);
      throw Object.assign(
        new Error(`Simulation failed: ${sim.error}`),
        { statusCode: 422 },
      );
    }
    logger.info("Submit: simulation passed", { gasEstimate: sim.gasEstimate.toString() });

    logger.info("Submit: sending transaction");
    try {
      const result = await submitTransaction(request, sim.gasEstimate);
      nonceManager.addPending(request.user, result.txHash);
      idempotencyCache.set(idempotencyKey, result.txHash);
      logger.info("Submit: transaction sent", { txHash: result.txHash });
      return result;
    } catch (error) {
      logger.error("Submit: send failed", {
        user: request.user,
        error: error instanceof Error ? error.message : String(error),
      });
      nonceManager.releaseNonce(request.user, request.nonce);
      throw error;
    }
  } finally {
    release();
  }
}
