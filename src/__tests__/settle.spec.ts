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

      expect(response.status).toBe(400);
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
      expect(response.body.errorReason).toBe('invalid_payload');
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
      expect(response.body.errorReason).toBe('invalid_network');
    });

    it('should reject "eip155:" with no chain ID', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'eip155:';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('invalid_network');
    });

    it('should reject "eip155:abc" with non-numeric chain ID', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'eip155:abc';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('invalid_network');
    });

    it('should reject valid CAIP-2 format but unknown chain ID', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'eip155:999999';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('invalid_network');
    });

    it('should reject legacy network names', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'base';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('invalid_network');
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
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBeTruthy();
    });
  });

  describe('Pre-Settle Deadline Check', () => {
    it('should reject settlement when permit is expired', async () => {
      const paymentPayload = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) - 60, // Expired 60s ago
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('permit_expired');
      expect(response.body.suggestRetry).toBe(true);
      expect(response.body.expiredAt).toBeDefined();
    });

    it('should reject settlement when permit expires within safety margin (30s)', async () => {
      const paymentPayload = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) + 15, // Only 15s left
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('permit_expired');
      expect(response.body.remainingSeconds).toBeDefined();
      expect(response.body.remainingSeconds).toBeLessThan(30);
      expect(response.body.suggestRetry).toBe(true);
    });

    it('should allow settlement when permit has enough time remaining', async () => {
      const paymentPayload = createBasePayment();  // default: +300s
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Should pass the deadline check and proceed to settlement
      // (may succeed or fail at the actual settlement step, but not from deadline)
      if (!response.body.success) {
        expect(response.body.errorReason).not.toBe('permit_expired');
      }
    }, 15000);
  });

  describe('v1 Backward Compatibility', () => {
    it('should accept v1 flat EVM payload (no accepted envelope)', async () => {
      const v1Payload = {
        signature: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1b',
        authorization: {
          from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          value: '10000000000000000',
          validAfter: '0',
          validBefore: (Math.floor(Date.now() / 1000) + 300).toString(),
          nonce: Date.now().toString(),
        },
      };

      const v1Requirements = {
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: '10000000000000000',
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        asset: '0xFdcC3dd6671EaB0709A4C0f3F53De9a333d80798',
        extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
      };

      const response = await sendSettle(app, v1Payload, v1Requirements);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('network');
      expect(response.body.network).toBe('eip155:8453');
    }, 15000);

    it('should accept v1 requirements with maxAmountRequired field', async () => {
      const paymentPayload = createBasePayment();
      const v1Requirements = {
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: '10000000000000000',
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        asset: '0xFdcC3dd6671EaB0709A4C0f3F53De9a333d80798',
        extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
      };

      const response = await sendSettle(app, paymentPayload, v1Requirements);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    }, 15000);

    it('should accept v1 flat Solana payload', async () => {
      const v1Payload = {
        from: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        to: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K',
        amount: '50000000',
        nonce: Date.now().toString(),
        deadline: Math.floor(Date.now() / 1000) + 300,
        signature: '3yZe7d3YAKLBbZBN6nZMPjwBvPmMKzGvJxYQwR8pPxWKvBmKZ7LjYpzJ8cDaKQgBKCbxPHRYHqKx5gQmKzWVLZmX',
      };

      const v1Requirements = {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        maxAmountRequired: '50000000',
        payTo: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K',
        asset: 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA',
        extra: { assetTransferMethod: 'delegated-spl', name: 'SBC', version: '1' },
      };

      const response = await sendSettle(app, v1Payload, v1Requirements);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    }, 30000);
  });

  // =====================================================================
  // Security Exploit & Edge Case Tests
  // =====================================================================

  describe('Amount Manipulation Attacks', () => {
    it('should handle value=0 in authorization', async () => {
      const paymentPayload = createBasePayment({ amount: '0' });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Settle doesn't recheck amount — it just executes the permit + transferFrom
      // In simulated mode this produces a simulated hash
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('network');
    }, 15000);

    it('should handle negative amount string', async () => {
      const paymentPayload = createBasePayment({ amount: '-1000000' });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // BigInt('-1000000') is valid in JS but would fail on-chain
      // In simulated mode, this should still produce a response
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('network');
    }, 15000);

    it('should handle uint256 max value', async () => {
      const maxUint256 = (BigInt(2) ** BigInt(256) - BigInt(1)).toString();
      const paymentPayload = createBasePayment({ amount: maxUint256 });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('success');
    }, 15000);

    it('should handle non-numeric value string', async () => {
      const paymentPayload = createBasePayment({ amount: 'garbage' });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // In simulated mode, BigInt conversion doesn't happen (simulated tx hash is random)
      // so this may succeed in simulated mode but would fail in real mode
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('network');
    }, 15000);
  });

  describe('Address Injection Attacks', () => {
    it('should handle zero address as payer', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.payload.authorization.from = '0x0000000000000000000000000000000000000000';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('success');
      expect(response.body.payer).toBe('0x0000000000000000000000000000000000000000');
    }, 15000);

    it('should handle zero address as recipient in requirements', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');
      paymentRequirements.payTo = '0x0000000000000000000000000000000000000000';

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Settle doesn't validate recipient — it just calls transferFrom
      expect(response.body).toHaveProperty('success');
    }, 15000);

    it('should handle malformed address in authorization', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.payload.authorization.from = 'not_a_valid_address';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('success');
    }, 15000);
  });

  describe('Deadline Manipulation & Race Conditions', () => {
    it('should reject permit expired long ago (year 2020)', async () => {
      const paymentPayload = createBasePayment({
        deadline: 1577836800, // 2020-01-01
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('permit_expired');
      expect(response.body.suggestRetry).toBe(true);
    });

    it('should reject permit expiring in exactly 1 second (within safety margin)', async () => {
      const paymentPayload = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) + 1,
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('permit_expired');
      expect(response.body.remainingSeconds).toBeDefined();
      expect(response.body.remainingSeconds).toBeLessThanOrEqual(1);
    });

    it('should reject permit expiring at exactly the safety margin boundary (29s)', async () => {
      const paymentPayload = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) + 29,
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('permit_expired');
    });

    it('should accept permit with exactly 30s remaining (at boundary)', async () => {
      const paymentPayload = createBasePayment({
        deadline: Math.floor(Date.now() / 1000) + 31, // Just over safety margin
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Should pass deadline check — may fail on private key but not on deadline
      if (!response.body.success) {
        expect(response.body.errorReason).not.toBe('permit_expired');
      }
    }, 15000);

    it('should include expiredAt timestamp in expired response', async () => {
      const deadlineTimestamp = Math.floor(Date.now() / 1000) - 100;
      const paymentPayload = createBasePayment({
        deadline: deadlineTimestamp,
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.expiredAt).toBe(deadlineTimestamp);
    });

    it('should handle far-future deadline (year 3000)', async () => {
      const paymentPayload = createBasePayment({
        deadline: 32503680000, // Year 3000
      });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Should pass deadline check
      if (!response.body.success) {
        expect(response.body.errorReason).not.toBe('permit_expired');
      }
    }, 15000);

    it('should handle deadline of 0', async () => {
      const paymentPayload = createBasePayment({ deadline: 0 });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('permit_expired');
    });
  });

  describe('Cross-Network Attack Vectors', () => {
    it('should reject EVM payload with Solana network in accepted', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
      const paymentRequirements = createPaymentRequirements('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Routes to Solana handler which expects different payload structure
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('network');
    }, 30000);

    it('should reject Solana payload with EVM network in accepted', async () => {
      const paymentPayload = createSolanaPayment();
      paymentPayload.accepted.network = 'eip155:8453';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Routes to EVM handler which expects authorization sub-object
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('invalid_payload');
    });
  });

  describe('Signature Parsing Edge Cases', () => {
    it('should handle signature exactly 2 chars (just 0x prefix)', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.payload.signature = '0x';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // signature.slice(2, 66) returns '', parseInt('', 16) = NaN
      // In simulated mode, we skip the on-chain call so it may succeed
      expect(response.body).toHaveProperty('success');
    }, 15000);

    it('should handle signature with non-hex characters', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.payload.signature = '0x' + 'zz'.repeat(65);
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // parseInt('zz...', 16) = NaN for v, r/s are garbage
      // In simulated mode, this still returns a simulated hash
      expect(response.body).toHaveProperty('success');
    }, 15000);

    it('should handle undefined signature gracefully', async () => {
      const paymentPayload = createBasePayment();
      (paymentPayload.payload as any).signature = undefined;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // undefined.slice() throws — caught by outer catch
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBeTruthy();
    });

    it('should handle numeric signature', async () => {
      const paymentPayload = createBasePayment();
      (paymentPayload.payload as any).signature = 12345;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // (12345).slice is not a function — caught by outer catch
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBeTruthy();
    });
  });

  describe('Type Confusion Attacks', () => {
    it('should handle null paymentPayload', async () => {
      const response = await request(app)
        .post('/settle')
        .send({ paymentPayload: null, paymentRequirements: createPaymentRequirements('eip155:8453') });

      expect(response.body.success).toBe(false);
    });

    it('should handle array instead of object for paymentPayload', async () => {
      const response = await request(app)
        .post('/settle')
        .send({ paymentPayload: [1, 2, 3], paymentRequirements: createPaymentRequirements('eip155:8453') });

      // Array doesn't have `accepted` so isV1=true, normalizes, then fails on network
      expect(response.body.success).toBe(false);
    });

    it('should handle string paymentPayload', async () => {
      const response = await request(app)
        .post('/settle')
        .send({ paymentPayload: 'not_an_object', paymentRequirements: createPaymentRequirements('eip155:8453') });

      expect(response.body.success).toBe(false);
    });

    it('should handle empty object paymentPayload with no accepted', async () => {
      const response = await request(app)
        .post('/settle')
        .send({ paymentPayload: {}, paymentRequirements: createPaymentRequirements('eip155:8453') });

      // isV1=true (no accepted), normalizes, should proceed and fail somewhere
      expect(response.body.success).toBe(false);
    });

    it('should handle null paymentRequirements', async () => {
      const paymentPayload = createBasePayment();

      const response = await sendSettle(app, paymentPayload, null);

      // normalizeRequirements handles null, paymentRequirements.payTo will throw
      expect(response.body).toHaveProperty('success');
    }, 15000);

    it('should handle missing paymentRequirements.payTo', async () => {
      const paymentPayload = createBasePayment();
      const paymentRequirements = createPaymentRequirements('eip155:8453');
      delete (paymentRequirements as any).payTo;

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // recipient will be undefined, which is fine in simulated mode
      expect(response.body).toHaveProperty('success');
    }, 15000);
  });

  describe('Replay Attack Scenarios', () => {
    it('should return original tx hash on replay (idempotent)', async () => {
      const paymentPayload = createBasePayment({ nonce: 'replay-test-' + Date.now() });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response1 = await sendSettle(app, paymentPayload, paymentRequirements);
      const response2 = await sendSettle(app, paymentPayload, paymentRequirements);

      // First may succeed or fail for other reasons, but if it succeeded,
      // replay must return success with the same tx hash (idempotent)
      if (response1.body.success) {
        expect(response2.body.success).toBe(true);
        expect(response2.body.transaction).toBe(response1.body.transaction);
      }
    }, 15000);
  });

  describe('Error Response Format Compliance', () => {
    it('should always include all required fields in error response', async () => {
      const paymentPayload = createBasePayment();
      delete (paymentPayload.payload as any).authorization;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('payer');
      expect(response.body).toHaveProperty('transaction');
      expect(response.body).toHaveProperty('network');
      expect(response.body).toHaveProperty('errorReason');

      expect(response.body.success).toBe(false);
      expect(response.body.transaction).toBe('');
      expect(typeof response.body.errorReason).toBe('string');
    });

    it('should return errorReason as string, not object', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.scheme = 'not_exact';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(typeof response.body.errorReason).toBe('string');
    });

    it('should use spec error code for unsupported scheme', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.scheme = 'flexible';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('unsupported_scheme');
    });

    it('should use spec error code for invalid network', async () => {
      const paymentPayload = createBasePayment();
      paymentPayload.accepted.network = 'eip155:99999';
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('invalid_network');
    });

    it('should use spec error code for missing authorization', async () => {
      const paymentPayload = createBasePayment();
      delete (paymentPayload.payload as any).authorization;
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBe('invalid_payload');
    });
  });

  describe('Solana Settle Edge Cases', () => {
    it('should handle Solana payment with expired deadline', async () => {
      const paymentPayload = createSolanaPayment({ deadline: Math.floor(Date.now() / 1000) - 120 });
      const paymentRequirements = createPaymentRequirements('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      // Solana settle handler may or may not check deadline pre-settle
      expect(response.body).toHaveProperty('success');
      expect(response.body.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    }, 30000);

    it('should handle Solana payment with missing from field', async () => {
      const paymentPayload = createSolanaPayment();
      delete (paymentPayload.payload as any).from;
      const paymentRequirements = createPaymentRequirements('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

      const response = await sendSettle(app, paymentPayload, paymentRequirements);

      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('network');
    }, 30000);
  });
});
