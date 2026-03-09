import express from 'express';
import cors from 'cors';
import { config } from './config';
import { apiKeyMiddleware } from './middleware/apiKey';
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

// Rate limiting: 60 requests per minute per IP on payment endpoints
const paymentRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

// Payload too large error handler
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  next(err);
});

// Home page
app.get('/', homePage);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'SBC x402 Facilitator' });
});

// x402 Facilitator endpoints
app.get('/supported', getSupportedNetworks);
app.post('/verify', paymentRateLimiter, apiKeyMiddleware, verifyPayment);
app.post('/settle', paymentRateLimiter, apiKeyMiddleware, settlePayment);

// Start server — try config.port, then increment until an available port is found
function startServer(port: number) {
  const server = app.listen(port, () => {
    console.log('\n🚀 SBC x402 Facilitator');
    console.log('========================');
    console.log(`✅ Server running on port ${port}`);
    console.log(`✅ Base Mainnet: ${config.baseFacilitatorAddress ? 'configured' : 'not configured'}`);
    console.log(`✅ Base Sepolia: ${config.baseSepoliaFacilitatorAddress ? 'configured' : 'not configured'}`);
    console.log(`✅ Radius Mainnet: ${config.radiusFacilitatorAddress ? 'configured' : 'not configured'}`);
    console.log(`✅ Radius Testnet: ${config.radiusTestnetFacilitatorAddress ? 'configured' : 'not configured'}`);
    console.log(`✅ Solana: ${config.solanaFacilitatorAddress ? 'configured' : 'not configured'}`);
    console.log('\n📡 Endpoints:');
    console.log(`   GET  http://localhost:${port}/supported (x402 Capability Discovery)`);
    console.log(`   POST http://localhost:${port}/verify (Payment Verification)`);
    console.log(`   POST http://localhost:${port}/settle (Payment Settlement)`);
    console.log('\n⏳ Waiting for payment requests...\n');
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}

startServer(config.port);
