/**
 * Branches of the live EVM /settle and /verify paths that no other suite
 * reached (found by a coverage pass, 2026-11-14): Permit2 binding and asset
 * refusals in /settle, the EIP-2612 sponsor checks on both routes, the Radius
 * path (no simulation, gas-price override) for both methods, and /verify's
 * Permit2 allowance answer.
 */
import express from 'express';
import request from 'supertest';
import { settlePayment } from '../routes/settle';
import { verifyPayment } from '../routes/verify';
import { createBasePayment, createPaymentRequirements } from './fixtures/payment-fixtures';
import { PERMIT2_ADDRESS, X402_PERMIT2_PROXY } from '../evm/permit2';
import { config } from '../config';
import { InMemoryPendingSettlementStore, setPendingSettlementStore } from '../protection/pending-settlement-store';

const simulateContract = jest.fn();
const writeContract = jest.fn();
const waitForTransactionReceipt = jest.fn();
const getCode = jest.fn();
const readContract = jest.fn();
const getGasPrice = jest.fn();
const verifyTypedData = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    verifyTypedData: (...a: any[]) => verifyTypedData(...a),
    createPublicClient: () => ({ getCode, simulateContract, waitForTransactionReceipt, readContract, getGasPrice, getTransaction: jest.fn() }),
    createWalletClient: () => ({ writeContract }),
  };
});
jest.mock('viem/accounts', () => ({ privateKeyToAccount: () => ({ address: '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6' }) }));

const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNCONFIGURED_TOKEN = '0x9999999999999999999999999999999999999999';

function app() {
  const server = express();
  server.use(express.json());
  server.post('/settle', settlePayment);
  server.post('/verify', verifyPayment);
  return server;
}
const post = (path: '/settle' | '/verify', paymentPayload: any, paymentRequirements: any) => request(app()).post(path).send({ paymentPayload, paymentRequirements });
/**
 * Deep copy in the shape a real client sends. The fixture also carries a legacy
 * `payload.authorization` adapter that real Permit2 clients never send; an older
 * generic check reads it, which would mask whether the Permit2-specific checks
 * work at all.
 */
const clone = (x: any) => { const c = JSON.parse(JSON.stringify(x)); if (c?.payload?.permit2Authorization) delete c.payload.authorization; return c; };

/** A Permit2 payment plus an EIP-2612 sponsorship for the same token and amount. */
function sponsored() {
  const p = clone(createBasePayment());
  const a = p.payload.permit2Authorization;
  p.extensions = { eip2612GasSponsoring: { info: { from: a.from, asset: a.permitted.token, spender: PERMIT2_ADDRESS, amount: a.permitted.amount, nonce: '3', deadline: a.deadline, signature: `0x${'2'.repeat(128)}1c`, version: '1' } } };
  return p;
}

const savedRadiusKey = config.radiusFacilitatorPrivateKey;
const previousReal = process.env.ENABLE_REAL_SETTLEMENT;
beforeEach(() => {
  process.env.ENABLE_REAL_SETTLEMENT = 'true';
  verifyTypedData.mockReset().mockResolvedValue(true);
  getCode.mockReset().mockResolvedValue('0x01');
  simulateContract.mockReset().mockResolvedValue({});
  writeContract.mockReset().mockResolvedValue(HASH);
  waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success', transactionHash: HASH, logs: [] });
  readContract.mockReset().mockResolvedValue(0n);
  getGasPrice.mockReset().mockResolvedValue(5n);
  setPendingSettlementStore(new InMemoryPendingSettlementStore());
  (config as any).radiusFacilitatorPrivateKey = `0x${'0'.repeat(63)}1`; // deterministic: never the developer's .env key
});
afterAll(() => {
  (config as any).radiusFacilitatorPrivateKey = savedRadiusKey;
  if (previousReal === undefined) delete process.env.ENABLE_REAL_SETTLEMENT; else process.env.ENABLE_REAL_SETTLEMENT = previousReal;
});

