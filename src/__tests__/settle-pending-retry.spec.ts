/**
 * A retried /settle for a payment THIS process broadcast but could not confirm.
 * Spec: docs/fixes/permit2-settled-retry-answers-failed.md §4 Option A (v5), §5.
 *
 * Every retry here is the hard case: by the time it arrives, our pending
 * transaction has mined, so the nonce is already used (Permit2 bitmap bit set /
 * EIP-3009 authorizationState true), the payer's balance is gone, and the
 * permit's deadline may have passed. A route that checks any of those before the
 * pending record answers "failed" for a payment that landed.
 */
import express from 'express';
import request from 'supertest';
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters } from 'viem';
import { settlePayment } from '../routes/settle';
import { createBasePayment, createPaymentRequirements } from './fixtures/payment-fixtures';
import { X402_PERMIT2_PROXY } from '../evm/permit2';
import { eip3009Abi } from '../evm/eip3009';
import { settleTotal } from '../lib/metrics';
import { config } from '../config';
import { InMemoryPendingSettlementStore, setPendingSettlementStore, PENDING_SETTLEMENT_TTL_MS, type PendingSettlementStore } from '../protection/pending-settlement-store';
import { PENDING_RECONCILE_TIMEOUT_MS } from '../evm/pending-reconcile';

const simulateContract = jest.fn();
const writeContract = jest.fn();
const waitForTransactionReceipt = jest.fn();
const getCode = jest.fn();
const readContract = jest.fn();
const getTransaction = jest.fn();
const verifyTypedData = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    verifyTypedData: (...a: any[]) => verifyTypedData(...a),
    createPublicClient: () => ({ getCode, simulateContract, waitForTransactionReceipt, readContract, getTransaction, getGasPrice: jest.fn().mockResolvedValue(1n) }),
    createWalletClient: () => ({ writeContract }),
  };
});
const SIGNER = '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6';
jest.mock('viem/accounts', () => ({ privateKeyToAccount: () => ({ address: '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6' }) }));

const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const OTHER_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const ALL_BITS = (1n << 256n) - 1n;

function app() {
  const server = express();
  server.use(express.json());
  server.post('/settle', settlePayment);
  return server;
}
const settle = (paymentPayload: any, paymentRequirements: any) => request(app()).post('/settle').send({ paymentPayload, paymentRequirements });

/** Calldata of the n-th broadcast, exactly as the route encoded it. */
function broadcastCalldata(n = 0): `0x${string}` {
  const { abi, functionName, args } = writeContract.mock.calls[n][0];
  return encodeFunctionData({ abi, functionName, args });
}
/** Our broadcast, as the chain would return it. */
function ourTransaction(to: string, n = 0) {
  return { hash: HASH, to, from: SIGNER, input: broadcastCalldata(n) };
}
/** Deep copy without the fixture's legacy `payload.authorization` adapter, which real Permit2 clients never send. */
function realShape(x: any) { const c = JSON.parse(JSON.stringify(x)); delete c.payload.authorization; return c; }
async function metricValue(result: string, network = 'eip155:8453') {
  const m = await settleTotal.get();
  return m.values.find((v) => v.labels.result === result && v.labels.network === network)?.value ?? 0;
}

let store: InMemoryPendingSettlementStore;
const previousReal = process.env.ENABLE_REAL_SETTLEMENT;
let realNow: () => number;
beforeAll(() => { realNow = Date.now; });
beforeEach(() => {
  process.env.ENABLE_REAL_SETTLEMENT = 'true';
  Date.now = realNow;
  verifyTypedData.mockReset().mockResolvedValue(true);
  getCode.mockReset().mockResolvedValue('0x01');
  simulateContract.mockReset().mockResolvedValue({});
  writeContract.mockReset().mockResolvedValue(HASH);
  waitForTransactionReceipt.mockReset();
  readContract.mockReset();
  getTransaction.mockReset();
  store = new InMemoryPendingSettlementStore();
  setPendingSettlementStore(store);
  settleTotal.reset();
});
afterAll(() => {
  Date.now = realNow;
  if (previousReal === undefined) delete process.env.ENABLE_REAL_SETTLEMENT; else process.env.ENABLE_REAL_SETTLEMENT = previousReal;
});

