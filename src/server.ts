import express from 'express';
import cors from 'cors';
import { config } from './config';
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
app.post('/verify', verifyPayment);
app.post('/settle', settlePayment);

// Start server
app.listen(config.port, () => {
  console.log('\n🚀 SBC x402 Facilitator');
  console.log('========================');
  console.log(`✅ Server running on port ${config.port}`);
  console.log(`✅ Chain: Base (${config.baseChainId})`);
  console.log(`✅ Chain: Solana (mainnet-beta)`);
  console.log('\n📡 Endpoints:');
  console.log(`   GET  http://localhost:${config.port}/supported (x402 Capability Discovery)`);
  console.log(`   POST http://localhost:${config.port}/verify (Payment Verification)`);
  console.log(`   POST http://localhost:${config.port}/settle (Payment Settlement)`);
  console.log('\n⏳ Waiting for payment requests...\n');
});
