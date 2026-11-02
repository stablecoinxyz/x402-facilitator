/**
 * Durable per-digest record of Sui settlements.
 *
 * The vendored scheme's own claim store (`SettlementCache`) is an in-process
 * `Map` that the scheme releases after ANY failed settle — including one where
 * the bytes were already broadcast and only the receipt was lost. That release
 * lets a second request claim the same bytes, and a fullnode answers a
 * re-submitted, executed transaction with its cached effects, so both requests
 * could report success for one payment. The map is also empty after every
 * deploy and is not shared between machines.
 *
 * This ledger replaces it. The route creates the record before submitting and
 * never releases it once the bytes may have left the process. The scheme is
 * given a pass-through guard (see `sui-exact.ts`) so its own release cannot
 * reopen the hole.
 *
 * States:
 * - `in_flight` — claimed by a request that has not finished
 * - `broadcast` — this facilitator submitted the bytes; outcome not yet known
 * - `executed`  — the chain executed the transaction (success or effects mismatch)
 *
 * A record is deleted only when nothing was broadcast, or when the chain
 * confirms the transaction failed (no funds moved; the payer may retry).
 */
import { createClient } from 'redis';

export type SuiLedgerState = 'in_flight' | 'broadcast' | 'executed';

export type SuiLedgerRecord = {
  state: SuiLedgerState;
  digest: string;
  /** Request id of the settle that created the record. */
  owner: string;
};

export type SuiLedgerKey = { network: string; digest: string };

export interface SuiSettlementLedger {
  /** Atomically create an `in_flight` record. False when one already exists. */
  claim(key: SuiLedgerKey, owner: string): Promise<boolean>;
  /** The record for a digest, or null. */
  get(key: SuiLedgerKey): Promise<SuiLedgerRecord | null>;
  /** Move an existing record to a new state, keeping its expiry. */
  mark(key: SuiLedgerKey, state: SuiLedgerState): Promise<void>;
  /** Delete a record. Only for "nothing was broadcast" or "chain confirms failed". */
  release(key: SuiLedgerKey): Promise<void>;
  /** Host the ledger is stored on, for the startup log. Never carries credentials. */
  describe(): string;
}

const SUI_EPOCH_MS = 86_400_000;

/**
 * How long a record is kept.
 *
 * Measured 2026-11-02 via `getCurrentSystemState()`: both mainnet and testnet
 * report an epoch duration of 86,400,000 ms (24 h). A payment's window
 * satisfies `maxEpoch <= currentEpoch + 1` (the scheme refuses windows wider
 * than two epochs and settles only inside the window), and the vendored
 * guidance is to keep a claim until the network is two epochs past `maxEpoch`.
 * That is at most 3 epochs from the moment of settlement; one more of margin
 * gives 4. A replay after expiry still reaches the chain pre-check in the
 * route, which refuses an executed digest, so expiry is not a replay hole.
 */
export const SUI_LEDGER_TTL_SECONDS = (4 * SUI_EPOCH_MS) / 1000;

const LEDGER_CONNECT_TIMEOUT_MS = 2_000;

const KEY_PREFIX = 'x402:sui:settlement:';

function ledgerKey(key: SuiLedgerKey): string {
  return `${KEY_PREFIX}${key.network}:${key.digest}`;
}

function parseRecord(raw: string | null): SuiLedgerRecord | null {
  return raw === null ? null : (JSON.parse(raw) as SuiLedgerRecord);
}

/** Redis-backed ledger, shared by every machine and surviving restarts. */
export class RedisSuiSettlementLedger implements SuiSettlementLedger {
  private readonly client: ReturnType<typeof createClient>;
  private connecting: Promise<unknown> | null = null;
  private readonly host: string;

