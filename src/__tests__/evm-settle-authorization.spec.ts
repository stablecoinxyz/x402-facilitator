/**
 * EVM /settle authorization constraints (x402 spec steps 3-5)
 *
 * /settle cannot lean on /verify: the spec defines flows (upfront, escrow) where
 * /verify never runs, and even in the default flow the two are separate
 * unauthenticated requests with nothing linking them. The Solana branch already
 * acts on this by calling verifySolanaPayment() inline; until 2026-09-17 the EVM
 * branch re-checked only the signature and the deadline.
 *
 * The gap that mattered: a permit authorizing 1 base unit settled successfully
 * against any requirement and returned success:true. The settle response carries
 * no amount, so a resource server could not detect the underpayment without
 * reading the chain. Reported externally — security-triage#16.
 *
 * Each test below fails on the pre-fix revision of routes/settle.ts.
 */

import request from 'supertest';
import express from 'express';
import { settlePayment } from '../routes/settle';
import { createBasePayment, createPaymentRequirements } from './fixtures/payment-fixtures';

jest.mock('@solana/web3.js', () => require('./helpers/solana-rpc-mock'));

// Let a well-formed payment reach the authorization checks: signature verification
// and balance reads are stubbed, so anything rejected below is rejected by the
// constraint under test and not by an unrelated gate.
jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    verifyTypedData: jest.fn().mockResolvedValue(true),
    createPublicClient: () => ({
      readContract: jest.fn().mockResolvedValue(BigInt('999999999999999999999')),
    }),
  };
});

const BASE = 'eip155:8453' as const;

function app() {
  const a = express();
  a.use(express.json());
  a.post('/settle', settlePayment);
  return a;
}

async function settle(paymentPayload: any, paymentRequirements: any) {
  return request(app()).post('/settle').send({ paymentPayload, paymentRequirements });
}

describe('EVM /settle enforces authorization constraints independently of /verify', () => {
  it('control: a well-formed payment covering the requirement still settles', async () => {
    const res = await settle(createBasePayment(), createPaymentRequirements(BASE));
    // Guards against a test that rejects everything and looks green.
    expect(res.body.errorReason).toBeUndefined();
    expect(res.body.success).toBe(true);
  });

  it('rejects a Permit2 authorization worth less than the required amount', async () => {
    const requirements = createPaymentRequirements(BASE); // amount 10000000000000000
    const underpaying = createBasePayment();
    underpaying.payload.permit2Authorization.permitted.amount = '1';

    const res = await settle(underpaying, requirements);

    expect(res.body.success).toBe(false);
    expect(res.body.errorReason).toBe('invalid_exact_evm_payload_authorization_value_mismatch');
    // The response must never assert a settlement for an underpayment.
    expect(res.body.transaction).toBe('');
  });

  it('rejects a Permit2 authorization worth more than the exact requirement', async () => {
    const requirements = createPaymentRequirements(BASE);
    const overpaying = createBasePayment();
    overpaying.payload.permit2Authorization.permitted.amount = '20000000000000000';

    const res = await settle(overpaying, requirements);

    expect(res.body.success).toBe(false);
    expect(res.body.errorReason).toBe('invalid_exact_evm_payload_authorization_value_mismatch');
  });

  it('step 4: rejects a permit whose validAfter has not arrived', async () => {
    const payment = createBasePayment();
    payment.payload.authorization.validAfter = String(Math.floor(Date.now() / 1000) + 3600);

    const res = await settle(payment, createPaymentRequirements(BASE));

    expect(res.body.success).toBe(false);
    expect(res.body.errorReason).toBe('invalid_exact_evm_payload_authorization_valid_after');
  });

  it('step 5: rejects a permit naming a spender that is not the facilitator', async () => {
    const payment = createBasePayment();
    payment.payload.authorization.to = '0x000000000000000000000000000000000000dEaD';

    const res = await settle(payment, createPaymentRequirements(BASE));

    expect(res.body.success).toBe(false);
    expect(res.body.errorReason).toBe('invalid_exact_evm_payload_recipient_mismatch');
  });
});
