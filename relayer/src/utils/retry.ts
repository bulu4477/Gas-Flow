import { logger } from "./logger";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_RETRYABLE_PATTERNS = [
  "timeout",
  "timed out",
  "network error",
  "econnreset",
  "econnrefused",
  "unexpected end",
  "invalid json",
  "rate limit",
  "too many requests",
  "-32000",
  "-32001",
  "-32002",
  "-32003",
];

export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return DEFAULT_RETRYABLE_PATTERNS.some((pattern) => message.includes(pattern));
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 8_000,
    shouldRetry = isRetryableError,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === retries || !shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      logger.warn("Retrying after error", {
        attempt: attempt + 1,
        maxAttempts: retries + 1,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
