/**
 * Malformed Signature Guard
 *
 * A compact ECDSA signature is 65 bytes — "0x" + 130 hex chars. Shorter input
 * makes slice() return "" and parseInt() return NaN, which viem throws on while
 * ABI-encoding the permit() call.
 *
 * Before the guard that surfaced as `gas_estimation_failed` under the catch-all
 * `failed` metric label, so a client sending junk was indistinguishable from the
 * facilitator breaking — and fed the settle-error-rate alert.
 *
 * Observed in production 2026-08-26: a scanner posting from 0x...0001 produced
 * four such settles, each logging
 *   RangeError: The number NaN cannot be converted to a BigInt
 * after a wasted eth_estimateGas round trip.
 */

import request from 'supertest';
import express from 'express';
import { settlePayment } from '../routes/settle';
import { createBasePayment, createPaymentRequirements } from './fixtures/payment-fixtures';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/settle', settlePayment);
  return app;
}

function sendSettle(app: express.Application, paymentPayload: any, paymentRequirements: any) {
  return request(app).post('/settle').send({ paymentPayload, paymentRequirements });
}

describe('POST /settle - malformed signature guard', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  const malformed: Array<[string, any]> = [
    ['too short', '0xdeadbeef'],
    ['just the 0x prefix', '0x'],
    ['empty string', ''],
    ['missing 0x prefix', 'a'.repeat(130)],
    ['one char short', '0x' + 'a'.repeat(129)],
    ['one char long', '0x' + 'a'.repeat(131)],
    ['non-hex characters', '0x' + 'z'.repeat(130)],
    ['null', null],
    ['undefined', undefined],
    ['numeric', 12345],
    ['object', { r: '0x1', s: '0x2', v: 27 }],
  ];

  it.each(malformed)('should reject a %s signature as permit_signature_invalid', async (_label, signature) => {
    const paymentPayload = createBasePayment();
    (paymentPayload.payload as any).signature = signature;
    const paymentRequirements = createPaymentRequirements('eip155:8453');

    const response = await sendSettle(app, paymentPayload, paymentRequirements);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('permit_signature_invalid');
    // Never a gas/estimation error — that label means the facilitator misbehaved
    expect(response.body.errorReason).not.toMatch(/gas_estimation_failed/);
  });

  it('should accept a well-formed 65-byte signature past the guard', async () => {
    const paymentPayload = createBasePayment();
    (paymentPayload.payload as any).signature = '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b';
    const paymentRequirements = createPaymentRequirements('eip155:8453');

    const response = await sendSettle(app, paymentPayload, paymentRequirements);

    // Well-formed but not a real signature: it must get past the format guard
    expect(response.body.errorReason).not.toBe('permit_signature_invalid');
  });

  it('should accept both uppercase and lowercase hex', async () => {
    for (const sig of ['0x' + 'AB'.repeat(65), '0x' + 'ab'.repeat(65)]) {
      const paymentPayload = createBasePayment();
      (paymentPayload.payload as any).signature = sig;
      const response = await sendSettle(app, paymentPayload, createPaymentRequirements('eip155:8453'));
      expect(response.body.errorReason).not.toBe('permit_signature_invalid');
    }
  });
});

describe('gas-estimation errors are categorized, not dumped into `failed`', () => {
  // Estimation simulates permit(). A revert there is the client's permit being
  // bad, not a facilitator fault — but it returned early under the catch-all
  // `failed` label, feeding the settle alert.
  //
  // Verified against production 2026-08-26: a well-formed but cryptographically
  // invalid signature returned
  //   gas_estimation_failed: ... reverted ... ECDSA: invalid signature
  const { categorizeSettleError } = require('../routes/settle') as any;

  it('classifies a viem ECDSA revert as invalid_signature, not tx_reverted', () => {
    // Real production message shape — contains BOTH "reverted" and "ECDSA",
    // so branch order decides the label.
    const err = {
      message: 'The contract function "permit" reverted with the following reason:\nECDSA: invalid signature',
      shortMessage: 'The contract function "permit" reverted.',
    };
    expect(categorizeSettleError(err).errorCategory).toBe('invalid_signature');
    expect(categorizeSettleError(err).errorReason).toBe('permit_signature_invalid');
  });

  it('still classifies a plain revert as tx_reverted', () => {
    const err = { message: 'execution reverted: ERC20: transfer amount exceeds balance', shortMessage: '' };
    expect(categorizeSettleError(err).errorCategory).toBe('tx_reverted');
  });

  it('classifies RPC failures as rpc_error (facilitator fault)', () => {
    expect(categorizeSettleError({ message: 'fetch failed' }).errorCategory).toBe('rpc_error');
    expect(categorizeSettleError({ message: 'connect ETIMEDOUT' }).errorCategory).toBe('rpc_error');
  });

  it('falls back to unknown for an unrecognized message', () => {
    expect(categorizeSettleError({ message: 'something nobody has seen' }).errorCategory).toBe('unknown');
  });
});
