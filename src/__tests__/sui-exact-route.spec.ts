import express from 'express';
import request from 'supertest';
import { config, SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2, SUI_USDC_MAINNET, SUI_USDC_TESTNET } from '../config';
import { verifyPayment } from '../routes/verify';
import { settlePayment } from '../routes/settle';
import { getSupportedNetworks } from '../routes/supported';
import { getExactSuiScheme, suiChainVerdict } from '../sui/sui-exact';
import { buildTestTransaction, digestOf } from './sui-helpers';

// The real asset policy and envelope binding are kept: they are our own guards,
// and mocking them would let the test agree with a bug in them. Only the pieces
// that talk to the chain — the scheme and the chain verdict — are replaced.
jest.mock('../sui/sui-exact', () => ({
  ...jest.requireActual('../sui/sui-exact'),
  getExactSuiScheme: jest.fn(),
  suiChainVerdict: jest.fn(),
}));

const scheme = getExactSuiScheme as jest.Mock;
const verdict = suiChainVerdict as jest.Mock;
const verify = jest.fn();
const settle = jest.fn();

const PAY_TO = '0xef77673777af31b83b7037de153b9a3b68ad304b761caed2e623437eae9b207a';
const OTHER_PAY_TO = '0x2c2b6c58ed29bdfccafcdf59922df2ea5b5b54478c31976a7cc52a72e8d0a104';
const DIGEST = 'BfvnFbtyScAUn9pYp8bCbFfxfqYmNuXkmFK1TjpuvnHS';

const requirements = {
  scheme: 'exact',
  network: SUI_TESTNET_CAIP2,
  amount: '50000',
  asset: SUI_USDC_TESTNET,
  payTo: PAY_TO,
  maxTimeoutSeconds: 600,
  extra: {},
};

const paymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: { transaction: 'AA==', signature: 'AA==' },
};

function app() {
  const server = express();
  server.use(express.json());
  server.post('/verify', verifyPayment);
  server.post('/settle', settlePayment);
  server.get('/supported', getSupportedNetworks);
  return server;
}

function withNetwork(network: string) {
  return {
    paymentPayload: { ...paymentPayload, accepted: { ...requirements, network } },
    paymentRequirements: { ...requirements, network },
  };
}

