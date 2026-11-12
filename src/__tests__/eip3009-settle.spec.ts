import express from 'express';
import request from 'supertest';
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { settlePayment } from '../routes/settle';
import { verifyPayment } from '../routes/verify';
import { config } from '../config';
import { eip3009Abi } from '../evm/eip3009';

const readContract = jest.fn();
const simulateContract = jest.fn();
const writeContract = jest.fn();
const waitForTransactionReceipt = jest.fn();
const getCode = jest.fn();
const verifyTypedData = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    verifyTypedData: (...args: any[]) => verifyTypedData(...args),
    createPublicClient: () => ({ getCode, readContract, simulateContract, waitForTransactionReceipt, getGasPrice: jest.fn().mockResolvedValue(1n) }),
    createWalletClient: () => ({ writeContract }),
  };
});
jest.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({ address: '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6' }),
}));

const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAYER: `0x${string}` = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const MERCHANT: `0x${string}` = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SBC = config.baseSbcTokenAddress;

function requirements(extra: any = { assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1' }) {
  return { scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: SBC, payTo: MERCHANT, maxTimeoutSeconds: 60, extra };
}
function payment(req = requirements()) {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: 2,
    accepted: { ...req },
    payload: {
      signature: `0x${'1'.repeat(128)}1b`,
      authorization: { from: PAYER, to: MERCHANT, value: '1000', validAfter: '0', validBefore: String(now + 300), nonce: `0x${'cd'.repeat(32)}` },
    },
  };
}
function transferLog(from: `0x${string}` = PAYER, to: `0x${string}` = MERCHANT, value = 1000n, address = SBC) {
  return { address, topics: encodeEventTopics({ abi: eip3009Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
/** authorizationState → `used`, balanceOf → `balance`. */
function chain(used: boolean | boolean[], balance = 10_000n) {
  readContract.mockReset();
  const states = Array.isArray(used) ? [...used] : null;
  readContract.mockImplementation(({ functionName }: any) => {
    if (functionName === 'authorizationState') return Promise.resolve(states ? states.shift() : used);
    if (functionName === 'balanceOf') return Promise.resolve(balance);
    return Promise.reject(new Error(`unexpected ${functionName}`));
  });
}

function app() {
  const server = express();
  server.use(express.json());
  server.post('/settle', settlePayment);
  server.post('/verify', verifyPayment);
  return server;
}

describe('EIP-3009 /settle', () => {
  const previous = process.env.ENABLE_REAL_SETTLEMENT;
  beforeEach(() => {
    process.env.ENABLE_REAL_SETTLEMENT = 'true';
    verifyTypedData.mockReset().mockResolvedValue(true);
    getCode.mockReset().mockResolvedValue('0x01');
    simulateContract.mockReset().mockResolvedValue({});
    writeContract.mockReset().mockResolvedValue(HASH);
    waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [transferLog()] });
    chain(false);
  });
  afterAll(() => { if (previous === undefined) delete process.env.ENABLE_REAL_SETTLEMENT; else process.env.ENABLE_REAL_SETTLEMENT = previous; });

  it('calls transferWithAuthorization on the token, once', async () => {
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: true, transaction: HASH, payer: PAYER, network: 'eip155:8453' });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: SBC, functionName: 'transferWithAuthorization' }));
  });

  it('takes the EIP-3009 path when assetTransferMethod is absent (spec default)', async () => {
    const req = requirements({ name: 'Stable Coin', version: '1' });
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(req), paymentRequirements: req });
    expect(res.body).toMatchObject({ success: true, transaction: HASH });
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'transferWithAuthorization' }));
  });

  it('refuses EIP-3009 on a Permit2-only token (Base Sepolia SBC) without broadcasting', async () => {
    const req = { ...requirements(), network: 'eip155:84532', asset: config.baseSepoliaSbcTokenAddress };
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(req), paymentRequirements: req });
    expect(res.body).toMatchObject({ success: false, errorReason: 'unsupported_asset_transfer_method', transaction: '' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('never answers success for an already-used authorization, and never broadcasts', async () => {
    chain(true);
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_nonce_already_used', transaction: '' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('a duplicate that passes the pre-check finds the nonce used inside the queue and does not broadcast', async () => {
    chain([false, true]); // pre-check sees unused; the in-queue re-read sees it consumed
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_nonce_already_used', transaction: '' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('keeps the broadcast hash when the receipt cannot be read', async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: HASH });
  });

  it('reports a mined revert as invalid_transaction_state with the hash', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_transaction_state', transaction: HASH });
  });

  it('does not vouch for a success whose receipt lacks the signed Transfer', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [transferLog(PAYER, PAYER)] });
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_effects_mismatch', transaction: HASH });
  });

  it('refuses a bad signature without touching the chain', async () => {
    verifyTypedData.mockResolvedValue(false);
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_signature', transaction: '' });
    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses when accepted disagrees with the requirements on the method', async () => {
    const p: any = payment();
    p.accepted.extra = { ...p.accepted.extra, assetTransferMethod: 'permit2' };
    const res = await request(app()).post('/settle').send({ paymentPayload: p, paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_payload' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses insufficient balance before broadcasting', async () => {
    chain(false, 999n);
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'insufficient_funds' });
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('EIP-3009 /settle — modes and margin', () => {
  const saved = { real: process.env.ENABLE_REAL_SETTLEMENT, sim: process.env.ALLOW_SIMULATED_SETTLEMENT };
  beforeEach(() => {
    verifyTypedData.mockReset().mockResolvedValue(true);
    getCode.mockReset().mockResolvedValue('0x01');
    simulateContract.mockReset().mockResolvedValue({});
    writeContract.mockReset().mockResolvedValue(HASH);
    waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success', logs: [transferLog()] });
    chain(false);
  });
  afterEach(() => {
    for (const [k, v] of [['ENABLE_REAL_SETTLEMENT', saved.real], ['ALLOW_SIMULATED_SETTLEMENT', saved.sim]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('disabled: refuses with settlement_disabled and never reads the chain', async () => {
    delete process.env.ENABLE_REAL_SETTLEMENT; delete process.env.ALLOW_SIMULATED_SETTLEMENT;
    const res = await request(app()).post('/settle').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ success: false, errorReason: 'settlement_disabled', transaction: '' });
    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('simulated: answers success with the simulated header and never touches the chain', async () => {
    delete process.env.ENABLE_REAL_SETTLEMENT; process.env.ALLOW_SIMULATED_SETTLEMENT = 'true';
    const p: any = payment();
    p.payload.authorization.nonce = `0x${'ef'.repeat(32)}`;
    const res = await request(app()).post('/settle').send({ paymentPayload: p, paymentRequirements: requirements() });
    expect(res.headers['x-settlement-mode']).toBe('simulated');
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.transaction).toMatch(/^SIMULATED/);
    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses an authorization expiring within 6 seconds, settles one with 10 left', async () => {
    process.env.ENABLE_REAL_SETTLEMENT = 'true';
    const now = Math.floor(Date.now() / 1000);
    const short: any = payment(); short.payload.authorization.validBefore = String(now + 5);
    const r1 = await request(app()).post('/settle').send({ paymentPayload: short, paymentRequirements: requirements() });
    expect(r1.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_authorization_valid_before' });
    const ok: any = payment(); ok.payload.authorization.validBefore = String(now + 10);
    const r2 = await request(app()).post('/settle').send({ paymentPayload: ok, paymentRequirements: requirements() });
    expect(r2.body).toMatchObject({ success: true, transaction: HASH });
  });
});

describe('EIP-3009 /verify', () => {
  beforeEach(() => {
    verifyTypedData.mockReset().mockResolvedValue(true);
    getCode.mockReset().mockResolvedValue('0x01');
    simulateContract.mockReset().mockResolvedValue({});
    chain(false);
  });

  it('is valid for a good authorization and simulates the transfer', async () => {
    const res = await request(app()).post('/verify').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ isValid: true, payer: PAYER });
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: SBC, functionName: 'transferWithAuthorization' }));
  });

  it('is invalid for a used authorization', async () => {
    chain(true);
    const res = await request(app()).post('/verify').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_evm_nonce_already_used' });
  });

  it('is invalid when the simulation reverts', async () => {
    simulateContract.mockRejectedValueOnce(new Error('execution reverted'));
    const res = await request(app()).post('/verify').send({ paymentPayload: payment(), paymentRequirements: requirements() });
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'invalid_transaction_state' });
  });
});
