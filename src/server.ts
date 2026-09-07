import express from 'express';
import cors from 'cors';
import logger from './lib/logger';
import { metricsHandler } from './lib/metrics';
import { requestIdMiddleware } from './middleware/requestId';
import { config } from './config';
import { createRateLimiter } from './protection/rate-limiter';
import { createSizeLimiter } from './protection/size-limiter';
import { verifyPayment } from './routes/verify';
import { settlePayment } from './routes/settle';
import { getSupportedNetworks } from './routes/supported';
import { homePage } from './routes/home';

const app = express();

// Middleware
app.use(cors());
app.use(createSizeLimiter('100kb'));
app.use(requestIdMiddleware);

// Rate limiting: 60 requests per minute per IP on payment endpoints
const paymentRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

// Payload too large error handler
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  next(err);
});

// Metrics endpoint (internal)
app.get('/metrics', metricsHandler);

// Home page
app.get('/', homePage);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'SBC x402 Facilitator' });
});

// x402 Facilitator endpoints
app.get('/supported', getSupportedNetworks);
app.post('/verify', paymentRateLimiter, verifyPayment);
app.post('/settle', paymentRateLimiter, settlePayment);

// Start server — try config.port, then increment until an available port is found
function startServer(port: number) {

/** Host of an RPC URL, never its path or query: those carry the API key. */
function rpcHost(url: string | undefined): string {
  if (!url) return '(unset)';
  try { return new URL(url).host; } catch { return '(unparseable)'; }
}

  const server = app.listen(port, () => {
    logger.info({
      port,
      // Announce the RPC endpoints this process actually loaded. An operator
      // cannot verify what the running service will not tell them, and a stale
      // process holding an old value looks identical to a fresh one otherwise.
      // Host only — the path and query carry the API key on most providers.
      rpc: {
        solana: rpcHost(config.solanaRpcUrl),
        base: rpcHost(config.baseRpcUrl),
      },
      settlement: process.env.ENABLE_REAL_SETTLEMENT === 'true'
        ? 'real'
        : (process.env.ALLOW_SIMULATED_SETTLEMENT === 'true' ? 'simulated' : 'disabled'),
      networks: {
        baseMainnet: config.baseFacilitatorAddress || null,
        baseSepolia: config.baseSepoliaFacilitatorAddress || null,
        radiusMainnet: config.radiusFacilitatorAddress || null,
        radiusTestnet: config.radiusTestnetFacilitatorAddress || null,
        solana: config.solanaFacilitatorAddress || null,
      },
    }, 'Facilitator started');
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port, nextPort: port + 1 }, 'Port in use, trying next');
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}

startServer(config.port);
