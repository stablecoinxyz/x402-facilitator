import request from 'supertest';
import express from 'express';
import { config, toCaip2Network } from '../config';
import { verifyPayment } from '../routes/verify';
import { settlePayment } from '../routes/settle';
import { getSupportedNetworks } from '../routes/supported';

const PAYER = 'account-hash-' + 'a'.repeat(64);
const PAYEE = 'account-hash-' + 'b'.repeat(64);
const CONTRACT = 'hash-' + 'c'.repeat(64);
const app = express();
app.use(express.json());
app.post('/verify', verifyPayment);
app.post('/settle', settlePayment);
app.get('/supported', getSupportedNetworks);

function payment(network: string, version: number, overrides = {}) {
  const payload = {
    from: PAYER, to: PAYEE, amount: '50000000', nonce: 'route-test',
    deadline: Math.floor(Date.now() / 1000) + 600, signature: '0'.repeat(128),
    futureCasperField: { preserved: true },
  };
  return {
    paymentPayload: version === 1 ? payload : {
      x402Version: 2, accepted: { scheme: 'exact', network }, payload, extensions: {},
    },
    paymentRequirements: {
      scheme: 'exact', network, payTo: PAYEE,
      ...(version === 1 ? { maxAmountRequired: '50000000' } : { amount: '50000000' }),
      ...overrides,
    },
  };
}

const cases = [
  ['unconfigured', '', '', ''],
  ['address only', PAYER, '', ''],
  ['contracts only', '', CONTRACT, CONTRACT],
  ['mainnet only', PAYER, CONTRACT, ''],
  ['testnet only', PAYER, '', CONTRACT],
  ['both networks', PAYER, CONTRACT, CONTRACT],
];

for (const route of ['/verify', '/settle']) {
  describe(`Casper ${route} capability gate`, () => {
    const savedConfig = { ...config };
    const savedEnv = process.env;
    const savedFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
      // Casper forwards to a service, independent of the EVM settlement flags.
      process.env = { ...savedEnv };
      delete process.env.ENABLE_REAL_SETTLEMENT;
      delete process.env.ALLOW_SIMULATED_SETTLEMENT;
      fetchMock = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        text: async () => JSON.stringify(route === '/verify'
          ? { isValid: true, payer: PAYER, invalidReason: null }
          : { success: true, payer: PAYER, transaction: 'd'.repeat(64) }),
      });
      global.fetch = fetchMock;
    });

    afterEach(() => {
      Object.assign(config, savedConfig);
      process.env = savedEnv;
      global.fetch = savedFetch;
    });

    for (const [label, address, mainnet, testnet] of cases) {
      describe(label, () => {
        it.each([
          ['casper:casper', 2], ['casper:casper-test', 2], ['casper:unknown', 2],
          ['casper', 1], ['casper-test', 1], ['casper-testnet', 1],
        ])('%s v%s matches /supported and never forwards disabled networks', async (network, version) => {
          Object.assign(config, {
            casperFacilitatorAddress: address,
            casperWcsprContract: mainnet,
            casperTestnetWcsprContract: testnet,
          });
          const canonical = toCaip2Network(network);
          const supported = await request(app).get('/supported');
          const enabled = supported.body.kinds.some((kind: any) => kind.network === canonical);
          const response = await request(app).post(route).send(payment(String(network), Number(version)));
          expect(response.status).toBe(200);
          expect(response.body.payer).toBe(PAYER);
          if (!enabled) {
            expect(response.body).toEqual(route === '/verify'
              ? { isValid: false, payer: PAYER, invalidReason: 'invalid_network' }
              : { success: false, payer: PAYER, transaction: '', network: canonical, errorReason: 'invalid_network' });
            expect(fetchMock).not.toHaveBeenCalled();
          } else {
            expect(response.body[route === '/verify' ? 'isValid' : 'success']).toBe(true);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe(config.casperFacilitatorUrl + route);
            const sent = JSON.parse(init.body);
            expect(sent.paymentPayload.accepted.network).toBe(canonical);
            expect(sent.paymentPayload.payload.futureCasperField).toEqual({ preserved: true });
            expect(sent.paymentRequirements.asset).toBe(canonical === 'casper:casper' ? mainnet : testnet);
          }
        });
      });
    }

    it.each([
      [{ amount: '0' }, 'invalid_amount'],
      [{ payTo: PAYER }, 'invalid_self_payment'],
    ])('preserves upstream payment guard %j', async (overrides, reason) => {
      Object.assign(config, {
        casperFacilitatorAddress: PAYER, casperWcsprContract: CONTRACT,
      });
      const response = await request(app).post(route).send(payment('casper:casper', 2, overrides));
      expect(response.body[route === '/verify' ? 'invalidReason' : 'errorReason']).toBe(reason);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
}
