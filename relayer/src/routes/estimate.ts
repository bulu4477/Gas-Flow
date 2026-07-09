import { validateEstimateRequest } from "../services/validator";
import { estimateFee } from "../services/feeEstimator";
import { logger } from "../utils/logger";
import type { EstimateRequest, EstimateResponse } from "../types/index";

export async function handleEstimate(body: unknown): Promise<EstimateResponse> {
  const request = validateEstimateRequest(body) as EstimateRequest;
  try {
    return await estimateFee(
      request.user,
      request.calls,
      request.feeToken,
      request.signature,
      request.authorization,
    );
  } catch (err: any) {
    logger.error("Estimate failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (err.statusCode) throw err;
    throw Object.assign(
      new Error(`Internal estimate error: ${err instanceof Error ? err.message : String(err)}`),
      { statusCode: 500 },
    );
  }
}
