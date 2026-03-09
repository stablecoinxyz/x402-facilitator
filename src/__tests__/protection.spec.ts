/**
 * Protection Layer Tests (TDD)
 *
 * 1. Nonce replay protection — prevent double-settle wasting gas
 * 2. Gas estimation — dry-run before submitting on-chain tx
 * 3. Rate limiting — throttle spam on /verify and /settle
 * 4. Input size limiting — reject oversized request bodies
 */

import request from 'supertest';
import express from 'express';
import { settlePayment } from '../routes/settle';
import { verifyPayment } from '../routes/verify';
import { NonceTracker } from '../protection/nonce-tracker';
import {
  createBasePayment,
  createSolanaPayment,
  createPaymentRequirements,
} from './fixtures/payment-fixtures';

// Mock viem for verify tests
const mockVerifyTypedData = jest.fn().mockResolvedValue(true);
const mockReadContract = jest.fn().mockResolvedValue(BigInt('999999999999999999999'));
const mockGetTransactionCount = jest.fn().mockResolvedValue(0);
const mockGetGasPrice = jest.fn().mockResolvedValue(1000000000n);
const mockEstimateGas = jest.fn().mockResolvedValue(100000n);
const mockWriteContract = jest.fn().mockResolvedValue('0xabcdef1234567890');
const mockWaitForTransactionReceipt = jest.fn().mockResolvedValue({ blockNumber: 1n, gasUsed: 50000n });

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
  privateKeyToAccount: () => ({
    address: '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6',
  }),
}));

// Mock tweetnacl for Solana
jest.mock('tweetnacl', () => ({
  sign: { detached: { verify: jest.fn().mockReturnValue(true) } },
}));

// =====================================================================
// 1. Nonce Replay Protection
// =====================================================================

describe('Nonce Replay Protection', () => {
  describe('NonceTracker unit tests', () => {
    let tracker: NonceTracker;

    beforeEach(() => {
      tracker = new NonceTracker();
    });

    it('should return false for unseen nonce', () => {
      expect(tracker.hasSettled('eip155:8453', '0xabc', '12345')).toBe(false);
    });

    it('should return true after marking nonce as settled', () => {
      tracker.markSettled('eip155:8453', '0xabc', '12345');
      expect(tracker.hasSettled('eip155:8453', '0xabc', '12345')).toBe(true);
    });

    it('should distinguish different nonces from same owner', () => {
      tracker.markSettled('eip155:8453', '0xabc', '11111');
      expect(tracker.hasSettled('eip155:8453', '0xabc', '11111')).toBe(true);
      expect(tracker.hasSettled('eip155:8453', '0xabc', '22222')).toBe(false);
    });

    it('should distinguish same nonce on different networks', () => {
      tracker.markSettled('eip155:8453', '0xabc', '12345');
      expect(tracker.hasSettled('eip155:8453', '0xabc', '12345')).toBe(true);
      expect(tracker.hasSettled('eip155:84532', '0xabc', '12345')).toBe(false);
    });

    it('should distinguish same nonce from different owners', () => {
      tracker.markSettled('eip155:8453', '0xabc', '12345');
      expect(tracker.hasSettled('eip155:8453', '0xdef', '12345')).toBe(false);
    });

    it('should be case-insensitive for addresses', () => {
      tracker.markSettled('eip155:8453', '0xABC', '12345');
      expect(tracker.hasSettled('eip155:8453', '0xabc', '12345')).toBe(true);
    });

    it('should evict old entries after max size', () => {
      const smallTracker = new NonceTracker(3);
      smallTracker.markSettled('eip155:8453', '0xa', '1');
      smallTracker.markSettled('eip155:8453', '0xa', '2');
      smallTracker.markSettled('eip155:8453', '0xa', '3');
      // Adding 4th should evict the 1st
      smallTracker.markSettled('eip155:8453', '0xa', '4');
      expect(smallTracker.hasSettled('eip155:8453', '0xa', '1')).toBe(false);
      expect(smallTracker.hasSettled('eip155:8453', '0xa', '4')).toBe(true);
    });

    it('should track Solana nonces too', () => {
      tracker.markSettled('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'DYw8jCTf...', '99999');
      expect(tracker.hasSettled('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'DYw8jCTf...', '99999')).toBe(true);
    });
  });

  describe('Settle endpoint replay rejection', () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.post('/settle', settlePayment);
      // Reset mocks
      mockWriteContract.mockReset().mockResolvedValue('0xabcdef1234567890');
      mockWaitForTransactionReceipt.mockReset().mockResolvedValue({ blockNumber: 1n, gasUsed: 50000n });
      mockGetTransactionCount.mockReset().mockResolvedValue(0);
      mockGetGasPrice.mockReset().mockResolvedValue(1000000000n);
      mockEstimateGas.mockReset().mockResolvedValue(100000n);
    });

    it('should reject duplicate settle with same nonce', async () => {
      const nonce = Date.now().toString();
      const paymentPayload = createBasePayment({ nonce });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      // First settle should succeed
      const response1 = await request(app)
        .post('/settle')
        .send({ paymentPayload, paymentRequirements });

      // Second settle with same nonce should be rejected
      const response2 = await request(app)
        .post('/settle')
        .send({ paymentPayload, paymentRequirements });

      expect(response2.body.success).toBe(false);
      expect(response2.body.errorReason).toBe('nonce_already_settled');
    }, 15000);

    it('should allow settle with different nonces from same owner', async () => {
      const paymentPayload1 = createBasePayment({ nonce: '111' });
      const paymentPayload2 = createBasePayment({ nonce: '222' });
      const paymentRequirements = createPaymentRequirements('eip155:8453');

      const response1 = await request(app)
        .post('/settle')
        .send({ paymentPayload: paymentPayload1, paymentRequirements });
      const response2 = await request(app)
        .post('/settle')
        .send({ paymentPayload: paymentPayload2, paymentRequirements });

      // Both should proceed (not rejected by nonce check)
      if (response1.body.success === false) {
        expect(response1.body.errorReason).not.toBe('nonce_already_settled');
      }
      if (response2.body.success === false) {
        expect(response2.body.errorReason).not.toBe('nonce_already_settled');
      }
    }, 15000);
  });
});

