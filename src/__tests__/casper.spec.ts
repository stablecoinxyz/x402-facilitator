/**
 * Casper Network Support Tests
 *
 * Covers the Casper mechanism end to end with the Casper facilitator service
 * mocked — no live network calls.
 */

import request from 'supertest';
import express from 'express';
import { getSupportedNetworks } from '../routes/supported';
import { toCaip2Network, toV1Network } from '../config';
import {
  CASPER_MAINNET_CAIP2,
  CASPER_TESTNET_CAIP2,
  CASPER_DECIMALS,
  isCasperNetwork,
  resolveCasperNetwork,
  isCasperAccountHash,
  isCasperPublicKey,
  isValidCasperAddress,
  isSameCasperAddress,
  parseMotes,
  csprToMotes,
  motesToCspr,
} from '../casper/networks';
import { verifyCasperPayment } from '../casper/verify';
import { settleCasperPayment } from '../casper/settle';
import { CasperFacilitatorError } from '../casper/client';

const PAYER = 'account-hash-' + 'a'.repeat(64);
const PAYEE = 'account-hash-' + 'b'.repeat(64);
const PUBKEY_ED25519 = '01' + 'c'.repeat(64);
const PUBKEY_SECP256K1 = '02' + 'd'.repeat(66);

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    from: PAYER,
    to: PAYEE,
    amount: '50000000', // 0.05 wCSPR
    nonce: 'nonce-1',
    deadline: Math.floor(Date.now() / 1000) + 600,
    signature: '0'.repeat(128),
    ...overrides,
  } as any;
}

function baseRequirements(overrides: Record<string, unknown> = {}) {
  return {
    amount: '50000000',
    payTo: PAYEE,
    ...overrides,
  } as any;
}

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    text: async () => JSON.stringify(body),
  });
  (global as any).fetch = fn;
  return fn;
}

