import { Request, Response } from 'express';
import { resolveSettlementMode } from './settle';

/**
 * GET /health - liveness plus the resolved settlement mode (real / simulated / disabled).
 */
export function healthCheck(_req: Request, res: Response) {
  res.json({
    status: 'ok',
    service: 'SBC x402 Facilitator',
    settlement: resolveSettlementMode(),
  });
}
