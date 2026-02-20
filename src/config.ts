import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  port: parseInt(process.env.FACILITATOR_PORT || '3001'),

  // Base Mainnet Configuration
  baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  baseFacilitatorPrivateKey: process.env.BASE_FACILITATOR_PRIVATE_KEY || '',
  baseFacilitatorAddress: process.env.BASE_FACILITATOR_ADDRESS || '',
  baseChainId: parseInt(process.env.BASE_CHAIN_ID || '8453'),
  baseSbcTokenAddress: process.env.BASE_SBC_TOKEN_ADDRESS || '0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798',
  baseSbcDecimals: parseInt(process.env.BASE_SBC_DECIMALS || '18'),

  // Base Sepolia Configuration
  baseSepoliaRpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
  baseSepoliaFacilitatorPrivateKey: process.env.BASE_SEPOLIA_FACILITATOR_PRIVATE_KEY || '',
  baseSepoliaFacilitatorAddress: process.env.BASE_SEPOLIA_FACILITATOR_ADDRESS || '',
  baseSepoliaChainId: 84532,
  baseSepoliaSbcTokenAddress: process.env.BASE_SEPOLIA_SBC_TOKEN_ADDRESS || '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16',
  baseSepoliaSbcDecimals: parseInt(process.env.BASE_SEPOLIA_SBC_DECIMALS || '6'),

  // Radius Mainnet Configuration
  radiusRpcUrl: process.env.RADIUS_RPC_URL || 'https://rpc.radiustech.xyz',
  radiusFacilitatorPrivateKey: process.env.RADIUS_FACILITATOR_PRIVATE_KEY || '',
  radiusFacilitatorAddress: process.env.RADIUS_FACILITATOR_ADDRESS || '',
  radiusChainId: parseInt(process.env.RADIUS_CHAIN_ID || '723'),
  radiusSbcTokenAddress: process.env.RADIUS_SBC_TOKEN_ADDRESS || '0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb',
  radiusSbcDecimals: parseInt(process.env.RADIUS_SBC_DECIMALS || '6'),

  // Radius Testnet Configuration
  radiusTestnetRpcUrl: process.env.RADIUS_TESTNET_RPC_URL || 'https://rpc.testnet.radiustech.xyz',
  radiusTestnetFacilitatorPrivateKey: process.env.RADIUS_TESTNET_FACILITATOR_PRIVATE_KEY || '',
  radiusTestnetFacilitatorAddress: process.env.RADIUS_TESTNET_FACILITATOR_ADDRESS || '',
  radiusTestnetChainId: 72344,
  radiusTestnetSbcTokenAddress: process.env.RADIUS_TESTNET_SBC_TOKEN_ADDRESS || '0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb',
  radiusTestnetSbcDecimals: parseInt(process.env.RADIUS_TESTNET_SBC_DECIMALS || '6'),

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
console.log(`   Base Mainnet: ${config.baseFacilitatorAddress || 'Not configured'}`);
console.log(`   Base Sepolia: ${config.baseSepoliaFacilitatorAddress || 'Not configured'}`);
console.log(`   Radius Mainnet: ${config.radiusFacilitatorAddress || 'Not configured'}`);
console.log(`   Radius Testnet: ${config.radiusTestnetFacilitatorAddress || 'Not configured'}`);
console.log(`   Solana: ${config.solanaFacilitatorAddress || 'Not configured'}`);