describe('/settle Permit2 refusals before any chain work', () => {
  it('refuses when `accepted` does not match the requirements', async () => {
    const p = clone(createBasePayment());
    p.accepted.amount = '1';
    const res = await post('/settle', p, createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_payload', transaction: '' });
    expect(getCode).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses when `accepted` names a different transfer method than the requirements', async () => {
    const p = clone(createBasePayment());
    p.accepted.extra.assetTransferMethod = 'eip3009';
    const res = await post('/settle', p, createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_payload', transaction: '' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses a token this facilitator does not serve', async () => {
    const p = clone(createBasePayment());
    p.payload.permit2Authorization.permitted.token = UNCONFIGURED_TOKEN;
    p.accepted.asset = UNCONFIGURED_TOKEN;
    const req = { ...createPaymentRequirements('eip155:8453'), asset: UNCONFIGURED_TOKEN };
    const res = await post('/settle', p, req);
    expect(res.body).toMatchObject({ success: false, errorReason: 'unsupported_asset' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses a self-payment', async () => {
    const p = clone(createBasePayment());
    const payer = p.payload.permit2Authorization.from;
    p.payload.permit2Authorization.witness.to = payer;
    p.accepted.payTo = payer;
    const res = await post('/settle', p, { ...createPaymentRequirements('eip155:8453'), payTo: payer });
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_self_payment' });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses an EIP-2612 sponsorship whose signature does not verify, even though the Permit2 signature does', async () => {
    verifyTypedData.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const res = await post('/settle', sponsored(), createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_payload_signature' });
    expect(verifyTypedData).toHaveBeenCalledTimes(2);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('settles a valid sponsored payment through settleWithPermit, with the sponsor tuple split into v/r/s', async () => {
    const p = sponsored();
    const res = await post('/settle', p, createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ success: true, transaction: HASH });
    const call = writeContract.mock.calls[0][0];
    expect(call).toMatchObject({ address: X402_PERMIT2_PROXY, functionName: 'settleWithPermit' });
    const sig = p.extensions.eip2612GasSponsoring.info.signature;
    expect(call.args[0]).toMatchObject({ r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: 0x1c, value: BigInt(p.extensions.eip2612GasSponsoring.info.amount) });
  });
});

describe('Radius settles without a simulation and with a gas-price override', () => {
  const RADIUS = 'eip155:723487';
  const MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  it('Permit2: no simulateContract; writeContract carries getGasPrice + 1 gwei', async () => {
    const p = clone(createBasePayment());
    p.payload.permit2Authorization.permitted.token = config.radiusSbcTokenAddress;
    p.payload.permit2Authorization.permitted.amount = '1000';
    const req = { scheme: 'exact', network: RADIUS, amount: '1000', asset: config.radiusSbcTokenAddress, payTo: p.payload.permit2Authorization.witness.to, maxTimeoutSeconds: 60, extra: { assetTransferMethod: 'permit2', name: 'Stable Coin', version: '1' } };
    p.accepted = { ...req };
    const res = await post('/settle', p, req);
    expect(res.body).toMatchObject({ success: true, transaction: HASH, network: RADIUS });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'settle', gasPrice: 5n + 1000000000n }));
  });

  it('EIP-3009: no simulateContract; writeContract carries getGasPrice + 1 gwei', async () => {
    readContract.mockImplementation(({ functionName }: any) => Promise.resolve(functionName === 'authorizationState' ? false : 10_000n));
    const { encodeEventTopics, encodeAbiParameters } = jest.requireActual('viem');
    const { eip3009Abi } = jest.requireActual('../evm/eip3009');
    const PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH, logs: [{ address: config.radiusSbcTokenAddress, topics: encodeEventTopics({ abi: eip3009Abi, eventName: 'Transfer', args: { from: PAYER, to: MERCHANT } }), data: encodeAbiParameters([{ type: 'uint256' }], [1000n]) }] });
    const req = { scheme: 'exact', network: RADIUS, amount: '1000', asset: config.radiusSbcTokenAddress, payTo: MERCHANT, maxTimeoutSeconds: 60, extra: { name: 'Stable Coin', version: '1' } };
    const p = { x402Version: 2, accepted: { ...req }, payload: { signature: `0x${'1'.repeat(128)}1b`, authorization: { from: PAYER, to: MERCHANT, value: '1000', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${'ab'.repeat(32)}` } } };
    const res = await post('/settle', p, req);
    expect(res.body).toMatchObject({ success: true, transaction: HASH, network: RADIUS });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'transferWithAuthorization', gasPrice: 5n + 1000000000n }));
  });
});

describe('/verify Permit2 branches', () => {
  /** balanceOf → balance, allowance → allowance, nonces → nonce (or throw). */
  function token(balance: bigint, allowance: bigint, nonce: bigint | Error = 3n) {
    readContract.mockImplementation(({ functionName }: any) => {
      if (functionName === 'balanceOf') return Promise.resolve(balance);
      if (functionName === 'allowance') return Promise.resolve(allowance);
      if (functionName === 'nonces') return nonce instanceof Error ? Promise.reject(nonce) : Promise.resolve(nonce);
      return Promise.reject(new Error(`unexpected ${functionName}`));
    });
  }
  const BIG = 10n ** 30n;

  it('answers 412 PERMIT2_ALLOWANCE_REQUIRED when Permit2 is not approved and no sponsorship is attached (spec scheme_exact_evm.md:185)', async () => {
    token(BIG, 0n);
    const res = await post('/verify', clone(createBasePayment()), createPaymentRequirements('eip155:8453'));
    expect(res.status).toBe(412);
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'PERMIT2_ALLOWANCE_REQUIRED' });
  });

  it('accepts a missing allowance when an EIP-2612 sponsorship will grant it', async () => {
    token(BIG, 0n, 3n);
    const res = await post('/verify', sponsored(), createPaymentRequirements('eip155:8453'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isValid: true });
  });

  it('refuses a sponsorship signed for a stale token nonce', async () => {
    token(BIG, 0n, 4n);
    const res = await post('/verify', sponsored(), createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' });
  });

  it('refuses when the token nonce cannot be read', async () => {
    token(BIG, 0n, new Error('nonces() reverted'));
    const res = await post('/verify', sponsored(), createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
  });

  it('refuses a sponsorship whose signature does not verify', async () => {
    verifyTypedData.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    token(BIG, 0n);
    const res = await post('/verify', sponsored(), createPaymentRequirements('eip155:8453'));
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' });
  });

  it('refuses a token this facilitator does not serve', async () => {
    const p = clone(createBasePayment());
    p.payload.permit2Authorization.permitted.token = UNCONFIGURED_TOKEN;
    p.accepted.asset = UNCONFIGURED_TOKEN;
    const res = await post('/verify', p, { ...createPaymentRequirements('eip155:8453'), asset: UNCONFIGURED_TOKEN });
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'unsupported_asset' });
  });

  it('refuses a self-payment', async () => {
    const p = clone(createBasePayment());
    const payer = p.payload.permit2Authorization.from;
    p.payload.permit2Authorization.witness.to = payer;
    p.accepted.payTo = payer;
    const res = await post('/verify', p, { ...createPaymentRequirements('eip155:8453'), payTo: payer });
    expect(res.body).toMatchObject({ isValid: false, invalidReason: 'invalid_self_payment' });
  });
});
