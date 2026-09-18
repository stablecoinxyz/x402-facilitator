import request from 'supertest';
import express from 'express';

const mockVerify = jest.fn();
const mockSettle = jest.fn();
jest.mock('../solana/svm-exact', () => ({
  getExactSvmScheme: jest.fn(async () => ({ verify: mockVerify, settle: mockSettle })),
}));
jest.mock('../solana/settle', () => ({ settleSolanaPayment: jest.fn() }));

import { verifyPayment } from '../routes/verify';
import { settlePayment } from '../routes/settle';
import { settleSolanaPayment } from '../solana/settle';

const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const requirements = { scheme: 'exact', network, amount: '10', asset: 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA', payTo: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K', extra: { feePayer: 'FeePayer11111111111111111111111111111111111' } };
const paymentPayload = { x402Version: 2, accepted: requirements, payload: { transaction: 'base64-partially-signed-transaction' }, extensions: {} };

function app() {
  const result = express(); result.use(express.json()); result.post('/verify', verifyPayment); result.post('/settle', settlePayment); return result;
}

describe('standard SVM Exact routes', () => {
  beforeEach(() => { mockVerify.mockReset(); mockSettle.mockReset(); });
  it('uses official SVM verification rather than the retired delegated transfer verifier', async () => {
    mockVerify.mockResolvedValue({ isValid: false, payer: 'payer', invalidReason: 'invalid_exact_svm_payload_signature_invalid' });
    const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
    expect(mockVerify).toHaveBeenCalledWith(paymentPayload, requirements);
    expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_svm_payload_signature_invalid' });
  });
  it('settles a verified transaction through the SVM scheme, never delegated SPL', async () => {
    process.env.ENABLE_REAL_SETTLEMENT = 'true';
    mockVerify.mockResolvedValue({ isValid: true, payer: 'payer' });
    mockSettle.mockResolvedValue({ success: true, payer: 'payer', transaction: 'signature', network });
    const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
    expect(mockSettle).toHaveBeenCalledWith(paymentPayload, requirements);
    expect(settleSolanaPayment).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ success: true, transaction: 'signature' });
    process.env.ENABLE_REAL_SETTLEMENT = 'false';
  });
});