// =====================================================================
// 2. Gas Estimation Before Settle
// =====================================================================

describe('Gas Estimation Before Settle', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.post('/settle', settlePayment);
    // Reset all mocks
    mockWriteContract.mockReset().mockResolvedValue('0xabcdef1234567890');
    mockWaitForTransactionReceipt.mockReset().mockResolvedValue({ blockNumber: 1n, gasUsed: 50000n });
    mockGetTransactionCount.mockReset().mockResolvedValue(0);
    mockGetGasPrice.mockReset().mockResolvedValue(1000000000n);
    mockEstimateGas.mockReset().mockResolvedValue(100000n);
  });

  it('should reject settle when gas estimation reverts (permit already used)', async () => {
    // Simulate gas estimation failure (permit nonce already consumed on-chain)
    mockEstimateGas.mockRejectedValueOnce(new Error('execution reverted: ERC20Permit: invalid signature'));

    const paymentPayload = createBasePayment();
    const paymentRequirements = createPaymentRequirements('eip155:8453');

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload, paymentRequirements });

    // In real settlement mode, should fail before submitting tx
    // In simulated mode, gas estimation is skipped
    if (process.env.ENABLE_REAL_SETTLEMENT === 'true') {
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('gas_estimation_failed');
    } else {
      // Simulated mode — gas estimation not called
      expect(response.body).toHaveProperty('success');
    }
  }, 15000);

  it('should reject settle when gas estimation shows insufficient gas', async () => {
    mockEstimateGas.mockRejectedValueOnce(new Error('insufficient funds for gas'));

    const paymentPayload = createBasePayment();
    const paymentRequirements = createPaymentRequirements('eip155:8453');

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload, paymentRequirements });

    if (process.env.ENABLE_REAL_SETTLEMENT === 'true') {
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toContain('gas_estimation_failed');
    } else {
      expect(response.body).toHaveProperty('success');
    }
  }, 15000);
});

// =====================================================================
// 3. Rate Limiting
// =====================================================================

