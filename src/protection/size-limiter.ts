/**
 * Input Size Limiting
 *
 * Configures express.json() with an explicit body size limit.
 * Default: 100kb (more than enough for x402 payloads, which are typically ~1-2kb).
 */

import express from 'express';

export function createSizeLimiter(limit: string = '100kb') {
  return express.json({ limit });
}
