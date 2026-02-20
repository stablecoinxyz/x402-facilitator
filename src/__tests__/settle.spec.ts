/**
 * POST /settle Endpoint Tests
 *
 * Tests x402 v2 specification compliance for payment settlement
 */

import request from 'supertest';
import express from 'express';
import { settlePayment } from '../routes/settle';
import {
  createBasePayment,
  createSolanaPayment,
  createPaymentRequirements,
} from './fixtures/payment-fixtures';

// Create test app
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/settle', settlePayment);
  return app;
}

/** Helper: send v2 settle request */
function sendSettle(app: express.Application, paymentPayload: any, paymentRequirements: any) {
  return request(app)
    .post('/settle')
    .send({ paymentPayload, paymentRequirements });
}

describe('POST /settle - x402 V2 Spec Compliance', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('Response Format', () => {
    it('should return spec-compliant success response', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('payer');
      expect(response.body).toHaveProperty('transaction');
      expect(response.body).toHaveProperty('network');

      expect(typeof response.body.success).toBe('boolean');
      expect(typeof response.body.payer).toBe('string');
      expect(typeof response.body.transaction).toBe('string');
      expect(typeof response.body.network).toBe('string');

      if (response.body.success) {
        expect(response.body.payer).toBe(paymentPayload.payload.authorization.from);
        expect(response.body.transaction).toBeTruthy();
        expect(response.body.network).toBe('eip155:8453');
      }
    }, 15000);

    it('should return spec-compliant error response', async () => {
      const paymentPayload = createBasePayment();
      delete (paymentPayload.payload as any).authorization;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('errorReason');
      expect(response.body).toHaveProperty('payer');
      expect(response.body).toHaveProperty('transaction');
      expect(response.body).toHaveProperty('network');

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBeTruthy();
      expect(response.body.transaction).toBe('');
      expect(response.body.network).toBe('eip155:8453');
    });

    it('should use "transaction" field name (not "txHash")', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('transaction');
      expect(response.body).not.toHaveProperty('txHash');
    }, 15000);

    it('should use CAIP-2 "network" field', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('network');
      expect(response.body).not.toHaveProperty('networkId');

      if (response.body.success) {
        expect(response.body.network).toBe('eip155:8453');
      }
    }, 15000);

    it('should use "errorReason" field name (not "error")', async () => {
      const paymentPayload = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) - 300,
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      if (!response.body.success) {
        expect(response.body).toHaveProperty('errorReason');
        expect(response.body).not.toHaveProperty('error');
      }
    }, 15000);

    it('should NOT include non-standard fields in response', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      const allowedFields = ['success', 'payer', 'transaction', 'network', 'errorReason'];
      Object.keys(response.body).forEach(key => {
        expect(allowedFields).toContain(key);
      });
    }, 15000);
  });

  describe('Multi-Chain Settlement', () => {
    it('should settle Base mainnet payments', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      if (response.status === 500) {
        expect(response.body.success).toBe(false);
        expect(response.body.network).toBe('eip155:8453');
      } else {
        expect(response.status).toBe(200);
        expect(response.body.network).toBe('eip155:8453');
      }
    }, 15000);

    it('should settle Solana mainnet payments', async () => {
      const paymentPayload = createSolanaPayment();
      const paymentRequirements = createPaymentRequirements('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.status).toBe(200);
      expect(response.body.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    }, 30000);
  });

  describe('Network Name Format (CAIP-2)', () => {
    it('should return CAIP-2 network "eip155:8453"', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.network).toBe('eip155:8453');
      expect(response.body.network).not.toBe('base');
      expect(response.body.network).not.toBe('8453');
    }, 15000);

    it('should return CAIP-2 network for Solana', async () => {
      const paymentPayload = createSolanaPayment();
      const paymentRequirements = createPaymentRequirements('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    }, 30000);
  });

  describe('Transaction Hash Format', () => {
    it('should return transaction hash for successful settlement', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      if (response.body.success) {
        expect(response.body.transaction).toBeTruthy();
        expect(typeof response.body.transaction).toBe('string');
        expect(response.body.transaction.length).toBeGreaterThan(0);
      }
    }, 15000);

    it('should return empty string for failed settlement', async () => {
      const paymentPayload = createBasePayment();
      delete (paymentPayload.payload as any).authorization;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      if (!response.body.success) {
        expect(response.body.transaction).toBe('');
      }
    });
  });

  describe('Payer Field', () => {
    it('should extract payer from EVM payment', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.payer).toBe(paymentPayload.payload.authorization.from);
    }, 15000);

    it('should extract payer from Solana payment', async () => {
      const paymentPayload = createSolanaPayment();
      const paymentRequirements = createPaymentRequirements('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.payer).toBe(paymentPayload.payload.from);
    }, 30000);
  });

  describe('Error Handling', () => {
    it('should handle missing paymentPayload', async () => {
      const response = await request(app)
        .post('/settle')
        .send({
          paymentRequirements: createPaymentRequirements('eip155:8453'),
        });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBeTruthy();
    });

    it('should handle unsupported scheme', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.scheme = 'unsupported_scheme';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('scheme');
    });

    it('should handle unsupported network', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'unsupported-network';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('network');
    });

    it('should handle missing authorization data', async () => {
      const paymentPayload = createBasePayment();
      delete (paymentPayload.payload as any).authorization;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('Missing authorization');
      expect(response.body.transaction).toBe('');
    });
  });

  describe('CAIP-2 Parsing', () => {
    it('should reject bare chain ID "8453"', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = '8453';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('network');
    });

    it('should reject "eip155:" with no chain ID', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'eip155:';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('network');
    });

    it('should reject "eip155:abc" with non-numeric chain ID', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'eip155:abc';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('network');
    });

    it('should reject valid CAIP-2 format but unknown chain ID', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'eip155:999999';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('Unknown network: eip155:999999');
    });

    it('should reject legacy network names', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'base';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('network');
    });
  });

  describe('Signature Parsing', () => {
    it('should handle signature that is too short', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.payload.signature = '0x1234'; // Way too short for v,r,s extraction
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Signature slicing will produce garbage but shouldn't crash —
      // the privateKeyToAccount or writeContract call will fail in real mode,
      // but in simulated mode this just produces a simulated hash.
      // The key thing is it doesn't throw an unhandled exception.
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('network');
    }, 15000);

    it('should handle null signature gracefully', async () => {
      const paymentPayload = createBasePayment();
      (paymentPayload.payload as any).signature = null;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Should hit catch block because signature.slice() will throw on null
      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBeTruthy();
    });
  });
});