describe('Permit2: retry after our settlement_pending', () => {
  const requirements = () => createPaymentRequirements('eip155:8453');

  /** First /settle broadcasts HASH and the receipt wait fails → settlement_pending. */
  async function pendingFirst(payment: any) {
    readContract.mockResolvedValue(0n); // nonce unused before our broadcast
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('HTTP request failed'));
    const first = await settle(payment, requirements());
    expect(first.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
    expect(writeContract).toHaveBeenCalledTimes(1);
    // Our transaction then mines: the nonce bit is set from here on.
    readContract.mockResolvedValue(ALL_BITS);
  }

  it('answers the retry with success and the original hash, broadcasting nothing new — even after the deadline passed', async () => {
    const payment = realShape(createBasePayment({ deadline: Math.floor(Date.now() / 1000) + 30 }));
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(X402_PERMIT2_PROXY));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: HASH });
    const later = realNow() + 60_000; // past the permit deadline, inside the 5-minute record
    Date.now = () => later;

    const retry = await settle(payment, requirements());
    expect(retry.body).toMatchObject({ success: true, transaction: HASH });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ hash: HASH, checkReplacement: false }));
    expect(await metricValue('replay')).toBe(1);
  });

  it('a forgery carrying our signature on a different message never reaches the record', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    const forged = JSON.parse(JSON.stringify(payment));
    const otherPayTo = '0x1111111111111111111111111111111111111111';
    forged.payload.permit2Authorization.witness.to = otherPayTo;
    forged.accepted.payTo = otherPayTo;
    const forgedRequirements = { ...requirements(), payTo: otherPayTo };

    const res = await settle(forged, forgedRequirements);
    expect(res.body.transaction).not.toBe(HASH);
    expect(res.body).toMatchObject({ success: false, errorReason: 'permit2_invalid_nonce', transaction: '' });
    expect(getTransaction).not.toHaveBeenCalled(); // the key differs, so the record is never consulted
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('a record whose stored transaction does not carry this calldata is treated as a miss', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValue({ hash: HASH, to: X402_PERMIT2_PROXY, from: SIGNER, input: '0xdeadbeef' });
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'permit2_invalid_nonce', transaction: '' });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('a record whose stored transaction was not sent by our signer is treated as a miss', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValue({ ...ourTransaction(X402_PERMIT2_PROXY), from: '0x2222222222222222222222222222222222222222' });
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'permit2_invalid_nonce' });
  });

  it('a reverted pending transaction answers invalid_transaction_state with its hash', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(X402_PERMIT2_PROXY));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', transactionHash: HASH });

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_transaction_state', transaction: HASH });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('still unconfirmed: answers pending with the hash and keeps the ORIGINAL expiry', async () => {
    const payment = realShape(createBasePayment());
    const spy = jest.spyOn(store, 'set');
    await pendingFirst(payment);
    const firstExpiry = spy.mock.calls[0][1].expiresAt;
    getTransaction.mockResolvedValue(ourTransaction(X402_PERMIT2_PROXY));
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('Timed out while waiting for transaction'));
    Date.now = () => realNow() + 120_000;

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1].expiresAt).toBe(firstExpiry);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('an unreadable stored transaction is pending (record restored), never a miss', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockRejectedValueOnce(new Error('TransactionNotFoundError'));

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
    expect(writeContract).toHaveBeenCalledTimes(1);
    // …and the next retry still finds the record.
    getTransaction.mockResolvedValue(ourTransaction(X402_PERMIT2_PROXY));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: HASH });
    expect((await settle(payment, requirements())).body).toMatchObject({ success: true, transaction: HASH });
  });

  it('a receipt for a different (replacement) transaction is not a success', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(X402_PERMIT2_PROXY));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: OTHER_HASH });

    const res = await settle(payment, requirements());
    expect(res.body.success).toBe(false);
    expect(res.body).toMatchObject({ errorReason: 'settlement_pending', transaction: HASH });
  });

  it('two concurrent retries: exactly one success, the other a used nonce', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(X402_PERMIT2_PROXY));
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });

    const [a, b] = await Promise.all([settle(payment, requirements()), settle(payment, requirements())]);
    const bodies = [a.body, b.body];
    expect(bodies.filter((x) => x.success === true && x.transaction === HASH)).toHaveLength(1);
    expect(bodies.filter((x) => x.errorReason === 'permit2_invalid_nonce' && x.transaction === '')).toHaveLength(1);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('after the 5-minute record expires, the retry is a plain used nonce', async () => {
    const payment = realShape(createBasePayment({ deadline: Math.floor(Date.now() / 1000) + 3600 }));
    await pendingFirst(payment);
    Date.now = () => realNow() + PENDING_SETTLEMENT_TTL_MS + 1000;

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'permit2_invalid_nonce', transaction: '' });
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('a record whose stored transaction went to another contract is treated as a miss', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValue({ ...ourTransaction(X402_PERMIT2_PROXY), to: '0x3333333333333333333333333333333333333333' });
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'permit2_invalid_nonce', transaction: '' });
  });

  it('a stored transaction the node does not return yet (null) is pending, never a crash or a miss', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValueOnce(null);

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('bounds the reconcile wait by PENDING_RECONCILE_TIMEOUT_MS (it holds the shared signer queue)', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(X402_PERMIT2_PROXY));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: HASH });

    await settle(payment, requirements());
    expect(waitForTransactionReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ hash: HASH, timeout: PENDING_RECONCILE_TIMEOUT_MS }));
    expect(PENDING_RECONCILE_TIMEOUT_MS).toBeLessThan(90_000); // under the stock client's abort
  });

  it('a payload whose signature does not verify never reads the record', async () => {
    const payment = realShape(createBasePayment());
    await pendingFirst(payment);
    const spy = jest.spyOn(store, 'get');
    verifyTypedData.mockResolvedValue(false);

    const res = await settle(payment, requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_signature' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a record that cannot be written still answers with the hash, under a code upstream does not retry', async () => {
    const failing: PendingSettlementStore = { get: async () => undefined, set: async () => { throw new Error('store down'); }, delete: async () => {} };
    setPendingSettlementStore(failing);
    readContract.mockResolvedValue(0n);
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('HTTP request failed'));
    const res = await settle(realShape(createBasePayment()), requirements());
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_unconfirmed', transaction: HASH });
  });
});

