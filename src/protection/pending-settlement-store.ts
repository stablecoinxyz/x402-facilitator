/**
 * Pending EVM settlements: what this process broadcast but could not confirm.
 *
 * When `/settle` broadcasts and the receipt wait fails, it answers
 * `settlement_pending` with the hash. Upstream's resource-server middleware
 * then retries `/settle` once with the identical payload. Without a record,
 * that retry re-verifies from scratch, finds the nonce our own transaction
 * consumed, and answers "failed" with no hash for a payment that landed.
 *
 * The record lets the retry reconcile against the transaction WE broadcast.
 * Design and the ordering it depends on:
 * `docs/fixes/permit2-settled-retry-answers-failed.md` §4 Option A (v5).
 *
 * In memory: a retry after a restart, on another machine, or after the TTL
 * finds nothing (same limit as upstream's default store). Route code depends
 * only on the interface so a shared store can replace this one (§4 Option B).
 */
import { keccak256, encodeAbiParameters } from 'viem';

/** Upstream's default (`core/src/facilitator/pendingSettlementStore.ts`). */
export const PENDING_SETTLEMENT_TTL_MS = 5 * 60 * 1000;

export type PendingSettlement = { hash: `0x${string}`; expiresAt: number };

export interface PendingSettlementStore {
  get(key: string): Promise<PendingSettlement | undefined>;
  /** Stores `value` as given. A re-set passes the ORIGINAL `expiresAt`, so a retry never extends the window. */
  set(key: string, value: PendingSettlement): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryPendingSettlementStore implements PendingSettlementStore {
  private readonly entries = new Map<string, PendingSettlement>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    return entry;
  }
  async set(key: string, value: PendingSettlement) {
    if (value.expiresAt <= this.now()) { this.entries.delete(key); return; }
    this.entries.set(key, value);
  }
  async delete(key: string) { this.entries.delete(key); }
  clear() { this.entries.clear(); }
}

let store: PendingSettlementStore = new InMemoryPendingSettlementStore();

export function pendingSettlements(): PendingSettlementStore { return store; }

/** Swap the store (tests; a future shared store). Returns the previous one. */
export function setPendingSettlementStore(next: PendingSettlementStore): PendingSettlementStore {
  const previous = store;
  store = next;
  return previous;
}

/**
 * Record key: the exact transaction we would broadcast — chain, contract, calldata.
 *
 * The calldata ABI-encodes every signed field and the signature (and, for
 * `settleWithPermit`, the sponsor tuple), so two payloads share a key only if
 * they would produce byte-identical transactions. It is NEVER the signature
 * alone: a pending transaction's signature is public, and the same signature
 * on a different message whose `from` is whatever it recovers to would hit a
 * signature-only key and be answered with our hash.
 */
export function pendingSettlementKey(chainId: number, to: `0x${string}`, calldata: `0x${string}`): string {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes' }], [BigInt(chainId), to, calldata]));
}