describe('Casper network registry', () => {
  it('exposes CAIP-2 identifiers for mainnet and testnet', () => {
    expect(CASPER_MAINNET_CAIP2).toBe('casper:casper');
    expect(CASPER_TESTNET_CAIP2).toBe('casper:casper-test');
  });

  it('detects the casper CAIP-2 namespace', () => {
    expect(isCasperNetwork(CASPER_MAINNET_CAIP2)).toBe(true);
    expect(isCasperNetwork(CASPER_TESTNET_CAIP2)).toBe(true);
    expect(isCasperNetwork('eip155:8453')).toBe(false);
    expect(isCasperNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(false);
    expect(isCasperNetwork(undefined)).toBe(false);
  });

  it('resolves known networks and rejects unknown ones', () => {
    expect(resolveCasperNetwork(CASPER_MAINNET_CAIP2)).toMatchObject({ chainName: 'casper', testnet: false });
    expect(resolveCasperNetwork(CASPER_TESTNET_CAIP2)).toMatchObject({ chainName: 'casper-test', testnet: true });
    expect(resolveCasperNetwork('casper:nope')).toBeNull();
  });

  it('normalizes v1 names to CAIP-2 and back', () => {
    expect(toCaip2Network('casper')).toBe(CASPER_MAINNET_CAIP2);
    expect(toCaip2Network('casper-test')).toBe(CASPER_TESTNET_CAIP2);
    expect(toCaip2Network('casper-testnet')).toBe(CASPER_TESTNET_CAIP2);
    expect(toCaip2Network(CASPER_MAINNET_CAIP2)).toBe(CASPER_MAINNET_CAIP2);
    expect(toV1Network(CASPER_MAINNET_CAIP2)).toBe('casper');
    expect(toV1Network(CASPER_TESTNET_CAIP2)).toBe('casper-test');
  });
});

describe('Casper address validation', () => {
  it('accepts account hashes', () => {
    expect(isCasperAccountHash(PAYER)).toBe(true);
    expect(isValidCasperAddress(PAYER)).toBe(true);
  });

  it('accepts ed25519 and secp256k1 public keys', () => {
    expect(isCasperPublicKey(PUBKEY_ED25519)).toBe(true);
    expect(isCasperPublicKey(PUBKEY_SECP256K1)).toBe(true);
    expect(isValidCasperAddress(PUBKEY_ED25519)).toBe(true);
  });

  it('rejects malformed and foreign addresses', () => {
    expect(isValidCasperAddress('0x1234')).toBe(false);
    expect(isValidCasperAddress('account-hash-abc')).toBe(false);
    expect(isCasperPublicKey('01' + 'c'.repeat(63))).toBe(false);
    expect(isCasperPublicKey('03' + 'c'.repeat(64))).toBe(false);
    expect(isValidCasperAddress(undefined)).toBe(false);
  });

  it('compares addresses case-insensitively but never across encodings', () => {
    expect(isSameCasperAddress(PAYER, PAYER.toUpperCase())).toBe(true);
    expect(isSameCasperAddress(PAYER, PAYEE)).toBe(false);
    expect(isSameCasperAddress(PAYER, PUBKEY_ED25519)).toBe(false);
  });
});

describe('Casper mote conversion', () => {
  it('uses 9 decimals', () => {
    expect(CASPER_DECIMALS).toBe(9);
  });

  it('parses integer mote strings exactly', () => {
    expect(parseMotes('50000000')).toBe(50000000n);
    expect(parseMotes('0')).toBe(0n);
    // Beyond Number.MAX_SAFE_INTEGER — must survive without precision loss
    expect(parseMotes('9007199254740993')).toBe(9007199254740993n);
  });

  it('throws on sub-mote precision rather than truncating', () => {
    expect(() => parseMotes('1.5')).toThrow(/whole number of motes/);
    expect(() => csprToMotes('0.0000000001')).toThrow(/sub-mote precision/);
    expect(() => parseMotes(1.5)).toThrow(/whole number of motes/);
  });

  it('throws on malformed or negative amounts', () => {
    expect(() => parseMotes('')).toThrow();
    expect(() => parseMotes('abc')).toThrow();
    expect(() => parseMotes(-1n)).toThrow(/negative/);
    expect(() => csprToMotes('not-a-number')).toThrow(/Invalid CSPR amount/);
  });

  it('converts CSPR to motes with exact integer math', () => {
    expect(csprToMotes('1')).toBe(1000000000n);
    expect(csprToMotes('0.05')).toBe(50000000n);
    expect(csprToMotes('1.234567891')).toBe(1234567891n);
    expect(csprToMotes('0.000000001')).toBe(1n);
  });

  it('round-trips motes back to CSPR without float rounding', () => {
    expect(motesToCspr(1000000000n)).toBe('1');
    expect(motesToCspr(50000000n)).toBe('0.05');
    expect(motesToCspr('1234567891')).toBe('1.234567891');
    expect(motesToCspr(csprToMotes('123456789.123456789'))).toBe('123456789.123456789');
  });
});

describe('GET /supported - Casper kinds', () => {
  const OLD_ENV = process.env;

  function createTestApp() {
    const app = express();
    app.use(express.json());
    app.get('/supported', getSupportedNetworks);
    return app;
  }

  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
  });

  it('omits Casper kinds when Casper is not configured', async () => {
    const response = await request(createTestApp()).get('/supported');
    const casperKinds = response.body.kinds.filter((k: any) => String(k.network).startsWith('casper'));
    expect(casperKinds).toHaveLength(0);
  });

  it('advertises both v2 CAIP-2 and v1 plain-name kinds when configured', () => {
    jest.isolateModules(() => {
      process.env = {
        ...OLD_ENV,
        CASPER_FACILITATOR_ADDRESS: PAYER,
        CASPER_WCSPR_CONTRACT: 'hash-' + 'e'.repeat(64),
        CASPER_TESTNET_WCSPR_CONTRACT: 'hash-' + 'f'.repeat(64),
      };

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getSupportedNetworks: handler } = require('../routes/supported');

      const json = jest.fn();
      handler({ headers: {} } as any, { json, send: jest.fn() } as any);

      const data = json.mock.calls[0][0];
      const networks = data.kinds.map((k: any) => `${k.x402Version}:${k.network}`);

      expect(networks).toContain('2:casper:casper');
      expect(networks).toContain('2:casper:casper-test');
      expect(networks).toContain('1:casper');
      expect(networks).toContain('1:casper-test');

      const casperKind = data.kinds.find((k: any) => k.network === 'casper:casper');
      expect(casperKind.scheme).toBe('exact');
      expect(casperKind.extra).toEqual({ assetTransferMethod: 'cep18-transfer', name: 'wCSPR', version: '1' });
      expect(data.signers['casper:*']).toEqual([PAYER]);
    });
  });
});

