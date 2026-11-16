/**
 * Reconcile a retried EVM settlement against the transaction this process
 * broadcast for it. Shared by the Permit2 and EIP-3009 paths.
 *
 * Never broadcasts. A hit is trusted only after the stored transaction is
 * shown to be ours and to carry exactly this request's calldata.
 */
import type { PublicClient, TransactionReceipt } from 'viem';
import type { Logger } from 'pino';
import { pendingSettlements, type PendingSettlement } from '../protection/pending-settlement-store';

/** Well under the stock client's 90 s, and the shared signer queue is held for the wait. */
export const PENDING_RECONCILE_TIMEOUT_MS = 20_000;

export type ReconcileOutcome =
  | { kind: 'mined'; receipt: TransactionReceipt }
  | { kind: 'reverted' }
  | { kind: 'pending' }
  | { kind: 'mismatch' };

export type ExpectedTransaction = { to: `0x${string}`; from: `0x${string}`; input: `0x${string}` };

const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

export async function reconcilePending(client: PublicClient, hash: `0x${string}`, expected: ExpectedTransaction, log: Logger): Promise<ReconcileOutcome> {
  // A read failure or a not-yet-visible transaction is "unknown", never a miss:
  // a miss would rebroadcast, or answer with no hash, a payment we already sent.
  let tx;
  try { tx = await client.getTransaction({ hash }); }
  catch (err) { log.warn({ err, txHash: hash }, 'pending reconcile: stored transaction not readable'); return { kind: 'pending' }; }
  if (!tx) { log.warn({ txHash: hash }, 'pending reconcile: stored transaction not visible yet'); return { kind: 'pending' }; }
  if (!same(tx.to, expected.to) || !same(tx.from, expected.from) || !same(tx.input, expected.input)) {
    log.error({ txHash: hash, to: tx.to, from: tx.from }, 'pending reconcile: stored transaction is not this request\'s broadcast');
    return { kind: 'mismatch' };
  }
  let receipt: TransactionReceipt;
  try {
    // No replacement handling: viem would otherwise resolve the receipt of a
    // different transaction from our EOA that replaced this one.
    receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: PENDING_RECONCILE_TIMEOUT_MS, checkReplacement: false });
  } catch (err) {
    log.warn({ err, txHash: hash }, 'pending reconcile: receipt still unavailable');
    return { kind: 'pending' };
  }
  if (!same(receipt.transactionHash, hash)) return { kind: 'pending' };
  return receipt.status === 'reverted' ? { kind: 'reverted' } : { kind: 'mined', receipt };
}

/** Errors the settle catch-all already turns into the right answer, each carrying `hash`. */
export function pendingError(hash: `0x${string}`): Error {
  const err: any = new Error('settlement broadcast but unconfirmed');
  err.broadcastHash = hash; err.settlementPending = true;
  return err;
}
export function revertedError(hash: `0x${string}`): Error {
  const err: any = new Error('settlement reverted');
  err.broadcastHash = hash; err.transactionReverted = true;
  return err;
}

/**
 * The receipt wait after OUR broadcast failed: record it so the retry
 * reconciles, then rethrow as pending. Runs inside the signer queue, before the
 * queue releases, so a queued duplicate cannot run between the broadcast and
 * the record. If the record cannot be written, the answer still carries the
 * hash but under a code upstream does not retry (a retry with no record would
 * broadcast again).
 */
export async function recordPendingAndThrow(key: string, hash: `0x${string}`, cause: any, ttlMs: number, log: Logger): Promise<never> {
  const record: PendingSettlement = { hash, expiresAt: Date.now() + ttlMs };
  try { await pendingSettlements().set(key, record); }
  catch (err) {
    log.error({ err, txHash: hash }, 'pending settlement record could not be written');
    const e: any = cause instanceof Error ? cause : new Error(String(cause));
    e.broadcastHash = hash; e.pendingUnrecorded = true;
    throw e;
  }
  const e: any = cause instanceof Error ? cause : new Error(String(cause));
  e.broadcastHash = hash; e.settlementPending = true;
  throw e;
}
