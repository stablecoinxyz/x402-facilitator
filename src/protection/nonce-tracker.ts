/**
 * Nonce Replay Protection
 *
 * Tracks settled permit nonces to prevent double-settlement.
 * On-chain the permit nonce is consumed, so a second attempt would revert —
 * but we waste gas submitting it. This layer rejects replays before on-chain submission.
 *
 * Stores the tx hash so retries return the original success response (idempotent).
 *
 * Key: network + lowercase(owner) + nonce
 * Bounded LRU eviction to prevent unbounded memory growth.
 */

export interface SettledRecord {
  txHash: string;
  payer: string;
  network: string;
}

export class NonceTracker {
  private settled: Map<string, SettledRecord>;
  private order: string[];
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.settled = new Map();
    this.order = [];
    this.maxSize = maxSize;
  }

  private key(network: string, owner: string, nonce: string): string {
    return `${network}:${owner.toLowerCase()}:${nonce}`;
  }

  hasSettled(network: string, owner: string, nonce: string): boolean {
    return this.settled.has(this.key(network, owner, nonce));
  }

  /** Get the original settlement record for a previously settled nonce. */
  getSettled(network: string, owner: string, nonce: string): SettledRecord | undefined {
    return this.settled.get(this.key(network, owner, nonce));
  }

  markSettled(network: string, owner: string, nonce: string, record: SettledRecord): void {
    const k = this.key(network, owner, nonce);
    if (this.settled.has(k)) return;

    // Evict oldest if at capacity
    if (this.order.length >= this.maxSize) {
      const oldest = this.order.shift()!;
      this.settled.delete(oldest);
    }

    this.settled.set(k, record);
    this.order.push(k);
  }
}

// Singleton instance shared across requests
export const nonceTracker = new NonceTracker();
