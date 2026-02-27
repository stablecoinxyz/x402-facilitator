import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Mainnet CAIP-2 network identifiers that require an API key.
 * Testnet networks (Base Sepolia, Radius testnet, Solana devnet) are free.
 */
const MAINNET_NETWORKS = new Set([
  'eip155:8453',                                    // Base mainnet
  'eip155:723',                                     // Radius mainnet
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',       // Solana mainnet
]);

/** In-memory cache: apiKey → { valid, expiresAt } */
const keyCache = new Map<string, { valid: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function isValidApiKey(apiKey: string): Promise<boolean> {
  const cached = keyCache.get(apiKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.valid;
  }

  try {
    const response = await fetch(`${config.dashboardUrl}/api/keys/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      keyCache.set(apiKey, { valid: false, expiresAt: Date.now() + CACHE_TTL_MS });
      return false;
    }

    const data = await response.json() as { valid: boolean };
    keyCache.set(apiKey, { valid: data.valid, expiresAt: Date.now() + CACHE_TTL_MS });
    return data.valid;
  } catch (err) {
    console.error('⚠️  API key validation error (dashboard unreachable):', err instanceof Error ? err.message : err);
    // Fail closed — don't allow mainnet access if we can't validate the key
    return false;
  }
}

/**
 * Express middleware that gates mainnet /verify and /settle requests
 * behind a valid API key (X-API-Key header).
 *
 * - Testnet networks: always allowed through
 * - Mainnet networks with no key: 401
 * - Mainnet networks with invalid key: 403
 * - Disable with ENABLE_API_KEY_GATING=false (for self-hosted setups)
 */
export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!config.enableApiKeyGating) {
    return next();
  }

  const network: string | undefined = req.body?.paymentPayload?.accepted?.network;

  // Not a mainnet network (or unrecognized) — allow through
  if (!network || !MAINNET_NETWORKS.has(network)) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({
      error: 'API key required for mainnet networks. Get yours at dashboard.stablecoin.xyz',
    });
  }

  isValidApiKey(apiKey)
    .then((valid) => {
      if (!valid) {
        return res.status(403).json({ error: 'Invalid or inactive API key.' });
      }
      next();
    })
    .catch((err) => {
      console.error('⚠️  API key middleware error:', err);
      res.status(503).json({ error: 'API key validation temporarily unavailable.' });
    });
}
