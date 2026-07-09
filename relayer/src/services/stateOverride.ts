import {
  numberToHex,
  type Address,
  type Hex,
  type StateOverride,
} from "viem";
import { getDelegatorRuntimeBytecode } from "./clients";

let cachedBytecode: Hex | null = null;

/**
 * Fetches and caches the Delegator contract runtime bytecode.
 * The runtime bytecode (from eth_getCode) is what eth_call state override
 * needs — NOT the 23-byte EIP-7702 delegation designation (0xef0100 || addr).
 */
export async function getDelegatorBytecode(): Promise<Hex> {
  if (cachedBytecode) return cachedBytecode;
  cachedBytecode = await getDelegatorRuntimeBytecode();
  return cachedBytecode;
}

/**
 * Builds a viem StateOverride array for eth_call simulation of an EIP-7702
 * delegated EOA.
 *
 * viem 2.x StateOverride is an array of per-address entries:
 *   [{ address, code, stateDiff?, balance? }]
 * NOT a `Record<Address, { code, stateDiff? }>` as in earlier versions.
 *
 * @param user              – The EOA address being overridden.
 * @param delegatorBytecode – The full Delegator runtime bytecode.
 * @param nonce             – Optional. Current nonce of the EOA to set in
 *                            storage slot 0x0 so the Delegator nonce()
 *                            view returns the correct value.
 * @param balance           – Optional. ETH balance to assign to the EOA for
 *                            simulations that include ETH transfers.
 * @returns A viem StateOverride array.
 *
 * IMPORTANT: nonce === 0n is valid — the check is against `undefined`.
 */
export function buildStateOverride(
  user: Address,
  delegatorBytecode: Hex,
  nonce?: bigint,
  balance?: bigint,
): StateOverride {
  type Entry = { address: Address; code: Hex; balance?: bigint };
  const entry: Entry = { address: user, code: delegatorBytecode };
  if (balance !== undefined) {
    entry.balance = balance;
  }
  if (nonce === undefined) {
    return [entry];
  }

  return [
    {
      ...entry,
      stateDiff: [
        {
          slot: "0x0000000000000000000000000000000000000000000000000000000000000000",
          value: numberToHex(nonce, { size: 32 }),
        },
      ],
    },
  ];
}
