import express from 'express';
import request from 'supertest';
import { config } from '../config';
import { verifyPayment } from '../routes/verify';
import { settlePayment } from '../routes/settle';

const verify = jest.fn();
const settle = jest.fn();
jest.mock('../solana/svm-exact', () => ({
  getExactSvmScheme: jest.fn(async () => ({ verify, settle })),
}));

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const paymentPayload = {
  x402Version: 2,
  accepted: { scheme: 'exact', network: DEVNET },
  payload: { transaction: 'partially-signed-transaction' },
};
const requirements = {
  scheme: 'exact', network: DEVNET, amount: '1', asset: 'Mint', payTo: 'Merchant',
  extra: { feePayer: 'Sponsor' },
};

function app() {
  const server = express();
  server.use(express.json());
  server.post('/verify', verifyPayment);
  server.post('/settle', settlePayment);
  return server;
}

describe('gated SVM Exact routes', () => {
  const original = {
    enabled: config.solanaSvmExactEnabled,
    network: config.solanaSvmNetwork,
  };

  beforeEach(() => {
    verify.mockReset().mockResolvedValue({ isValid: true, payer: 'payer' });
    settle.mockReset().mockResolvedValue({ success: true, payer: 'payer', transaction: 'signature', network: DEVNET });
    config.solanaSvmExactEnabled = false;
    config.solanaSvmNetwork = 'solana-devnet';
  });

  afterAll(() => {
    config.solanaSvmExactEnabled = original.enabled;
    config.solanaSvmNetwork = original.network;
  });

  it('rejects a transaction payload at verify when the gate is off', async () => {
    const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
    expect(response.body).toMatchObject({ isValid: false, invalidReason: 'solana_svm_exact_disabled' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a transaction payload at settle when the gate is off', async () => {
    const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
    expect(response.body).toMatchObject({ success: false, errorReason: 'solana_svm_exact_disabled' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('cannot use a devnet enablement to settle mainnet', async () => {
    config.solanaSvmExactEnabled = true;
    const response = await request(app()).post('/settle').send({
      paymentPayload: { ...paymentPayload, accepted: { ...paymentPayload.accepted, network: MAINNET } },
      paymentRequirements: { ...requirements, network: MAINNET },
    });
    expect(response.body).toMatchObject({ success: false, errorReason: 'solana_svm_exact_disabled' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('uses the official SVM scheme only for the explicitly enabled network', async () => {
    config.solanaSvmExactEnabled = true;
    const priorReal = process.env.ENABLE_REAL_SETTLEMENT;
    process.env.ENABLE_REAL_SETTLEMENT = 'true';
    try {
      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
      expect(verify).toHaveBeenCalledWith(paymentPayload, requirements);
      expect(settle).toHaveBeenCalledWith(paymentPayload, requirements);
      expect(response.body).toMatchObject({ success: true, transaction: 'signature', network: DEVNET });
    } finally {
      process.env.ENABLE_REAL_SETTLEMENT = priorReal;
    }
  });
});
