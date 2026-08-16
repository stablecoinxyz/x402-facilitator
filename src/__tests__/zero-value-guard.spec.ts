/**
 * Zero-Value & Self-Payment Guard Tests
 *
 * The facilitator must reject zero-value and self-directed payments before any
 * signature check or on-chain work. Otherwise an unauthenticated caller can force
 * it to pay gas for useless 0-value / self transfers (EVM + Solana).
 */

import request from 'supertest';
import express from 'express';
import { verifyPayment } from '../routes/verify';
import { settlePayment } from '../routes/settle';
import {
  createBasePayment,
  createSolanaPayment,
  createPaymentRequirements,
} from './fixtures/payment-fixtures';

// Mock viem so a *valid* payment can pass the guard and reach the signature check.
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

function appWith(handler: express.RequestHandler, path: string) {
  const app = express();
  app.use(express.json());
  app.post(path, handler);
  return app;
}

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const;

describe('Zero-value & self-payment guard', () => {
  describe('EVM /verify', () => {
    it('rejects a zero-requirement payment (maxAmountRequired = 0)', async () => {
      const res = await request(appWith(verifyPayment, '/verify'))
        .post('/verify')
        .send({
          paymentPayload: createBasePayment({ amount: '0' }),
          paymentRequirements: { ...createPaymentRequirements('eip155:8453'), amount: '0' },
        });
      expect(res.body.isValid).toBe(false);
      expect(res.body.invalidReason).toBe('invalid_amount');
    });

    it('rejects a self-payment (from == payTo)', async () => {
      const payload = createBasePayment();
      const res = await request(appWith(verifyPayment, '/verify'))
        .post('/verify')
        .send({
          paymentPayload: payload,
          paymentRequirements: {
            ...createPaymentRequirements('eip155:8453'),
            payTo: payload.payload.authorization.from,
          },
        });
      expect(res.body.isValid).toBe(false);
      expect(res.body.invalidReason).toBe('invalid_self_payment');
    });

    it('does NOT reject a normal nonzero payment at the guard', async () => {
      const res = await request(appWith(verifyPayment, '/verify'))
        .post('/verify')
        .send({
          paymentPayload: createBasePayment(),
          paymentRequirements: createPaymentRequirements('eip155:8453'),
        });
      expect(res.body.invalidReason).not.toBe('invalid_amount');
      expect(res.body.invalidReason).not.toBe('invalid_self_payment');
    });
  });

  describe('EVM /settle', () => {
    it('rejects a zero-value settlement', async () => {
      const res = await request(appWith(settlePayment, '/settle'))
        .post('/settle')
        .send({
          paymentPayload: createBasePayment({ amount: '0' }),
          paymentRequirements: { ...createPaymentRequirements('eip155:8453'), amount: '0' },
        });
      expect(res.body.success).toBe(false);
      expect(res.body.errorReason).toBe('invalid_amount');
    });
  });

  describe('Solana /verify', () => {
    it('rejects a zero-value payment', async () => {
      const res = await request(appWith(verifyPayment, '/verify'))
        .post('/verify')
        .send({
          paymentPayload: createSolanaPayment({ amount: '0' }),
          paymentRequirements: { ...createPaymentRequirements(SOLANA), amount: '0' },
        });
      expect(res.body.isValid).toBe(false);
      expect(res.body.invalidReason).toBe('invalid_amount');
    });
  });

  describe('Solana /settle', () => {
    it('rejects a zero-value settlement', async () => {
      const res = await request(appWith(settlePayment, '/settle'))
        .post('/settle')
        .send({
          paymentPayload: createSolanaPayment({ amount: '0' }),
          paymentRequirements: { ...createPaymentRequirements(SOLANA), amount: '0' },
        });
      expect(res.body.success).toBe(false);
      expect(res.body.errorReason).toBe('invalid_amount');
    });
  });
});
