/**
 * Solana /settle authorization + replay
 *
 * /settle must validate the payment itself. The x402 v2 spec defines flows
 * (upfront, escrow) where /verify never runs, and even in the default flow the
 * two are separate HTTP requests with nothing linking them — anyone can POST
 * straight to /settle.
 *
 * The measured side effect throughout is whether settleSolanaPayment is called.
 * It is the function that signs as SPL delegate and moves the payer's tokens,
 * so a call here means money would have moved on mainnet.
 */

import request from 'supertest';
import express from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { settlePayment } from '../routes/settle';
import { settleSolanaPayment } from '../solana/settle';

jest.mock('../solana/settle', () => ({ settleSolanaPayment: jest.fn() }));

// Balance check in the verifier must not touch the network.
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getTokenAccountBalance: jest.fn().mockResolvedValue({ value: { amount: '1000000000000' } }),
    })),
  };
});

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const MERCHANT = '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K';
const mockedSettle = settleSolanaPayment as jest.MockedFunction<typeof settleSolanaPayment>;

/** A payer keypair, and a genuinely valid signature over the x402 message. */
function signedPayment(
  overrides: Record<string, any> = {},
  opts: { keypair?: nacl.SignKeyPair; to?: string; amount?: string; nonce?: string } = {},
) {
  const keypair = opts.keypair ?? nacl.sign.keyPair();
  const from = bs58.encode(keypair.publicKey);
  const to = opts.to ?? MERCHANT;
  const amount = opts.amount ?? '50000000';
  const nonce = opts.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  const deadline = Math.floor(Date.now() / 1000) + 300;

  const message = `from:${from}|to:${to}|amount:${amount}|nonce:${nonce}|deadline:${deadline}`;
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(message), keypair.secretKey));

  return {
    x402Version: 2,
    accepted: { scheme: 'exact', network: SOLANA_MAINNET },
    payload: { from, to, amount, nonce, deadline, signature, ...overrides },
    extensions: {},
  };
}

function requirements(payTo = MERCHANT, amount = '50000000') {
  return { scheme: 'exact', network: SOLANA_MAINNET, amount, payTo, asset: 'SBC' };
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/settle', settlePayment);
  return app;
}

