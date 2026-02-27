import express from 'express';
import cors from 'cors';
import { config } from './config';
import { apiKeyMiddleware } from './middleware/apiKey';
import { verifyPayment } from './routes/verify';
import { settlePayment } from './routes/settle';
import { getSupportedNetworks } from './routes/supported';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'SBC x402 Facilitator' });
});

// x402 Facilitator endpoints
app.get('/supported', getSupportedNetworks);
app.post('/verify', apiKeyMiddleware, verifyPayment);
app.post('/settle', apiKeyMiddleware, settlePayment);

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
