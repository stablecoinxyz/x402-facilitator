/**
 * Input Size Limiting
 *
 * Configures express.json() with an explicit body size limit.
 * Default: 100kb (more than enough for x402 payloads, which are typically ~1-2kb).
 */

import express from 'express';
import logger from '../lib/logger';

export function createSizeLimiter(limit: string = '100kb') {
  return express.json({ limit });
}

/**
 * Answers every error raised while reading or parsing a request body as JSON,
 * and never with a stack trace. Without it, Express's default handler answers
 * a malformed body with an HTML page that includes the stack and the
 * container's file paths (it does so whenever NODE_ENV is not "production").
 *
 * body-parser tags its errors with a `type` and a 4xx `status`
 * (entity.too.large, entity.parse.failed, encoding.unsupported,
 * charset.unsupported, request.aborted, ...). Those are the caller's fault and
 * keep their status; anything else is ours and answers 500 with a fixed code.
 */
export function bodyErrorHandler(err: any, req: express.Request, res: express.Response, next: express.NextFunction) {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  const status = Number(err?.status ?? err?.statusCode);
  if (typeof err?.type === 'string' && status >= 400 && status < 500) {
    return res.status(status).json({ error: 'invalid_request_body', type: err.type });
  }
  logger.error({ err, path: req.path }, 'unhandled request error');
  return res.status(500).json({ error: 'internal_error' });
}