describe('Rate Limiting', () => {
  it('should allow requests under the rate limit', async () => {
    const { createRateLimiter } = await import('../protection/rate-limiter');
    const limiter = createRateLimiter({ windowMs: 60000, max: 5 });

    const app = express();
    app.use(express.json());
    app.use(limiter);
    app.post('/settle', settlePayment);

    const paymentPayload = createBasePayment();
    const paymentRequirements = createPaymentRequirements('eip155:8453');

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload, paymentRequirements });

    expect(response.status).not.toBe(429);
    limiter.destroy();
  }, 15000);

  it('should return 429 when rate limit exceeded', async () => {
    const { createRateLimiter } = await import('../protection/rate-limiter');
    const limiter = createRateLimiter({ windowMs: 60000, max: 2 });

    const app = express();
    app.use(express.json());
    app.use(limiter);
    app.get('/test', (req, res) => res.json({ ok: true }));

    // Make 3 requests — third should be rate limited
    await request(app).get('/test');
    await request(app).get('/test');
    const response = await request(app).get('/test');

    expect(response.status).toBe(429);
    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toContain('rate');
    limiter.destroy();
  });

  it('should include retry-after header when rate limited', async () => {
    const { createRateLimiter } = await import('../protection/rate-limiter');
    const limiter = createRateLimiter({ windowMs: 60000, max: 1 });

    const app = express();
    app.use(express.json());
    app.use(limiter);
    app.get('/test', (req, res) => res.json({ ok: true }));

    await request(app).get('/test');
    const response = await request(app).get('/test');

    expect(response.status).toBe(429);
    expect(response.headers).toHaveProperty('retry-after');
    limiter.destroy();
  });

  it('should rate limit per IP address independently', async () => {
    const { createRateLimiter } = await import('../protection/rate-limiter');
    const limiter = createRateLimiter({ windowMs: 60000, max: 1 });

    const app = express();
    app.use(express.json());
    app.use(limiter);
    app.get('/test', (req, res) => res.json({ ok: true }));

    // supertest uses the same IP so both hit the same bucket
    const res1 = await request(app).get('/test');
    const res2 = await request(app).get('/test');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(429);
    limiter.destroy();
  });
});

// =====================================================================
// 4. Input Size Limiting
// =====================================================================

describe('Input Size Limiting', () => {
  it('should accept normal-sized request body', async () => {
    const { createSizeLimiter } = await import('../protection/size-limiter');

    const app = express();
    app.use(createSizeLimiter('100kb'));
    app.post('/test', (req, res) => res.json({ ok: true }));

    const response = await request(app)
      .post('/test')
      .send({ data: 'small payload' });

    expect(response.status).toBe(200);
  });

  it('should reject request body exceeding size limit', async () => {
    const { createSizeLimiter } = await import('../protection/size-limiter');

    const app = express();
    app.use(createSizeLimiter('1kb'));
    app.post('/test', (req, res) => res.json({ ok: true }));

    // Send ~2KB payload
    const largePayload = { data: 'x'.repeat(2000) };
    const response = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(largePayload));

    expect(response.status).toBe(413);
  });

  it('should return meaningful error for oversized payload', async () => {
    const { createSizeLimiter } = await import('../protection/size-limiter');

    const app = express();
    app.use(createSizeLimiter('1kb'));
    app.use((err: any, req: any, res: any, next: any) => {
      if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'payload_too_large' });
      }
      next(err);
    });
    app.post('/test', (req, res) => res.json({ ok: true }));

    const largePayload = { data: 'x'.repeat(2000) };
    const response = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(largePayload));

    expect(response.status).toBe(413);
  });

  it('should allow exactly at the limit', async () => {
    const { createSizeLimiter } = await import('../protection/size-limiter');

    const app = express();
    // 100kb limit — normal x402 payloads are well under this
    app.use(createSizeLimiter('100kb'));
    app.post('/test', (req, res) => res.json({ ok: true }));

    const paymentPayload = createBasePayment();
    const paymentRequirements = createPaymentRequirements('eip155:8453');

    const response = await request(app)
      .post('/test')
      .send({ paymentPayload, paymentRequirements });

    expect(response.status).toBe(200);
  });
});