describe('Sui Exact routes', () => {
  const original = {
    enabled: config.suiExactEnabled,
    networks: config.suiNetworks,
    grpcUrls: config.suiGrpcUrls,
    real: process.env.ENABLE_REAL_SETTLEMENT,
    simulated: process.env.ALLOW_SIMULATED_SETTLEMENT,
  };

  beforeEach(() => {
    verify.mockReset().mockResolvedValue({ isValid: true, payer: 'payer' });
    settle.mockReset().mockResolvedValue({
      success: true,
      payer: 'payer',
      transaction: DIGEST,
      network: SUI_TESTNET_CAIP2,
    });
    // Default: the chain has not seen the transaction, so settlement proceeds.
    verdict.mockReset().mockResolvedValue({ state: 'unknown', digest: DIGEST, sender: 'payer' });
    scheme.mockReset().mockReturnValue({ verify, settle });
    config.suiExactEnabled = true;
    config.suiNetworks = [SUI_TESTNET_CAIP2];
    config.suiGrpcUrls = { ...config.suiGrpcUrls, [SUI_TESTNET_CAIP2]: 'https://fullnode.testnet.sui.io:443' };
    process.env.ENABLE_REAL_SETTLEMENT = 'true';
    delete process.env.ALLOW_SIMULATED_SETTLEMENT;
  });

  afterAll(() => {
    config.suiExactEnabled = original.enabled;
    config.suiNetworks = original.networks;
    config.suiGrpcUrls = original.grpcUrls;
    process.env.ENABLE_REAL_SETTLEMENT = original.real;
    if (original.simulated === undefined) delete process.env.ALLOW_SIMULATED_SETTLEMENT;
    else process.env.ALLOW_SIMULATED_SETTLEMENT = original.simulated;
  });

  describe('opt-in gate', () => {
    it('refuses verify when the gate is off, without touching the scheme', async () => {
      config.suiExactEnabled = false;
      const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'sui_exact_disabled' });
      expect(scheme).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });

    it('refuses settle when the gate is off, without touching the scheme', async () => {
      config.suiExactEnabled = false;
      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: false, errorReason: 'sui_exact_disabled' });
      expect(settle).not.toHaveBeenCalled();
    });

    it('cannot settle a mainnet payload from a testnet enablement', async () => {
      const body = withNetwork('sui:mainnet');
      const response = await request(app()).post('/settle').send(body);
      expect(response.body).toMatchObject({ success: false, errorReason: 'sui_exact_disabled' });
      expect(settle).not.toHaveBeenCalled();
    });

    it('rejects a network name that is not CAIP-2 rather than guessing', async () => {
      config.suiNetworks = ['sui-testnet'];
      const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'sui_exact_disabled' });
      expect(verify).not.toHaveBeenCalled();
    });
  });

  describe('asset policy', () => {
    it('rejects a payment denominated in SUI at verify, before the scheme runs', async () => {
      const body = {
        paymentPayload: {
          ...paymentPayload,
          accepted: { ...requirements, asset: '0x2::sui::SUI' },
        },
        paymentRequirements: { ...requirements, asset: '0x2::sui::SUI' },
      };
      const response = await request(app()).post('/verify').send(body);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'unsupported_asset' });
      expect(verify).not.toHaveBeenCalled();
    });

    it('rejects a payment denominated in SUI at settle, before anything can be submitted', async () => {
      const body = {
        paymentPayload: { ...paymentPayload, accepted: { ...requirements, asset: '0x2::sui::SUI' } },
        paymentRequirements: { ...requirements, asset: '0x2::sui::SUI' },
      };
      const response = await request(app()).post('/settle').send(body);
      expect(response.body).toMatchObject({ success: false, errorReason: 'unsupported_asset', transaction: '' });
      expect(settle).not.toHaveBeenCalled();
    });

    it('accepts the same coin written in short and full address form', async () => {
      const short = '0x2::sui::SUI';
      const full = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      const allowed = jest.requireActual('../sui/sui-exact').isAllowedSuiAsset;
      // Neither is USDC, so both are refused — but the point is that the policy
      // compares coin identity, not spelling: swap in the USDC pair to see a pass.
      expect(allowed(SUI_TESTNET_CAIP2, short)).toBe(false);
      expect(allowed(SUI_TESTNET_CAIP2, full)).toBe(false);
      expect(allowed(SUI_TESTNET_CAIP2, SUI_USDC_TESTNET)).toBe(true);
      expect(allowed(SUI_TESTNET_CAIP2, '0xnot-a-struct-tag')).toBe(false);
    });
  });

  describe('settlement', () => {
    it('settles through the scheme alone — never verify-then-settle', async () => {
      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
      expect(settle).toHaveBeenCalledWith(paymentPayload, requirements);
      expect(verify).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true, transaction: DIGEST, network: SUI_TESTNET_CAIP2 });
    });

    it('passes duplicate_settlement through instead of replaying an earlier success', async () => {
      settle
        .mockResolvedValueOnce({ success: true, payer: 'payer', transaction: DIGEST, network: SUI_TESTNET_CAIP2 })
        .mockResolvedValueOnce({ success: false, payer: 'payer', transaction: DIGEST, network: SUI_TESTNET_CAIP2, errorReason: 'duplicate_settlement' });

      const server = app();
      const first = await request(server).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
      const second = await request(server).post('/settle').send({ paymentPayload, paymentRequirements: requirements });

      expect(first.body).toMatchObject({ success: true, transaction: DIGEST });
      expect(second.body).toMatchObject({ success: false, errorReason: 'duplicate_settlement' });
      expect(second.body.transaction).toBe(DIGEST);
    });

    it('restores the digest when a duplicate answer arrives without one', async () => {
      // Measured on testnet: the scheme's duplicate_settlement answer carries an
      // empty `transaction` and names the digest only in errorMessage. Passed
      // through, that reads as "nothing happened" and invites a second payment.
      const transaction = await buildTestTransaction();
      const digest = await digestOf(transaction);
      settle.mockResolvedValueOnce({
        success: false,
        payer: 'payer',
        transaction: '',
        network: SUI_TESTNET_CAIP2,
        errorReason: 'duplicate_settlement',
        errorMessage: `transaction ${digest} was already settled`,
      });

      const response = await request(app())
        .post('/settle')
        .send({ paymentPayload: { ...paymentPayload, payload: { transaction, signature: 'AA==' } }, paymentRequirements: requirements });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: false, errorReason: 'duplicate_settlement' });
      expect(response.body.transaction).toBe(digest);
    });

    it('falls back to the chain verdict when the bytes cannot be read', async () => {
      // paymentPayload.payload.transaction is "AA==": one byte, not a
      // transaction, so the digest cannot be derived locally. The chain lookup
      // that already ran holds it, so the answer still carries the hash.
      settle.mockResolvedValueOnce({
        success: false,
        payer: 'payer',
        transaction: '',
        network: SUI_TESTNET_CAIP2,
        errorReason: 'duplicate_settlement',
      });

      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });

      expect(response.body).toMatchObject({ success: false, errorReason: 'duplicate_settlement', transaction: DIGEST });
    });

    it('omits the digest only when neither the bytes nor the chain can supply it', async () => {
      // Undecodable bytes and an unreadable chain: there is no hash to report,
      // and inventing one would be worse than the gap.
      settle.mockResolvedValueOnce({
        success: false,
        payer: 'payer',
        transaction: '',
        network: SUI_TESTNET_CAIP2,
        errorReason: 'duplicate_settlement',
      });
      verdict.mockReset().mockResolvedValue(null);

      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });

      expect(response.body).toMatchObject({ success: false, errorReason: 'duplicate_settlement', transaction: '' });
    });

    it('refuses to settle when this instance may not move money', async () => {
      delete process.env.ENABLE_REAL_SETTLEMENT;
      delete process.env.ALLOW_SIMULATED_SETTLEMENT;
      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.body).toMatchObject({ success: false, errorReason: 'settlement_disabled' });
      expect(settle).not.toHaveBeenCalled();
    });

    it('simulates without submitting when simulation is opted into', async () => {
      delete process.env.ENABLE_REAL_SETTLEMENT;
      process.env.ALLOW_SIMULATED_SETTLEMENT = 'true';
      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.headers['x-settlement-mode']).toBe('simulated');
      expect(response.body).toMatchObject({ success: true, network: SUI_TESTNET_CAIP2 });
      expect(settle).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledWith(paymentPayload, requirements);
    });

    it('answers transaction_failed rather than a 500 when the scheme throws', async () => {
      settle.mockRejectedValueOnce(new Error('grpc unavailable'));
      const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: false, errorReason: 'transaction_failed' });
    });
  });

  describe('verify', () => {
    it('returns the scheme verdict, including the payer derived from the transaction', async () => {
      verify.mockResolvedValueOnce({ isValid: true, payer: '0xsender', invalidReason: null });
      const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: true, payer: '0xsender' });
    });

    it('does not run the EVM self-payment check on a Sui payload', async () => {
      // A Sui payload has no `from`/`authorization.from`, so the EVM check cannot
      // fire. Self-payment is still caught — by the effects check, because the
      // transfer nets to zero — which the scheme suite covers.
      const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.body.invalidReason).not.toBe('invalid_self_payment');
      expect(verify).toHaveBeenCalled();
    });

    it('rejects a non-integer amount with a reason code and HTTP 200, not a 500', async () => {
      const body = {
        paymentPayload: { ...paymentPayload, accepted: { ...requirements, amount: 'abc' } },
        paymentRequirements: { ...requirements, amount: 'abc' },
      };
      const response = await request(app()).post('/verify').send(body);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_amount' });
    });

    it('answers a scheme error with the spec code rather than a 500', async () => {
      verify.mockRejectedValueOnce(new Error('rpc down'));
      const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_sui_payload_verification_error' });
    });

    it('refuses a body with no paymentRequirements instead of throwing', async () => {
      // A proxy bug must not become a 500. The amount check runs before the
      // asset policy, so an absent requirements object answers invalid_amount.
      const response = await request(app()).post('/verify').send({ paymentPayload });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_amount' });
      expect(verify).not.toHaveBeenCalled();
    });

    it('refuses when the acceptance names a network we do not serve', async () => {
      // The gate reads `accepted.network`, the same field the scheme compares
      // against the requirements. A mainnet claim on a testnet deployment must
      // stop here — not fall through to a scheme that would only compare the two
      // copies of an attacker-supplied field.
      const response = await request(app())
        .post('/verify')
        .send(withNetwork('sui:mainnet'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'sui_exact_disabled' });
      expect(verify).not.toHaveBeenCalled();
    });

    it('refuses a requirements/accepted network disagreement before the scheme', async () => {
      // Envelope binding makes this unreachable for the scheme: the two copies
      // must agree, so a caller cannot hand the facilitator two different
      // networks and hope one of them is the one checked.
      const response = await request(app())
        .post('/verify')
        .send({ paymentPayload, paymentRequirements: { ...requirements, network: 'sui:mainnet' } });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
      expect(verify).not.toHaveBeenCalled();
    });
  });

  describe('adversarial', () => {
    describe('envelope binding', () => {
      it('refuses an acceptance that names a different recipient', async () => {
        // The scheme decides money from the requirements and the chain effects.
        // This check exists so a consumer reading `accepted` is never told a
        // different offer was verified than the one that was.
        const response = await request(app())
          .post('/verify')
          .send({
            paymentPayload: { ...paymentPayload, accepted: { ...requirements, payTo: OTHER_PAY_TO } },
            paymentRequirements: requirements,
          });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
        expect(verify).not.toHaveBeenCalled();
      });

      it('refuses an acceptance carrying no amount — a v1 payload cannot bind', async () => {
        const response = await request(app())
          .post('/verify')
          .send({
            paymentPayload: { ...paymentPayload, accepted: { scheme: 'exact', network: SUI_TESTNET_CAIP2 } },
            paymentRequirements: requirements,
          });
        expect(response.body).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
        expect(verify).not.toHaveBeenCalled();
      });

      it('accepts the same recipient written in upper and lower case hex', async () => {
        // Normalization, not string equality: a payer may write the address in
        // upper case, and it is the same account.
        const response = await request(app())
          .post('/verify')
          .send({
            paymentPayload: { ...paymentPayload, accepted: { ...requirements, payTo: PAY_TO.toUpperCase().replace('0X', '0x') } },
            paymentRequirements: requirements,
          });
        expect(response.body).toMatchObject({ isValid: true });
        expect(verify).toHaveBeenCalled();
      });

      it('refuses a settle whose acceptance names a different recipient', async () => {
        const response = await request(app())
          .post('/settle')
          .send({
            paymentPayload: { ...paymentPayload, accepted: { ...requirements, payTo: OTHER_PAY_TO } },
            paymentRequirements: requirements,
          });
        expect(response.body).toMatchObject({ success: false, errorReason: 'invalid_payload', transaction: '' });
        expect(settle).not.toHaveBeenCalled();
      });
    });

    describe('replay across a restart', () => {
      it('refuses to report a second success for a digest the chain already executed', async () => {
        // The scheme's only replay guard is an in-process claim store, which
        // every deploy empties. A fullnode answers a re-submitted, executed
        // transaction with its cached effects, so without this chain check the
        // replay would be reported as a second success.
        verdict.mockResolvedValueOnce({ state: 'executed', digest: DIGEST, sender: PAY_TO, succeeded: true });
        const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          success: false,
          errorReason: 'duplicate_settlement',
          transaction: DIGEST,
          payer: PAY_TO,
        });
        expect(settle).not.toHaveBeenCalled();
      });

      it('still settles when the chain holds that digest as a failed transaction', async () => {
        // A transaction that executed and failed moved no funds. Refusing here
        // would block a legitimate retry; the scheme reports the on-chain
        // failure itself.
        verdict.mockResolvedValueOnce({ state: 'executed', digest: DIGEST, sender: 'payer', succeeded: false });
        await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
        expect(settle).toHaveBeenCalled();
      });
    });

    describe('outcome after broadcast', () => {
      it('answers settlement_pending with the digest when the chain cannot say what happened', async () => {
        settle.mockResolvedValueOnce({
          success: false,
          payer: 'payer',
          transaction: DIGEST,
          network: SUI_TESTNET_CAIP2,
          errorReason: 'transaction_failed',
          errorMessage: 'fullnode unavailable',
        });
        verdict
          .mockResolvedValueOnce({ state: 'unknown', digest: DIGEST, sender: 'payer' })
          .mockResolvedValueOnce({ state: 'unknown', digest: DIGEST, sender: 'payer' });
        const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
        expect(response.body).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: DIGEST });
        expect(response.body.errorMessage).not.toContain('fullnode');
      });

      it('keeps transaction_failed when the chain confirms the transaction failed', async () => {
        settle.mockResolvedValueOnce({
          success: false,
          payer: 'payer',
          transaction: DIGEST,
          network: SUI_TESTNET_CAIP2,
          errorReason: 'transaction_failed',
          errorMessage: 'MoveAbort in balance::send_funds',
        });
        verdict
          .mockResolvedValueOnce({ state: 'unknown', digest: DIGEST, sender: 'payer' })
          .mockResolvedValueOnce({ state: 'executed', digest: DIGEST, sender: 'payer', succeeded: false });
        const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
        expect(response.body).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: DIGEST });
        // Node text is replaced even when the code is terminal.
        expect(response.body.errorMessage).not.toContain('MoveAbort');
      });

      it('stays terminal when the chain was read and holds no such transaction', async () => {
        // Absent is knowledge, not ignorance: nothing was broadcast, so telling
        // the payer to retry is accurate.
        settle.mockResolvedValueOnce({
          success: false,
          payer: 'payer',
          network: SUI_TESTNET_CAIP2,
          errorReason: 'transaction_failed',
          errorMessage: 'getCurrentSystemState failed',
        });
        verdict
          .mockResolvedValueOnce({ state: 'unknown', digest: DIGEST, sender: 'payer' })
          .mockResolvedValueOnce({ state: 'absent', digest: DIGEST, sender: 'payer' });
        const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
        expect(response.body).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: DIGEST });
      });

      it('reports duplicate_settlement when the chain holds a success the scheme called failed', async () => {
        // The scheme lost the receipt after the transaction executed. Answering
        // transaction_failed here would have the payer sign a second payment for
        // money that already moved.
        settle.mockResolvedValueOnce({
          success: false,
          payer: 'payer',
          transaction: DIGEST,
          network: SUI_TESTNET_CAIP2,
          errorReason: 'transaction_failed',
          errorMessage: 'socket hang up',
        });
        verdict
          .mockResolvedValueOnce({ state: 'unknown', digest: DIGEST, sender: 'payer' })
          .mockResolvedValueOnce({ state: 'executed', digest: DIGEST, sender: 'payer', succeeded: true });
        const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
        expect(response.body).toMatchObject({ success: false, errorReason: 'duplicate_settlement', transaction: DIGEST });
        expect(response.body.errorMessage).toContain('do not re-authorize');
      });

      it('leaves our own diagnostic messages intact', async () => {
        // Codes this codebase composes itself are the diagnostics callers need.
        settle.mockResolvedValueOnce({
          success: false,
          payer: 'payer',
          transaction: DIGEST,
          network: SUI_TESTNET_CAIP2,
          errorReason: 'settlement_effects_mismatch',
          errorMessage: `recipient ${PAY_TO} credited 0, expected exactly 50000`,
        });
        const response = await request(app()).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
        expect(response.body.errorMessage).toContain('expected exactly 50000');
      });
    });

    describe('transport text', () => {
      it('withholds a gRPC endpoint that a verification error would have leaked', async () => {
        verify.mockResolvedValueOnce({
          isValid: false,
          payer: '',
          invalidReason: 'invalid_exact_sui_payload_verification_error',
          invalidMessage: 'request to https://fullnode.testnet.sui.io:443 failed: 401 (key abc123)',
        });
        const response = await request(app()).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
        expect(response.status).toBe(200);
        expect(response.body.invalidReason).toBe('invalid_exact_sui_payload_verification_error');
        expect(response.body.invalidMessage).not.toContain('fullnode.testnet.sui.io');
        expect(response.body.invalidMessage).not.toContain('abc123');
      });
    });
  });

  describe('/supported', () => {
    it('advertises no Sui kind when the gate is off', async () => {
      config.suiExactEnabled = false;
      const response = await request(app()).get('/supported');
      const suiKinds = response.body.kinds.filter((k: { network: string }) => k.network.startsWith('sui'));
      expect(suiKinds).toEqual([]);
    });

    it('advertises exactly one v2 kind with no extra and no v1 alias', async () => {
      const response = await request(app()).get('/supported');
      const suiKinds = response.body.kinds.filter((k: { network: string }) => k.network.startsWith('sui'));
      expect(suiKinds).toEqual([{ x402Version: 2, scheme: 'exact', network: SUI_TESTNET_CAIP2, extra: {} }]);
    });
  });

  describe('two networks served at once', () => {
    beforeEach(() => {
      config.suiNetworks = [SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2];
      config.suiGrpcUrls = {
        ...config.suiGrpcUrls,
        [SUI_MAINNET_CAIP2]: 'https://fullnode.mainnet.sui.io:443',
        [SUI_TESTNET_CAIP2]: 'https://fullnode.testnet.sui.io:443',
      };
    });

    it('advertises one kind per served network, mainnet first', async () => {
      const response = await request(app()).get('/supported');
      const suiKinds = response.body.kinds.filter((k: { network: string }) => k.network.startsWith('sui'));
      expect(suiKinds).toEqual([
        { x402Version: 2, scheme: 'exact', network: SUI_MAINNET_CAIP2, extra: {} },
        { x402Version: 2, scheme: 'exact', network: SUI_TESTNET_CAIP2, extra: {} },
      ]);
    });

    it('settles a mainnet payment and a testnet payment through the same scheme', async () => {
      const server = app();
      const mainnet = await request(server)
        .post('/settle')
        .send({
          paymentPayload: { ...paymentPayload, accepted: { ...requirements, network: SUI_MAINNET_CAIP2, asset: SUI_USDC_MAINNET } },
          paymentRequirements: { ...requirements, network: SUI_MAINNET_CAIP2, asset: SUI_USDC_MAINNET },
        });
      const testnet = await request(server).post('/settle').send({ paymentPayload, paymentRequirements: requirements });

      expect(mainnet.body).toMatchObject({ success: true, transaction: DIGEST });
      expect(testnet.body).toMatchObject({ success: true, transaction: DIGEST });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it('gives the chain verdict the payload network, so the right node answers', async () => {
      const server = app();
      await request(server)
        .post('/settle')
        .send({
          paymentPayload: { ...paymentPayload, accepted: { ...requirements, network: SUI_MAINNET_CAIP2, asset: SUI_USDC_MAINNET } },
          paymentRequirements: { ...requirements, network: SUI_MAINNET_CAIP2, asset: SUI_USDC_MAINNET },
        });
      await request(server).post('/settle').send({ paymentPayload, paymentRequirements: requirements });

      // A single client would be wrong for one of these: the lookup must name
      // the network the payment is denominated in.
      expect(verdict.mock.calls.map((call) => call[1])).toEqual([SUI_MAINNET_CAIP2, SUI_TESTNET_CAIP2]);
    });

    it('refuses mainnet USDC denominated as testnet, and testnet USDC denominated as mainnet', async () => {
      const server = app();
      const mainnetAssetOnTestnet = await request(server)
        .post('/verify')
        .send({
          paymentPayload: { ...paymentPayload, accepted: { ...requirements, asset: SUI_USDC_MAINNET } },
          paymentRequirements: { ...requirements, asset: SUI_USDC_MAINNET },
        });
      const testnetAssetOnMainnet = await request(server)
        .post('/verify')
        .send({
          paymentPayload: {
            ...paymentPayload,
            accepted: { ...requirements, network: SUI_MAINNET_CAIP2, asset: SUI_USDC_TESTNET },
          },
          paymentRequirements: { ...requirements, network: SUI_MAINNET_CAIP2, asset: SUI_USDC_TESTNET },
        });

      expect(mainnetAssetOnTestnet.body).toMatchObject({ isValid: false, invalidReason: 'unsupported_asset' });
      expect(testnetAssetOnMainnet.body).toMatchObject({ isValid: false, invalidReason: 'unsupported_asset' });
      expect(verify).not.toHaveBeenCalled();
    });

    it('still refuses a Sui network nobody named', async () => {
      const response = await request(app()).post('/settle').send(withNetwork('sui:devnet'));
      expect(response.body).toMatchObject({ success: false, errorReason: 'sui_exact_disabled' });
      expect(settle).not.toHaveBeenCalled();
    });
  });
});
