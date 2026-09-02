/**
 * Settlement mode — /settle must never report a settlement that did not happen.
 *
 * Regression tests for issue #2. With ENABLE_REAL_SETTLEMENT unset (or any value
 * other than "true") the route used to fall through to simulation and answer
 * success:true with a random hash. Simulation is now opt-in through
 * ALLOW_SIMULATED_SETTLEMENT, and a simulated response says so in an
 * X-Settlement-Mode header (the body stays a plain SettleResponse).
 */

import request from 'supertest';
import express from 'express';
import { settlePayment } from '../routes/settle';
import { createBasePayment, createPaymentRequirements } from './fixtures/payment-fixtures';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/settle', settlePayment);
  return app;
}

function settle(app: express.Application, paymentPayload: any, paymentRequirements: any) {
  return request(app).post('/settle').send({ paymentPayload, paymentRequirements });
}

/** The handler reads both flags per request, so tests can flip them without re-importing. */
function setMode(real: string | undefined, simulated: string | undefined) {
  if (real === undefined) delete process.env.ENABLE_REAL_SETTLEMENT;
  else process.env.ENABLE_REAL_SETTLEMENT = real;
  if (simulated === undefined) delete process.env.ALLOW_SIMULATED_SETTLEMENT;
  else process.env.ALLOW_SIMULATED_SETTLEMENT = simulated;
}

const HEX_HASH = /^0x[0-9a-f]+$/;

describe('Settlement mode', () => {
  const app = createTestApp();
  const requirements = createPaymentRequirements('eip155:8453');
  const saved = {
    real: process.env.ENABLE_REAL_SETTLEMENT,
    simulated: process.env.ALLOW_SIMULATED_SETTLEMENT,
  };

  afterEach(() => setMode(saved.real, saved.simulated));

  it('refuses to settle when neither flag is set, and fabricates nothing', async () => {
    setMode(undefined, undefined);

    const response = await settle(app, createBasePayment({ nonce: 9001 }), requirements);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: 'settlement_disabled',
      transaction: '',
      network: 'eip155:8453',
    });
    expect(response.headers['x-settlement-mode']).toBeUndefined();
  });

  it('treats ENABLE_REAL_SETTLEMENT=false exactly like unset', async () => {
    setMode('false', undefined);

    const response = await settle(app, createBasePayment({ nonce: 9002 }), requirements);

    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('settlement_disabled');
    expect(response.body.transaction).toBe('');
  });

  it('does not remember a refused settlement as settled', async () => {
    // A refusal must leave no trace in the nonce tracker. The same permit,
    // retried once settlement is enabled, has to be settled rather than
    // answered from the replay cache with the refusal's empty hash.
    const paymentPayload = createBasePayment({ nonce: 9003 });

    setMode(undefined, undefined);
    const refused = await settle(app, paymentPayload, requirements);
    expect(refused.body.success).toBe(false);

    setMode(undefined, 'true');
    const retried = await settle(app, paymentPayload, requirements);
    expect(retried.body.success).toBe(true);
    expect(retried.body.transaction).toMatch(HEX_HASH);
    expect(retried.headers['x-settlement-mode']).toBe('simulated');
  });

  it('marks a simulated settlement so it cannot pass for a real one', async () => {
    setMode(undefined, 'true');

    const response = await settle(app, createBasePayment({ nonce: 9004 }), requirements);

    expect(response.body.success).toBe(true);
    expect(response.headers['x-settlement-mode']).toBe('simulated');
    expect(response.body.transaction).toMatch(HEX_HASH);
    // The body itself stays a plain SettleResponse
    expect(Object.keys(response.body).sort()).toEqual(['network', 'payer', 'success', 'transaction']);
  });

  it('keeps the marker on an idempotent replay of a simulated settlement', async () => {
    setMode(undefined, 'true');
    const paymentPayload = createBasePayment({ nonce: 9005 });

    const first = await settle(app, paymentPayload, requirements);
    const replay = await settle(app, paymentPayload, requirements);

    expect(replay.body.success).toBe(true);
    expect(replay.body.transaction).toBe(first.body.transaction);
    expect(replay.headers['x-settlement-mode']).toBe('simulated');
  });
});