  constructor(url: string) {
    this.host = new URL(url).host;
    // Fail closed and fast: a settle waiting on an unreachable ledger must
    // refuse, not hang. No background reconnect loop and no offline queue —
    // each call connects on demand and rejects if it cannot.
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: LEDGER_CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });
    // Without a listener node-redis throws the error event as an uncaught
    // exception. Connection errors embed the URL, which carries the password,
    // so only the error code is logged by callers; here it is dropped.
    this.client.on('error', () => undefined);
  }

  private async ready(): Promise<ReturnType<typeof createClient>> {
    // `isOpen` turns true while the socket is still connecting; only `isReady`
    // means commands will run. Concurrent first calls share one connect.
    if (!this.client.isReady) {
      this.connecting ??= (this.client.isOpen ? Promise.resolve() : this.client.connect()).finally(() => {
        this.connecting = null;
      });
      await this.connecting;
    }
    return this.client;
  }

  async claim(key: SuiLedgerKey, owner: string): Promise<boolean> {
    const client = await this.ready();
    const record: SuiLedgerRecord = { state: 'in_flight', digest: key.digest, owner };
    const set = await client.set(ledgerKey(key), JSON.stringify(record), {
      condition: 'NX',
      expiration: { type: 'EX', value: SUI_LEDGER_TTL_SECONDS },
    });
    return set === 'OK';
  }

  async get(key: SuiLedgerKey): Promise<SuiLedgerRecord | null> {
    const client = await this.ready();
    return parseRecord(await client.get(ledgerKey(key)));
  }

  async mark(key: SuiLedgerKey, state: SuiLedgerState): Promise<void> {
    const client = await this.ready();
    const current = parseRecord(await client.get(ledgerKey(key)));
    if (!current) return;
    await client.set(ledgerKey(key), JSON.stringify({ ...current, state }), {
      condition: 'XX',
      expiration: 'KEEPTTL',
    });
  }

  async release(key: SuiLedgerKey): Promise<void> {
    const client = await this.ready();
    await client.del(ledgerKey(key));
  }

  describe(): string {
    return `redis ${this.host}`;
  }

  /** For tests: the remaining TTL of a record, in seconds. */
  async ttl(key: SuiLedgerKey): Promise<number> {
    const client = await this.ready();
    return client.ttl(ledgerKey(key));
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}

/**
 * In-process ledger. Tests only: it is not shared between machines and is empty
 * after a restart, which is exactly the defect the Redis ledger exists to fix.
 * Production never falls back to it — see `getSuiSettlementLedger`.
 */
export class MemorySuiSettlementLedger implements SuiSettlementLedger {
  private readonly records = new Map<string, SuiLedgerRecord>();

  async claim(key: SuiLedgerKey, owner: string): Promise<boolean> {
    const id = ledgerKey(key);
    if (this.records.has(id)) return false;
    this.records.set(id, { state: 'in_flight', digest: key.digest, owner });
    return true;
  }

  async get(key: SuiLedgerKey): Promise<SuiLedgerRecord | null> {
    return this.records.get(ledgerKey(key)) ?? null;
  }

  async mark(key: SuiLedgerKey, state: SuiLedgerState): Promise<void> {
    const current = this.records.get(ledgerKey(key));
    if (current) this.records.set(ledgerKey(key), { ...current, state });
  }

  async release(key: SuiLedgerKey): Promise<void> {
    this.records.delete(ledgerKey(key));
  }

  describe(): string {
    return 'memory (tests only)';
  }
}

let ledger: SuiSettlementLedger | null | undefined;

/**
 * The configured ledger, or null when `REDIS_URL` is unset. Null makes the
 * route refuse real Sui settlement (`sui_durability_unavailable`); there is no
 * in-memory fallback, because a fallback would let a deploy look durable while
 * running without the guard.
 */
export function getSuiSettlementLedger(): SuiSettlementLedger | null {
  if (ledger !== undefined) return ledger;
  const url = process.env.REDIS_URL;
  ledger = url ? new RedisSuiSettlementLedger(url) : null;
  return ledger;
}

/** Tests only: install a ledger (or null) in place of the configured one. */
export function setSuiSettlementLedgerForTests(next: SuiSettlementLedger | null | undefined): void {
  ledger = next;
}
