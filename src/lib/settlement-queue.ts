/**
 * Per-EOA Settlement Queue
 *
 * Serializes on-chain settlement execution per facilitator wallet address.
 * Prevents nonce collisions when multiple /settle requests arrive concurrently.
 *
 * Each facilitator wallet (identified by private key → address) gets its own
 * FIFO queue. Concurrent requests wait in line instead of racing for the same nonce.
 *
 * This is critical for chains without a mempool (e.g. Radius) where nonce N+1
 * cannot sit waiting for nonce N to confirm — it simply fails immediately.
 */

type QueuedTask<T> = {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
};

class EOAQueue {
  private queue: QueuedTask<any>[] = [];
  private running = false;

  async enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ execute, resolve, reject });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        const result = await task.execute();
        task.resolve(result);
      } catch (error) {
        task.reject(error);
      }
    }

    this.running = false;
  }

  get pending(): number {
    return this.queue.length;
  }
}

/**
 * Global settlement queue registry.
 * One queue per facilitator wallet address (lowercase).
 */
class SettlementQueue {
  private queues = new Map<string, EOAQueue>();

  private getQueue(walletAddress: string): EOAQueue {
    const key = walletAddress.toLowerCase();
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new EOAQueue();
      this.queues.set(key, queue);
    }
    return queue;
  }

  /**
   * Enqueue a settlement task for a specific facilitator wallet.
   * The task will execute only when all prior tasks for the same wallet have completed.
   */
  async enqueue<T>(walletAddress: string, execute: () => Promise<T>): Promise<T> {
    return this.getQueue(walletAddress).enqueue(execute);
  }

  /**
   * Get the number of pending tasks for a wallet (for logging/metrics).
   */
  pending(walletAddress: string): number {
    const queue = this.queues.get(walletAddress.toLowerCase());
    return queue ? queue.pending : 0;
  }
}

export const settlementQueue = new SettlementQueue();
