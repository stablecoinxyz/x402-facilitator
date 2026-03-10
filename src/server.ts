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
  const server = app.listen(port, () => {
    logger.info({
      port,
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
