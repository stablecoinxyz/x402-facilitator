/**
 * /health settlement field — the bundled demo client uses it as a refuse-to-settle
 * safety gate (demo/demo-client.ts): it aborts unless the field reads 'simulated'.
 * These assert the field is the mode resolveSettlementMode() actually resolves, so a
 * regression that drops or mis-resolves it fails here instead of silently disabling
 * the demo guard.
 */

import request from 'supertest';
import express from 'express';
import { healthCheck } from '../routes/health';

function createTestApp() {
  const app = express();
  app.get('/health', healthCheck);
  return app;
}

/** The handler reads both flags per request, so tests can flip them without re-importing. */
function setMode(real: string | undefined, simulated: string | undefined) {
  if (real === undefined) delete process.env.ENABLE_REAL_SETTLEMENT;
  else process.env.ENABLE_REAL_SETTLEMENT = real;
  if (simulated === undefined) delete process.env.ALLOW_SIMULATED_SETTLEMENT;
  else process.env.ALLOW_SIMULATED_SETTLEMENT = simulated;
}

describe('GET /health', () => {
  const app = createTestApp();
  const saved = {
    real: process.env.ENABLE_REAL_SETTLEMENT,
    simulated: process.env.ALLOW_SIMULATED_SETTLEMENT,
  };

  afterEach(() => setMode(saved.real, saved.simulated));

  it('reports status ok (conformance depends on this)', async () => {
    setMode(undefined, undefined);
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('resolves settlement to disabled when neither flag is set', async () => {
    setMode(undefined, undefined);
    const response = await request(app).get('/health');
    expect(response.body.settlement).toBe('disabled');
  });

  it('treats ENABLE_REAL_SETTLEMENT=false as disabled', async () => {
    setMode('false', undefined);
    const response = await request(app).get('/health');
    expect(response.body.settlement).toBe('disabled');
  });

  it('reports simulated when only ALLOW_SIMULATED_SETTLEMENT is set', async () => {
    setMode(undefined, 'true');
    const response = await request(app).get('/health');
    expect(response.body.settlement).toBe('simulated');
  });

  it('reports real when ENABLE_REAL_SETTLEMENT is true', async () => {
    setMode('true', undefined);
    const response = await request(app).get('/health');
    expect(response.body.settlement).toBe('real');
  });

  it('reports real (not simulated) when both flags are set, so the demo gate refuses', async () => {
    setMode('true', 'true');
    const response = await request(app).get('/health');
    expect(response.body.settlement).toBe('real');
  });
});
