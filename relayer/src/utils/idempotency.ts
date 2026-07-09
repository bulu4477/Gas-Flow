import type { Hash } from "viem";
import { IDEMPOTENCY_CACHE_TTL_MS } from "./constants";

interface CachedResult {
  txHash: Hash;
  timestamp: number;
}

class IdempotencyCache {
  private cache = new Map<string, CachedResult>();

  get(key: string): CachedResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > IDEMPOTENCY_CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  set(key: string, txHash: Hash): void {
    this.cache.set(key, { txHash, timestamp: Date.now() });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > IDEMPOTENCY_CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}

export const idempotencyCache = new IdempotencyCache();
