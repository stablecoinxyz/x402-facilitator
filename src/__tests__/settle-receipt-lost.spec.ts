/**
 * Settlement outcomes after transferFrom() is broadcast
 *
 * Covers stablecoinxyz/x402-facilitator#6. Once transferFrom() is broadcast the
 * tokens may already have moved, so no later failure is terminal and no answer
 * may omit the hash. A caller told "failed" with no hash reads it as
 * did-not-happen and signs a fresh permit — a second payment.
 *
 * Also covers the receipt whose status is 'reverted': viem RESOLVES for those,
 * so a transfer that reverted on chain would otherwise be recorded as success.
 *
 * These drive the real settlement path (ENABLE_REAL_SETTLEMENT=true), which
 * jest.config.js pins off for every other suite.
 */

import request from 'supertest';
import express from 'express';
import { settlePayment } from '../routes/settle';
import { createBasePayment, createPaymentRequirements } from './fixtures/payment-fixtures';

const PERMIT_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const TRANSFER_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222';

const mockVerifyTypedData = jest.fn().mockResolvedValue(true);
const mockReadContract = jest.fn().mockResolvedValue(BigInt('999999999999999999999'));
const mockGetTransactionCount = jest.fn().mockResolvedValue(0);
const mockGetGasPrice = jest.fn().mockResolvedValue(1000000000n);
const mockEstimateGas = jest.fn().mockResolvedValue(100000n);
const mockWriteContract = jest.fn();
const mockWaitForTransactionReceipt = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    verifyTypedData: (...args: any[]) => mockVerifyTypedData(...args),
    createPublicClient: () => ({
      readContract: (...args: any[]) => mockReadContract(...args),
      getTransactionCount: (...args: any[]) => mockGetTransactionCount(...args),
      getGasPrice: (...args: any[]) => mockGetGasPrice(...args),
      estimateContractGas: (...args: any[]) => mockEstimateGas(...args),
      waitForTransactionReceipt: (...args: any[]) => mockWaitForTransactionReceipt(...args),
    }),
    createWalletClient: () => ({
      writeContract: (...args: any[]) => mockWriteContract(...args),
    }),
  };
});

jest.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({ address: '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6' }),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/settle', settlePayment);
  return app;
}

function sendSettle(app: express.Application, payload: any, requirements: any) {
  return request(app).post('/settle').send({ paymentPayload: payload, paymentRequirements: requirements });
}

/** How many times the money-moving call was broadcast. */
function transferBroadcasts() {
  return mockWriteContract.mock.calls.filter(c => c[0]?.functionName === 'transferFrom').length;
}