describe('Permit2: used nonce with no record of ours', () => {
  it('refuses an expired permit with no record, before reading the bitmap or broadcasting', async () => {
    readContract.mockResolvedValue(0n);
    const res = await settle(realShape(createBasePayment({ deadline: Math.floor(Date.now() / 1000) - 1 })), createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_authorization_valid_before', transaction: '' });
    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses a permit whose validAfter has not arrived, with no record', async () => {
    readContract.mockResolvedValue(0n);
    const payment: any = realShape(createBasePayment());
    payment.payload.permit2Authorization.witness.validAfter = String(Math.floor(Date.now() / 1000) + 600);
    const res = await settle(payment, createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_authorization_valid_after' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('answers permit2_invalid_nonce, metered as a client failure, without simulating or broadcasting', async () => {
    readContract.mockResolvedValue(ALL_BITS);
    const res = await settle(realShape(createBasePayment()), createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: false, errorReason: 'permit2_invalid_nonce', transaction: '' });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
    expect(await metricValue('failed')).toBe(1);
    expect(await metricValue('tx_reverted')).toBe(0);
  });

  it('reads the bit of THIS nonce, not just any bit in the word', async () => {
    const nonce = 5n;
    readContract.mockImplementation(({ args }: any) => Promise.resolve(args[1] === 0n ? ALL_BITS ^ (1n << nonce) : ALL_BITS));
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });
    const res = await settle(realShape(createBasePayment({ nonce })), createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: true, transaction: HASH });
  });
});