describe('verifyCasperPayment', () => {
  afterEach(() => {
    delete (global as any).fetch;
    jest.restoreAllMocks();
  });

  it('returns valid when the Casper facilitator accepts the payment', async () => {
    const fetchMock = mockFetch({ isValid: true, payer: PAYER, invalidReason: null });

    const result = await verifyCasperPayment(basePayload(), baseRequirements(), CASPER_MAINNET_CAIP2);

    expect(result).toEqual({ isValid: true, payer: PAYER, invalidReason: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/verify$/);
    const sent = JSON.parse(init.body);
    expect(sent.paymentPayload.x402Version).toBe(2);
    expect(sent.paymentPayload.accepted).toEqual({ scheme: 'exact', network: CASPER_MAINNET_CAIP2 });
    expect(sent.paymentPayload.payload.amount).toBe('50000000');
    expect(sent.paymentRequirements.network).toBe(CASPER_MAINNET_CAIP2);
  });

  it('propagates an invalid verdict from the Casper facilitator', async () => {
    mockFetch({ isValid: false, payer: PAYER, invalidReason: 'insufficient_funds' });

    const result = await verifyCasperPayment(basePayload(), baseRequirements(), CASPER_MAINNET_CAIP2);

    expect(result).toEqual({ isValid: false, payer: PAYER, invalidReason: 'insufficient_funds' });
  });

  it('rejects an unknown Casper network without calling out', async () => {
    const fetchMock = mockFetch({ isValid: true, payer: PAYER, invalidReason: null });

    const result = await verifyCasperPayment(basePayload(), baseRequirements(), 'casper:nope');

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('invalid_network');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid payer address', async () => {
    const result = await verifyCasperPayment(basePayload({ from: '0xdeadbeef' }), baseRequirements(), CASPER_MAINNET_CAIP2);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_signature');
  });

  it('rejects a sub-mote amount instead of truncating', async () => {
    const result = await verifyCasperPayment(basePayload({ amount: '0.5' }), baseRequirements(), CASPER_MAINNET_CAIP2);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_value_mismatch');
  });

  it('rejects an underpayment', async () => {
    const result = await verifyCasperPayment(
      basePayload({ amount: '49999999' }),
      baseRequirements(),
      CASPER_MAINNET_CAIP2,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_value_mismatch');
  });

  it('rejects a recipient mismatch', async () => {
    const result = await verifyCasperPayment(
      basePayload(),
      baseRequirements({ payTo: 'account-hash-' + '9'.repeat(64) }),
      CASPER_MAINNET_CAIP2,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_recipient_mismatch');
  });

  it('rejects an expired deadline', async () => {
    const result = await verifyCasperPayment(
      basePayload({ deadline: Math.floor(Date.now() / 1000) - 60 }),
      baseRequirements(),
      CASPER_MAINNET_CAIP2,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_valid_before');
  });

  it('accepts the v1 maxAmountRequired field', async () => {
    mockFetch({ isValid: true, payer: PAYER, invalidReason: null });
    const result = await verifyCasperPayment(
      basePayload(),
      { payTo: PAYEE, maxAmountRequired: '50000000' } as any,
      CASPER_TESTNET_CAIP2,
    );
    expect(result.isValid).toBe(true);
  });

  it('surfaces a facilitator transport failure as an invalid result', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await verifyCasperPayment(basePayload(), baseRequirements(), CASPER_MAINNET_CAIP2);

    expect(result.isValid).toBe(false);
    expect(result.payer).toBe(PAYER);
    expect(result.invalidReason).toMatch(/unreachable/);
  });

  it('surfaces a non-2xx facilitator response as an error', async () => {
    mockFetch({ invalidReason: 'bad_request' }, false, 400);

    const result = await verifyCasperPayment(basePayload(), baseRequirements(), CASPER_MAINNET_CAIP2);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/bad_request/);
  });
});

describe('settleCasperPayment', () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  it('returns the transaction hash on a successful settlement', async () => {
    const fetchMock = mockFetch({
      success: true,
      payer: PAYER,
      transaction: 'deadbeef'.repeat(8),
      network: CASPER_MAINNET_CAIP2,
    });

    const result = await settleCasperPayment(basePayload(), baseRequirements(), CASPER_MAINNET_CAIP2);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe('deadbeef'.repeat(8));
    expect(result.network).toBe(CASPER_MAINNET_CAIP2);
    expect(result.errorReason).toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/settle$/);
  });

  it('reports an unknown network without calling out', async () => {
    const fetchMock = mockFetch({ success: true, payer: PAYER, transaction: 'x', network: 'casper:nope' });

    const result = await settleCasperPayment(basePayload(), baseRequirements(), 'casper:nope');

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('invalid_network');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a sub-mote amount as a settlement error', async () => {
    const result = await settleCasperPayment(basePayload({ amount: '1.5' }), baseRequirements(), CASPER_MAINNET_CAIP2);

    expect(result.success).toBe(false);
    expect(result.errorReason).toMatch(/whole number of motes/);
    expect(result.transaction).toBe('');
  });

  it('propagates a failed settlement from the Casper facilitator', async () => {
    mockFetch({ success: false, payer: PAYER, transaction: '', network: CASPER_MAINNET_CAIP2, errorReason: 'deploy_failed' });

    const result = await settleCasperPayment(basePayload(), baseRequirements(), CASPER_MAINNET_CAIP2);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('deploy_failed');
  });

  it('reports a transport failure without throwing', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('socket hang up'));

    const result = await settleCasperPayment(basePayload(), baseRequirements(), CASPER_TESTNET_CAIP2);

    expect(result.success).toBe(false);
    expect(result.network).toBe(CASPER_TESTNET_CAIP2);
    expect(result.errorReason).toMatch(/unreachable/);
  });
});

describe('CasperFacilitatorError', () => {
  it('carries the HTTP status when there is one', () => {
    const err = new CasperFacilitatorError('boom', 502);
    expect(err.name).toBe('CasperFacilitatorError');
    expect(err.status).toBe(502);
    expect(new CasperFacilitatorError('boom').status).toBeNull();
  });
});