describe('Settlement after transferFrom is broadcast', () => {
  let app: express.Application;
  const originalRealSettlement = process.env.ENABLE_REAL_SETTLEMENT;

  beforeAll(() => { process.env.ENABLE_REAL_SETTLEMENT = 'true'; });
  afterAll(() => { process.env.ENABLE_REAL_SETTLEMENT = originalRealSettlement; });

  beforeEach(() => {
    app = createTestApp();
    mockWriteContract.mockReset();
    mockWaitForTransactionReceipt.mockReset();
    mockWriteContract.mockImplementation(async (args: any) =>
      args.functionName === 'permit' ? PERMIT_HASH : TRANSFER_HASH);
  });

  it('answers settlement_pending WITH the hash when the receipt read fails after broadcast', async () => {
    mockWaitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PERMIT_HASH) return { status: 'success', blockNumber: 1n, gasUsed: 50000n };
      throw new Error('Timed out while waiting for transaction to be confirmed.');
    });

    const response = await sendSettle(app, createBasePayment(), createPaymentRequirements('eip155:8453'));

    expect(transferBroadcasts()).toBe(1);            // the money-moving call went out
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('settlement_pending');
    expect(response.body.transaction).toBe(TRANSFER_HASH);
    expect(response.body.network).toBe('eip155:8453');
  });

  it('answers settlement_pending WITH the hash when the RPC connection drops after broadcast', async () => {
    mockWaitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PERMIT_HASH) return { status: 'success', blockNumber: 1n, gasUsed: 50000n };
      throw new Error('fetch failed');
    });

    const response = await sendSettle(app, createBasePayment(), createPaymentRequirements('eip155:8453'));

    expect(response.body.errorReason).toBe('settlement_pending');
    expect(response.body.transaction).toBe(TRANSFER_HASH);
  });

  it('never answers a post-broadcast failure with an empty transaction', async () => {
    // The shape that invites a second payment: success:false and nothing to reconcile.
    mockWaitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PERMIT_HASH) return { status: 'success', blockNumber: 1n, gasUsed: 50000n };
      throw new Error('could not be found');
    });

    const response = await sendSettle(app, createBasePayment(), createPaymentRequirements('eip155:8453'));

    expect(transferBroadcasts()).toBe(1);
    expect(response.body.transaction).not.toBe('');
  });

  it('does not record a pending settlement as settled', async () => {
    const payment = createBasePayment({ nonce: 'pending-not-settled' });
    mockWaitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PERMIT_HASH) return { status: 'success', blockNumber: 1n, gasUsed: 50000n };
      throw new Error('Timed out while waiting for transaction to be confirmed.');
    });

    const first = await sendSettle(app, payment, createPaymentRequirements('eip155:8453'));
    expect(first.body.errorReason).toBe('settlement_pending');

    // A pending settlement must not read back as an idempotent success.
    const second = await sendSettle(app, payment, createPaymentRequirements('eip155:8453'));
    expect(second.body.success).toBe(false);
  });

  it('PINS KNOWN BEHAVIOR: re-presenting the same payload is answered permit_signature_invalid', async () => {
    // Not a fix — a pin on what still happens, so a change to it is deliberate.
    // The permit nonce was consumed on chain by the first attempt, so the retry's
    // gas dry-run reverts. Both SBC and USDC on Base revert with a string
    // containing "invalid signature", which categorizeSettleError maps to
    // permit_signature_invalid — a client reading that as "my signature was bad"
    // signs a fresh permit, which is a second payment. The defense is the
    // settlement_pending hash in the FIRST response, which the caller reconciles
    // on chain rather than re-presenting.
    const payment = createBasePayment({ nonce: 'consumed-on-chain' });
    mockWaitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PERMIT_HASH) return { status: 'success', blockNumber: 1n, gasUsed: 50000n };
      throw new Error('Timed out while waiting for transaction to be confirmed.');
    });

    const first = await sendSettle(app, payment, createPaymentRequirements('eip155:8453'));
    expect(first.body.errorReason).toBe('settlement_pending');

    // Second presentation: the token now rejects the consumed permit.
    mockEstimateGas.mockRejectedValueOnce(
      new Error('execution reverted: EIP2612: invalid signature')
    );
    const second = await sendSettle(app, payment, createPaymentRequirements('eip155:8453'));

    expect(second.body.success).toBe(false);
    expect(second.body.errorReason).toBe('permit_signature_invalid');
    expect(transferBroadcasts()).toBe(1); // no second transfer from us
  });

  it('reports a mined-but-reverted transfer as failed, not as success', async () => {
    mockWaitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PERMIT_HASH) return { status: 'success', blockNumber: 1n, gasUsed: 50000n };
      return { status: 'reverted', blockNumber: 2n, gasUsed: 50000n };
    });

    const response = await sendSettle(app, createBasePayment(), createPaymentRequirements('eip155:8453'));

    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('invalid_transaction_state');
    expect(response.body.transaction).toBe(TRANSFER_HASH);
  });

  it('does not replay a reverted transfer as a success', async () => {
    const payment = createBasePayment({ nonce: 'reverted-not-settled' });
    mockWaitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PERMIT_HASH) return { status: 'success', blockNumber: 1n, gasUsed: 50000n };
      return { status: 'reverted', blockNumber: 2n, gasUsed: 50000n };
    });

    await sendSettle(app, payment, createPaymentRequirements('eip155:8453'));
    const replay = await sendSettle(app, payment, createPaymentRequirements('eip155:8453'));

    expect(replay.body.success).toBe(false);
  });

  it('reports a reverted permit as failed', async () => {
    mockWaitForTransactionReceipt.mockImplementation(async () =>
      ({ status: 'reverted', blockNumber: 1n, gasUsed: 50000n }));

    const response = await sendSettle(app, createBasePayment(), createPaymentRequirements('eip155:8453'));

    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('invalid_transaction_state');
    expect(response.body.transaction).toBe(PERMIT_HASH);
  });

  it('still settles when both receipts confirm', async () => {
    mockWaitForTransactionReceipt.mockImplementation(async () =>
      ({ status: 'success', blockNumber: 1n, gasUsed: 50000n }));

    const response = await sendSettle(app, createBasePayment(), createPaymentRequirements('eip155:8453'));

    expect(response.body.success).toBe(true);
    expect(response.body.transaction).toBe(TRANSFER_HASH);
  });
});
