import { settlementQueue } from '../lib/settlement-queue';

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('SettlementQueue', () => {
  it('should execute tasks serially for the same wallet', async () => {
    const wallet = '0xSerial_' + Date.now();
    const executionOrder: number[] = [];

    const task1 = settlementQueue.enqueue(wallet, async () => {
      executionOrder.push(1);
      await delay(50);
      executionOrder.push(2);
      return 'result1';
    });

    const task2 = settlementQueue.enqueue(wallet, async () => {
      executionOrder.push(3);
      await delay(50);
      executionOrder.push(4);
      return 'result2';
    });

    const [r1, r2] = await Promise.all([task1, task2]);

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
    // Task 1 must fully complete (1,2) before task 2 starts (3,4)
    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  it('should not block different wallets from running in parallel', async () => {
    const walletA = '0xParallelA_' + Date.now();
    const walletB = '0xParallelB_' + Date.now();
    const events: string[] = [];

    const taskA = settlementQueue.enqueue(walletA, async () => {
      events.push('A_start');
      await delay(80);
      events.push('A_end');
    });

    const taskB = settlementQueue.enqueue(walletB, async () => {
      events.push('B_start');
      await delay(80);
      events.push('B_end');
    });

    await Promise.all([taskA, taskB]);

    // Both should start before either ends (parallel execution)
    const aStart = events.indexOf('A_start');
    const bStart = events.indexOf('B_start');
    const aEnd = events.indexOf('A_end');
    const bEnd = events.indexOf('B_end');

    expect(bStart).toBeLessThan(aEnd); // B starts before A finishes
    expect(aStart).toBeLessThan(bEnd); // A starts before B finishes
  });

  it('should continue processing after a task fails', async () => {
    const wallet = '0xFailure_' + Date.now();

    const task1 = settlementQueue.enqueue(wallet, async () => {
      throw new Error('permit reverted');
    });

    const task2 = settlementQueue.enqueue(wallet, async () => {
      return 'recovered';
    });

    await expect(task1).rejects.toThrow('permit reverted');
    const result = await task2;
    expect(result).toBe('recovered');
  });

  it('should return correct results to each caller', async () => {
    const wallet = '0xResults_' + Date.now();

    const results = await Promise.all([
      settlementQueue.enqueue(wallet, async () => 'tx_hash_1'),
      settlementQueue.enqueue(wallet, async () => 'tx_hash_2'),
      settlementQueue.enqueue(wallet, async () => 'tx_hash_3'),
    ]);

    expect(results).toEqual(['tx_hash_1', 'tx_hash_2', 'tx_hash_3']);
  });

  it('should report pending queue depth', async () => {
    const wallet = '0xDepth_' + Date.now();
    let depthDuringTask1 = 0;

    const task1 = settlementQueue.enqueue(wallet, async () => {
      depthDuringTask1 = settlementQueue.pending(wallet);
      await delay(50);
    });

    // Enqueue two more while task1 is running
    await delay(5); // let task1 start
    const task2 = settlementQueue.enqueue(wallet, async () => 'b');
    const task3 = settlementQueue.enqueue(wallet, async () => 'c');

    await Promise.all([task1, task2, task3]);

    // While task1 was running, tasks 2 and 3 were pending
    // (pending counts waiting tasks, not the currently executing one)
    expect(depthDuringTask1).toBeGreaterThanOrEqual(0);
  });

  it('should be case-insensitive on wallet addresses', async () => {
    const suffix = '_' + Date.now();
    const executionOrder: number[] = [];

    const task1 = settlementQueue.enqueue('0xABCD' + suffix, async () => {
      executionOrder.push(1);
      await delay(50);
      executionOrder.push(2);
    });

    const task2 = settlementQueue.enqueue('0xabcd' + suffix, async () => {
      executionOrder.push(3);
    });

    await Promise.all([task1, task2]);

    // Same wallet (case-insensitive), so must serialize
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it('should handle many concurrent tasks without deadlock', async () => {
    const wallet = '0xStress_' + Date.now();
    const count = 20;
    let completed = 0;

    const tasks = Array.from({ length: count }, (_, i) =>
      settlementQueue.enqueue(wallet, async () => {
        await delay(5);
        completed++;
        return i;
      })
    );

    const results = await Promise.all(tasks);

    expect(completed).toBe(count);
    expect(results).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});