describe('EIP-3009: retry after our settlement_pending', () => {
  const PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
  const MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const SBC = config.baseSbcTokenAddress;
  const req = () => ({ scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: SBC, payTo: MERCHANT, maxTimeoutSeconds: 60, extra: { name: 'Stable Coin', version: '1' } });
  const pay = (validBefore: number) => ({
    x402Version: 2, accepted: req(),
    payload: { signature: `0x${'1'.repeat(128)}1b`, authorization: { from: PAYER, to: MERCHANT, value: '1000', validAfter: '0', validBefore: String(validBefore), nonce: `0x${'ef'.repeat(32)}` } },
  });
  const transferLog = () => ({ address: SBC, topics: encodeEventTopics({ abi: eip3009Abi, eventName: 'Transfer', args: { from: PAYER, to: MERCHANT } }), data: encodeAbiParameters([{ type: 'uint256' }], [1000n]) });
  function chain(used: boolean, balance: bigint) {
    readContract.mockImplementation(({ functionName }: any) => Promise.resolve(functionName === 'authorizationState' ? used : balance));
  }
  async function pendingFirst(payment: any) {
    chain(false, 10_000n);
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('HTTP request failed'));
    const first = await settle(payment, req());
    expect(first.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
    chain(true, 0n); // ours mined: authorization used, payer drained
  }

  it('answers the retry with success and the original hash — nonce used, balance gone, window passed', async () => {
    const payment = pay(Math.floor(Date.now() / 1000) + 30);
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(SBC));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: HASH, logs: [transferLog()] });
    Date.now = () => realNow() + 60_000;

    const retry = await settle(payment, req());
    expect(retry.body).toMatchObject({ success: true, transaction: HASH });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(await metricValue('replay')).toBe(1);
  });

  it('a reconciled transaction without the signed Transfer is not vouched for', async () => {
    const payment = pay(Math.floor(Date.now() / 1000) + 300);
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(SBC));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: HASH, logs: [] });

    const retry = await settle(payment, req());
    expect(retry.body).toMatchObject({ success: false, errorReason: 'settlement_effects_mismatch', transaction: HASH });
  });

  it('a forgery carrying our signature on a different message never reaches the record', async () => {
    const payment = pay(Math.floor(Date.now() / 1000) + 300);
    await pendingFirst(payment);
    const other = '0x1111111111111111111111111111111111111111';
    const forged: any = JSON.parse(JSON.stringify(payment));
    forged.payload.authorization.to = other; forged.accepted.payTo = other;
    chain(false, 10_000n);
    writeContract.mockResolvedValue(OTHER_HASH);
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: OTHER_HASH, logs: [] });

    const res = await settle(forged, { ...req(), payTo: other });
    expect(res.body.transaction).not.toBe(HASH);
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('still unconfirmed: answers pending with the hash and keeps the ORIGINAL expiry', async () => {
    const payment = pay(Math.floor(Date.now() / 1000) + 300);
    const spy = jest.spyOn(store, 'set');
    await pendingFirst(payment);
    const firstExpiry = spy.mock.calls[0][1].expiresAt;
    getTransaction.mockResolvedValue(ourTransaction(SBC));
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('Timed out while waiting for transaction'));

    const res = await settle(payment, req());
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1].expiresAt).toBe(firstExpiry);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('two concurrent retries: exactly one success, the other a used authorization', async () => {
    const payment = pay(Math.floor(Date.now() / 1000) + 300);
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(SBC));
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH, logs: [transferLog()] });

    const [a, b] = await Promise.all([settle(payment, req()), settle(payment, req())]);
    const bodies = [a.body, b.body];
    expect(bodies.filter((x) => x.success === true && x.transaction === HASH)).toHaveLength(1);
    expect(bodies.filter((x) => x.errorReason === 'invalid_exact_evm_nonce_already_used' && x.transaction === '')).toHaveLength(1);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('a record seen before the queue but gone inside it re-runs the skipped checks (an expired authorization is refused, not broadcast)', async () => {
    // The pre-queue look found a record, so the window and chain checks were
    // skipped; by the time this request reached the queue the record was gone.
    let calls = 0;
    const racing: PendingSettlementStore = {
      get: async () => (calls++ === 0 ? { hash: HASH, expiresAt: Date.now() + 60_000 } : undefined),
      set: async () => {}, delete: async () => {},
    };
    setPendingSettlementStore(racing);
    chain(false, 10_000n);
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH, logs: [transferLog()] });

    const res = await settle(pay(Math.floor(Date.now() / 1000) + 3), req()); // inside the 6 s settle margin
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_authorization_valid_before', transaction: '' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('a reverted pending transaction answers invalid_transaction_state with its hash', async () => {
    const payment = pay(Math.floor(Date.now() / 1000) + 300);
    await pendingFirst(payment);
    getTransaction.mockResolvedValue(ourTransaction(SBC));
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', transactionHash: HASH, logs: [] });

    const res = await settle(payment, req());
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_transaction_state', transaction: HASH });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('a record seen before the queue but gone inside it re-runs the chain checks (an empty balance is refused, not broadcast)', async () => {
    let calls = 0;
    const racing: PendingSettlementStore = {
      get: async () => (calls++ === 0 ? { hash: HASH, expiresAt: Date.now() + 60_000 } : undefined),
      set: async () => {}, delete: async () => {},
    };
    setPendingSettlementStore(racing);
    chain(false, 0n);

    const res = await settle(pay(Math.floor(Date.now() / 1000) + 300), req());
    expect(res.body).toMatchObject({ success: false, errorReason: 'insufficient_funds', transaction: '' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('simulated mode still refuses an authorization outside its time window', async () => {
    process.env.ENABLE_REAL_SETTLEMENT = 'false';
    const res = await settle(pay(Math.floor(Date.now() / 1000) - 10), req());
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_authorization_valid_before' });
  });

  it('with no record, a used authorization is still refused with no hash', async () => {
    chain(true, 0n);
    const res = await settle(pay(Math.floor(Date.now() / 1000) + 300), req());
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_nonce_already_used', transaction: '' });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });
});
