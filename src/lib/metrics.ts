import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { Request, Response } from 'express';

const register = new Registry();
collectDefaultMetrics({ register });

export const verifyTotal = new Counter({
  name: 'x402_verify_total',
  help: 'Total verify requests',
  labelNames: ['network', 'result'] as const,
  registers: [register],
});

export const settleTotal = new Counter({
  name: 'x402_settle_total',
  help: 'Total settle requests',
  labelNames: ['network', 'result'] as const,
  registers: [register],
});

export const verifyDuration = new Histogram({
  name: 'x402_verify_duration_seconds',
  help: 'Verify request duration in seconds',
  labelNames: ['network'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const settleDuration = new Histogram({
  name: 'x402_settle_duration_seconds',
  help: 'Settle request duration in seconds',
  labelNames: ['network'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export async function metricsHandler(_req: Request, res: Response) {
  const token = process.env.METRICS_TOKEN;
  if (!token) {
    return res.status(404).send('Not found');
  }

  const auth = _req.headers.authorization;
  if (auth !== `Bearer ${token}`) {
    return res.status(401).send('Unauthorized');
  }

  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
}
