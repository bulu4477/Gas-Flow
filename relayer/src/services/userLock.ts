import type { Address } from "viem";

const locks = new Map<Address, Promise<void>>();

export async function acquireUserLock(user: Address): Promise<() => void> {
  const prevLock = locks.get(user);

  let releaseMyLock!: () => void;
  const myLock = new Promise<void>((resolve) => {
    releaseMyLock = resolve;
  });

  locks.set(user, myLock);

  if (prevLock) {
    await prevLock;
  }

  return releaseMyLock;
}
