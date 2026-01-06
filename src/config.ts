import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  port: parseInt(process.env.FACILITATOR_PORT || '3001'),

  // Base Configuration
  baseRpcUrl: process.env.BASE_RPC_URL || 'https://sepolia.base.org',
  baseFacilitatorPrivateKey: process.env.BASE_FACILITATOR_PRIVATE_KEY || '',
  baseFacilitatorAddress: process.env.BASE_FACILITATOR_ADDRESS || '',
  baseChainId: parseInt(process.env.BASE_CHAIN_ID || '84532'), // 8453 = mainnet, 84532 = sepolia
  baseSbcTokenAddress: process.env.BASE_SBC_TOKEN_ADDRESS || '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16', // Base Sepolia
  baseSbcDecimals: parseInt(process.env.BASE_SBC_DECIMALS || '6'), // mainnet: 18, sepolia: 6

  // Solana Configuration
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  solanaFacilitatorPrivateKey: process.env.SOLANA_FACILITATOR_PRIVATE_KEY || process.env.FACILITATOR_SOLANA_PRIVATE_KEY || '',
  solanaFacilitatorAddress: process.env.SOLANA_FACILITATOR_ADDRESS || process.env.FACILITATOR_SOLANA_ADDRESS || '',
  solanaMerchantAddress: process.env.SOLANA_MERCHANT_ADDRESS || '',
  sbcTokenAddress: process.env.SBC_TOKEN_ADDRESS || 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA',
  sbcDecimals: 9,
};

// Validate Solana config (optional - only if Solana is being used)
if (config.solanaFacilitatorPrivateKey && !config.solanaFacilitatorAddress) {
  throw new Error('SOLANA_FACILITATOR_ADDRESS is required for Solana');
}

console.log('✅ Facilitator configuration loaded');
console.log(`   Base Chain ID: ${config.baseChainId}`);
console.log(`   Base Facilitator: ${config.baseFacilitatorAddress || 'Not configured'}`);
console.log(`   Solana RPC: ${config.solanaRpcUrl}`);
console.log(`   Solana Facilitator: ${config.solanaFacilitatorAddress || 'Not configured'}`);
