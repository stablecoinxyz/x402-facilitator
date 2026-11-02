/**
 * The Redis ledger against a real Redis — not a mock, because the properties
 * that matter (atomic claim, shared across clients, TTL kept on update, fail
 * fast when unreachable) are Redis behaviour.
 *
 * Needs `REDIS_TEST_URL` (CI provides a Redis service). Locally:
 *   redis-server --port 6390 --save '' --daemonize yes
 *   REDIS_TEST_URL=redis://127.0.0.1:6390 npx jest sui-settlement-ledger.redis
 * In CI a missing URL fails the suite instead of skipping it, so the gate cannot
 * go quietly green.
 */
import { randomUUID } from 'crypto';
import { RedisSuiSettlementLedger, SUI_LEDGER_TTL_SECONDS } from '../sui/settlement-ledger';

const url = process.env.REDIS_TEST_URL;
const run = url ? describe : describe.skip;

if (!url && process.env.CI) {
  test('REDIS_TEST_URL is set in CI', () => {
    throw new Error('REDIS_TEST_URL is unset: the Redis ledger tests would be skipped');
  });
}

run('RedisSuiSettlementLedger', () => {
  const ledgers: RedisSuiSettlementLedger[] = [];
  const open = () => {
    const ledger = new RedisSuiSettlementLedger(url as string);
    ledgers.push(ledger);
    return ledger;
  };
  const freshKey = () => ({ network: 'sui:testnet', digest: `test-${randomUUID()}` });

  afterAll(async () => {
    for (const ledger of ledgers) await ledger.close();
  });

  it('lets exactly one of many concurrent claims, from separate clients, win', async () => {
    const key = freshKey();
    const clients = [open(), open(), open(), open()];
    const results = await Promise.all(clients.flatMap((ledger, i) => [ledger.claim(key, `a${i}`), ledger.claim(key, `b${i}`)]));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('shows one client the record another client wrote (shared across machines and restarts)', async () => {
    const key = freshKey();
    const writer = open();
    await writer.claim(key, 'req-1');
    await writer.mark(key, 'broadcast');
    await writer.close();
    expect(await open().get(key)).toEqual({ state: 'broadcast', digest: key.digest, owner: 'req-1' });
  });

  it('sets the TTL on claim and keeps it when the state changes', async () => {
    const key = freshKey();
    const ledger = open();
    await ledger.claim(key, 'req');
    const before = await ledger.ttl(key);
    expect(before).toBeGreaterThan(SUI_LEDGER_TTL_SECONDS - 10);
    expect(before).toBeLessThanOrEqual(SUI_LEDGER_TTL_SECONDS);
    await ledger.mark(key, 'executed');
    expect(await ledger.ttl(key)).toBeGreaterThan(SUI_LEDGER_TTL_SECONDS - 10);
  });

  it('does not resurrect a released record when marking it', async () => {
    const key = freshKey();
    const ledger = open();
    await ledger.claim(key, 'req');
    await ledger.release(key);
    await ledger.mark(key, 'executed');
    expect(await ledger.get(key)).toBeNull();
    expect(await ledger.claim(key, 'req-2')).toBe(true);
  });

  it('rejects quickly, without the password in the error, when Redis is unreachable', async () => {
    // Port 1 on loopback: nothing listens, the connect is refused at once.
    const dead = new RedisSuiSettlementLedger('redis://default:hunter2@127.0.0.1:1');
    ledgers.push(dead);
    const started = Date.now();
    const error = await dead.claim(freshKey(), 'req').then(() => null, (err: unknown) => err as Error);
    expect(error).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(dead.describe()).toBe('redis 127.0.0.1:1');
    expect(dead.describe()).not.toContain('hunter2');
  });
});
