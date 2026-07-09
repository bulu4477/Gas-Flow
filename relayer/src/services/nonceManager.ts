import type { Address, Hash } from "viem";
import { getDelegatorNonce } from "./clients";
import type { UserState } from "../types/index";

class NonceManager {
  private users = new Map<Address, UserState>();

  async getNextNonce(user: Address): Promise<bigint> {
    const onChainNonce = await getDelegatorNonce(user);
    const tracked = this.users.get(user);

    if (!tracked || tracked.lastKnownNonce < onChainNonce) {
      this.users.set(user, {
        address: user,
        lastKnownNonce: onChainNonce - 1n,
        pendingTxHashes: [],
      });
      return onChainNonce;
    }

    return tracked.lastKnownNonce + 1n;
  }

  reserveNonce(user: Address, requestedNonce: bigint): boolean {
    const tracked = this.users.get(user);
    if (!tracked) return false;

    const expected = tracked.lastKnownNonce + 1n;
    if (requestedNonce !== expected) return false;

    tracked.lastKnownNonce = requestedNonce;
    return true;
  }

  releaseNonce(user: Address, nonce: bigint): void {
    const tracked = this.users.get(user);
    if (tracked && tracked.lastKnownNonce === nonce) {
      tracked.lastKnownNonce = nonce - 1n;
    }
  }

  addPending(user: Address, txHash: Hash): void {
    const tracked = this.users.get(user);
    if (tracked) {
      tracked.pendingTxHashes.push(txHash);
    }
  }

  getPending(user: Address): Hash[] {
    return this.users.get(user)?.pendingTxHashes ?? [];
  }

  getPendingCount(): number {
    let count = 0;
    for (const user of this.users.values()) {
      count += user.pendingTxHashes.length;
    }
    return count;
  }
}

export const nonceManager = new NonceManager();