describe('Solana /settle authorization', () => {
  let app: express.Application;
  const originalReal = process.env.ENABLE_REAL_SETTLEMENT;

  // jest.config.js runs the suites in simulated mode. These cases are about
  // whether the REAL settle function is reached, so they need real mode.
  beforeAll(() => { process.env.ENABLE_REAL_SETTLEMENT = 'true'; });
  afterAll(() => { process.env.ENABLE_REAL_SETTLEMENT = originalReal; });

  beforeEach(() => {
    app = createTestApp();
    mockedSettle.mockReset();
    // A distinct hash per settlement, as the chain would give. Deriving it from
    // payload fields would make two different settlements indistinguishable here.
    let settlementCount = 0;
    mockedSettle.mockImplementation(async (payload: any) => ({
      success: true,
      payer: payload.from,
      transaction: `tx-${++settlementCount}`,
      network: SOLANA_MAINNET,
    }));
  });

  it('refuses to move tokens for a payload whose signature is not the payer\'s', async () => {
    const payment = signedPayment();
    const impostor = nacl.sign.keyPair();
    const wrongMessage = `from:${payment.payload.from}|to:${MERCHANT}|amount:50000000|nonce:x|deadline:1`;
    payment.payload.signature = bs58.encode(nacl.sign.detached(Buffer.from(wrongMessage), impostor.secretKey));

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: payment, paymentRequirements: requirements() });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(false);
    expect(response.body.transaction).toBe('');
  });

  it('refuses to move tokens when the payload carries no signature at all', async () => {
    const payment = signedPayment();
    delete (payment.payload as any).signature;

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: payment, paymentRequirements: requirements() });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.body.success).toBe(false);
  });

  it('refuses to redirect a signed payment to a recipient the merchant did not ask for', async () => {
    // Signature is valid, but it authorizes payment to MERCHANT — while the
    // resource server requires a different payTo. Settling would honor the
    // attacker's destination.
    const payment = signedPayment();

    const response = await request(app)
      .post('/settle')
      .send({
        paymentPayload: payment,
        paymentRequirements: requirements('9hrYjBscrbmNkQutdZhDecxYs7GxVFRUhPCbLGe5kRCY'),
      });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.body.success).toBe(false);
  });

  it('refuses a recipient that differs from payTo only by letter case', async () => {
    // Base58 is case-sensitive, so these are different addresses. Comparing them
    // lowercased would make the binding accept a destination the merchant never
    // asked for. The earlier wrong-recipient test cannot catch that: it uses two
    // entirely different addresses, which stay different either way.
    const flipped = MERCHANT.replace(/[a-zA-Z]/, c =>
      c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
    expect(flipped).not.toBe(MERCHANT);
    expect(flipped.toLowerCase()).toBe(MERCHANT.toLowerCase());

    const payment = signedPayment(); // signed to pay MERCHANT
    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: payment, paymentRequirements: requirements(flipped) });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.body.success).toBe(false);
  });

  it('refuses a signed payment worth less than the resource requires', async () => {
    const payment = signedPayment();

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: payment, paymentRequirements: requirements(MERCHANT, '90000000') });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.body.success).toBe(false);
  });

  it('refuses a signed payment whose deadline has passed', async () => {
    const payment = signedPayment();
    const expired = Math.floor(Date.now() / 1000) - 60;
    const keypair = nacl.sign.keyPair();
    const from = bs58.encode(keypair.publicKey);
    const message = `from:${from}|to:${MERCHANT}|amount:50000000|nonce:expired|deadline:${expired}`;
    payment.payload = {
      from, to: MERCHANT, amount: '50000000', nonce: 'expired', deadline: expired,
      signature: bs58.encode(nacl.sign.detached(Buffer.from(message), keypair.secretKey)),
    } as any;

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: payment, paymentRequirements: requirements() });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.body.success).toBe(false);
  });

  it('still settles a correctly signed payment', async () => {
    const payment = signedPayment();

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: payment, paymentRequirements: requirements() });

    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(response.body.success).toBe(true);
    expect(response.body.payer).toBe(payment.payload.from);
    expect(response.body.network).toBe(SOLANA_MAINNET);
  });

  it('settles a captured payload once, then replays the original instead of paying twice', async () => {
    const payment = signedPayment();
    const body = { paymentPayload: payment, paymentRequirements: requirements() };

    const first = await request(app).post('/settle').send(body);
    const second = await request(app).post('/settle').send(body);

    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(second.body.success).toBe(true);
    expect(second.body.transaction).toBe(first.body.transaction);
  });

  it('settles once when the same payload arrives concurrently', async () => {
    const payment = signedPayment();
    const body = { paymentPayload: payment, paymentRequirements: requirements() };

    const responses = await Promise.all([
      request(app).post('/settle').send(body),
      request(app).post('/settle').send(body),
      request(app).post('/settle').send(body),
    ]);

    expect(mockedSettle).toHaveBeenCalledTimes(1);
    const hashes = new Set(responses.map(r => r.body.transaction));
    expect(hashes.size).toBe(1);
  });
  it('settles a second, different payment that happens to reuse a nonce', async () => {
    // The nonce is a client-chosen string and nothing forces it to be unique.
    // Keying replay on it would make this legitimate second payment look like a
    // duplicate and hand the second merchant the first payment's hash.
    const keypair = nacl.sign.keyPair();
    const reusedNonce = 'same-nonce';
    const OTHER_MERCHANT = '9hrYjBscrbmNkQutdZhDecxYs7GxVFRUhPCbLGe5kRCY';

    const first = signedPayment({}, { keypair, nonce: reusedNonce, to: MERCHANT });
    const firstRes = await request(app)
      .post('/settle')
      .send({ paymentPayload: first, paymentRequirements: requirements(MERCHANT) });

    const second = signedPayment({}, { keypair, nonce: reusedNonce, to: OTHER_MERCHANT, amount: '90000000' });
    const secondRes = await request(app)
      .post('/settle')
      .send({ paymentPayload: second, paymentRequirements: requirements(OTHER_MERCHANT, '90000000') });

    expect(mockedSettle).toHaveBeenCalledTimes(2);
    expect(secondRes.body.success).toBe(true);
    expect(secondRes.body.transaction).not.toBe(firstRes.body.transaction);
  });
});

describe('Solana /settle honors the settlement kill switch', () => {
  // The switch gates whether this process may move money. It covered the EVM
  // path only: the Solana branch returned before the gate, so a deployment
  // configured for simulation still executed real SPL transfers.
  let app: express.Application;
  const originalReal = process.env.ENABLE_REAL_SETTLEMENT;
  const originalSim = process.env.ALLOW_SIMULATED_SETTLEMENT;

  beforeEach(() => {
    app = createTestApp();
    mockedSettle.mockReset();
    mockedSettle.mockResolvedValue({
      success: true, payer: 'p', transaction: 'REAL_TX', network: SOLANA_MAINNET,
    });
  });

  afterEach(() => {
    process.env.ENABLE_REAL_SETTLEMENT = originalReal;
    process.env.ALLOW_SIMULATED_SETTLEMENT = originalSim;
  });

  it('refuses when neither flag is set, and touches no chain', async () => {
    delete process.env.ENABLE_REAL_SETTLEMENT;
    delete process.env.ALLOW_SIMULATED_SETTLEMENT;

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: signedPayment(), paymentRequirements: requirements() });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('settlement_disabled');
    expect(response.body.transaction).toBe('');
  });

  it('does not move tokens in simulated mode, and marks the response', async () => {
    delete process.env.ENABLE_REAL_SETTLEMENT;
    process.env.ALLOW_SIMULATED_SETTLEMENT = 'true';

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: signedPayment(), paymentRequirements: requirements() });

    expect(mockedSettle).not.toHaveBeenCalled();
    expect(response.headers['x-settlement-mode']).toBe('simulated');
    expect(response.body.transaction).not.toBe('REAL_TX');
  });

  it('settles for real only when the real flag is set', async () => {
    process.env.ENABLE_REAL_SETTLEMENT = 'true';

    const response = await request(app)
      .post('/settle')
      .send({ paymentPayload: signedPayment(), paymentRequirements: requirements() });

    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(response.body.transaction).toBe('REAL_TX');
    expect(response.headers['x-settlement-mode']).toBeUndefined();
  });
});
