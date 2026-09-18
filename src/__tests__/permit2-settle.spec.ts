import express from 'express';
import request from 'supertest';
import { settlePayment } from '../routes/settle';
import { createBasePayment, createPaymentRequirements } from './fixtures/payment-fixtures';
import { proxyAbi, X402_PERMIT2_PROXY } from '../evm/permit2';

const simulateContract = jest.fn();
const writeContract = jest.fn();
const waitForTransactionReceipt = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    verifyTypedData: jest.fn().mockResolvedValue(true),
    createPublicClient: () => ({ getCode: jest.fn().mockResolvedValue('0x01'), simulateContract, waitForTransactionReceipt }),
    createWalletClient: () => ({ writeContract }),
  };
});

jest.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({ address: '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6' }),
}));

const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function app() {
  const server = express();
  server.use(express.json());
  server.post('/settle', settlePayment);
  return server;
}

describe('Permit2 proxy settlement', () => {
  const previous = process.env.ENABLE_REAL_SETTLEMENT;
  beforeEach(() => {
    process.env.ENABLE_REAL_SETTLEMENT = 'true';
    simulateContract.mockReset().mockResolvedValue({});
    writeContract.mockReset().mockResolvedValue(HASH);
    waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success' });
  });
  afterAll(() => { if (previous === undefined) delete process.env.ENABLE_REAL_SETTLEMENT; else process.env.ENABLE_REAL_SETTLEMENT = previous; });

  it('declares empty outputs for proxy transactions so Base preflight can decode success', () => {
    expect(proxyAbi.every((fn) => Array.isArray(fn.outputs) && fn.outputs.length === 0)).toBe(true);
  });

  it('simulates then sends exactly one canonical proxy settlement', async () => {
    const response = await request(app()).post('/settle').send({
      paymentPayload: createBasePayment(), paymentRequirements: createPaymentRequirements('eip155:8453'),
    });
    expect(response.body).toMatchObject({ success: true, transaction: HASH });
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: X402_PERMIT2_PROXY, functionName: 'settle' }));
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: X402_PERMIT2_PROXY, functionName: 'settle' }));
  });

  it('keeps the broadcast hash when confirmation cannot be read', async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const response = await request(app()).post('/settle').send({
      paymentPayload: createBasePayment(), paymentRequirements: createPaymentRequirements('eip155:8453'),
    });
    expect(response.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
  });

  it('reports a mined-but-reverted settlement as invalid_transaction_state, carrying the hash', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });
    const response = await request(app()).post('/settle').send({
      paymentPayload: createBasePayment(), paymentRequirements: createPaymentRequirements('eip155:8453'),
    });
    expect(response.body).toMatchObject({ success: false, errorReason: 'invalid_transaction_state', transaction: HASH });
  });

  it('rejects unknown requirements metadata before ledger or RPC work', async () => {
    const requirements: any = createPaymentRequirements('eip155:8453');
    requirements.extra.unrecognizedExecutionFlag = 'true';
    const response = await request(app()).post('/settle').send({ paymentPayload: createBasePayment(), paymentRequirements: requirements });
    expect(response.body).toMatchObject({ success: false, errorReason: 'invalid_payload' });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });
});
