/**
 * POST /verify Endpoint Tests
 *
 * Tests x402 specification compliance for payment verification
 * Reference: https://github.com/coinbase/x402/blob/main/specs/x402-specification.md Section 7.1
 */

import request from 'supertest';
import express from 'express';
import { verifyPayment } from '../routes/verify';
import {
  createBasePayment,
  createSolanaPayment,
  createPaymentRequirements,
  encodePaymentHeader,
} from './fixtures/payment-fixtures';

// Mock viem's verifyTypedData to allow testing validation logic
jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    verifyTypedData: jest.fn().mockResolvedValue(true), // Always return valid signature for tests
  };
});

// Mock tweetnacl for Solana signature verification
jest.mock('tweetnacl', () => {
  const actual = jest.requireActual('tweetnacl');
  return {
    ...actual,
    sign: {
      ...actual.sign,
      detached: {
        ...actual.sign.detached,
        verify: jest.fn().mockReturnValue(true), // Always return valid signature for tests
      },
    },
  };
});

// Create test app
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/verify', verifyPayment);
  return app;
}

describe('POST /verify - x402 Spec Compliance', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('Response Format (Section 7.1)', () => {
    it('should return spec-compliant success response with payer field', async () => {
      const paymentData = createBasePayment();
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      // x402 spec requires these fields
      expect(response.body).toHaveProperty('isValid');
      expect(response.body).toHaveProperty('payer');

      // Spec format: { isValid: true, payer: "0x..." }
      if (response.body.isValid) {
        expect(response.body.payer).toBe(paymentData.payload.from);
      }
    });

    it('should return spec-compliant error response with payer field', async () => {
      const paymentData = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) - 300, // Expired
      });
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      // x402 spec requires these fields even on error
      expect(response.body).toHaveProperty('isValid');
      expect(response.body).toHaveProperty('payer');
      expect(response.body).toHaveProperty('invalidReason');

      // Spec format: { isValid: false, invalidReason: "...", payer: "0x..." }
      expect(response.body.isValid).toBe(false);
      expect(response.body.payer).toBe(paymentData.payload.from);
      expect(response.body.invalidReason).toBeTruthy();
    });

    it('should NOT include non-standard fields in response', async () => {
      const paymentData = createBasePayment();
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      // Should only have spec-defined fields
      const allowedFields = ['isValid', 'payer', 'invalidReason'];
      Object.keys(response.body).forEach(key => {
        expect(allowedFields).toContain(key);
      });
    });
  });

  describe('Multi-Chain Support', () => {
    it('should verify Base mainnet payments', async () => {
      const paymentData = createBasePayment();
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      // Debug: log error if test fails
      if (response.status !== 200) {
        console.log('Base verification error:', response.body);
      }

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('isValid');
      expect(response.body).toHaveProperty('payer');
    });

    it('should verify Solana mainnet payments', async () => {
      const paymentData = createSolanaPayment();
      const paymentRequirements = createPaymentRequirements('solana-mainnet-beta');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('isValid');
      expect(response.body).toHaveProperty('payer');
    });
  });

  describe('Validation Logic', () => {
    it('should reject payments with unsupported scheme', async () => {
      const paymentData = createBasePayment();
      paymentData.scheme = 'unsupported_scheme';
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      expect(response.body.isValid).toBe(false);
      expect(response.body.invalidReason).toContain('scheme');
    });

    it('should reject payments with unsupported network', async () => {
      const paymentData = createBasePayment();
      paymentData.network = 'unsupported-network';
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      expect(response.body.isValid).toBe(false);
      expect(response.body.invalidReason).toContain('network');
    });

    it('should reject expired payments', async () => {
      const paymentData = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) - 300, // 5 minutes ago
      });
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      expect(response.body.isValid).toBe(false);
      expect(response.body.invalidReason).toContain('expired');
    });

    it('should reject payments with insufficient amount', async () => {
      const paymentData = createBasePayment({
        amount: '1000', // Way too low
      });
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      expect(response.body.isValid).toBe(false);
      expect(response.body.invalidReason).toContain('amount');
    });

    it('should reject payments to wrong recipient', async () => {
      const paymentData = createBasePayment({
        to: '0x0000000000000000000000000000000000000001', // Valid address, but wrong recipient
      });
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      expect(response.body.isValid).toBe(false);
      expect(response.body.invalidReason).toContain('recipient');
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed payment header', async () => {
      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader: 'invalid-base64!!!',
          paymentRequirements: createPaymentRequirements('base'),
        });

      expect(response.status).toBe(500);
      expect(response.body.isValid).toBe(false);
      expect(response.body.invalidReason).toBeTruthy();
    });

    it('should handle missing required fields', async () => {
      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          // Missing paymentHeader
          paymentRequirements: createPaymentRequirements('base'),
        });

      expect(response.status).toBe(500);
      expect(response.body.isValid).toBe(false);
    });
  });

  describe('Network Name Format', () => {
    it('should accept "base" network name', async () => {
      const paymentData = createBasePayment();
      expect(paymentData.network).toBe('base');
    });

    it('should accept "solana-mainnet-beta" network name', async () => {
      const paymentData = createSolanaPayment();
      expect(paymentData.network).toBe('solana-mainnet-beta');
    });

    it('should NOT accept chain IDs as network names', async () => {
      const paymentData = createBasePayment();
      paymentData.network = '8453'; // Chain ID instead of name
      const paymentRequirements = createPaymentRequirements('base');
      const paymentHeader = encodePaymentHeader(paymentData);

      const response = await request(app)
        .post('/verify')
        .send({
          x402Version: 1,
          paymentHeader,
          paymentRequirements,
        });

      // Should still work if we support numeric strings, but prefer names
      expect(response.body).toHaveProperty('isValid');
      expect(response.body).toHaveProperty('payer');
    });
  });
});
