/**
 * Rate Limiting
 *
 * Protects /verify and /settle from abuse.
 * Uses a simple in-memory sliding window per IP.
 */

import { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;  // Time window in milliseconds
  max: number;       // Max requests per window per IP
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max } = options;
  const hits = new Map<string, number[]>();

  // Cleanup stale entries periodically
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of hits) {
      const valid = timestamps.filter(t => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(ip);
      } else {
        hits.set(ip, valid);
      }
    }
  }, windowMs);

  // Don't keep process alive just for cleanup
  if (cleanup.unref) cleanup.unref();

  const handler = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    const timestamps = (hits.get(ip) || []).filter(t => now - t < windowMs);
    timestamps.push(now);
    hits.set(ip, timestamps);

    // Set standard rate limit headers
    const remaining = Math.max(0, max - timestamps.length);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);

    if (timestamps.length > max) {
      const retryAfter = Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Too many requests — rate limit exceeded',
        retryAfter,
      });
    }

    next();
  };

  // Expose cleanup for tests to prevent Jest worker leak
  return Object.assign(handler, {
    destroy: () => clearInterval(cleanup),
  });
}
