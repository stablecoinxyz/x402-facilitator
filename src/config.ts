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
  baseUsdcTokenAddress: process.env.BASE_USDC_TOKEN_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  baseUsdcDecimals: parseInt(process.env.BASE_USDC_DECIMALS || '6'),

  // Base Sepolia Configuration
  baseSepoliaRpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
  baseSepoliaFacilitatorPrivateKey: process.env.BASE_SEPOLIA_FACILITATOR_PRIVATE_KEY || '',
  baseSepoliaFacilitatorAddress: process.env.BASE_SEPOLIA_FACILITATOR_ADDRESS || '',
  baseSepoliaChainId: 84532,
  baseSepoliaSbcTokenAddress: process.env.BASE_SEPOLIA_SBC_TOKEN_ADDRESS || '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16',
  baseSepoliaSbcDecimals: parseInt(process.env.BASE_SEPOLIA_SBC_DECIMALS || '6'),
  baseSepoliaUsdcTokenAddress: process.env.BASE_SEPOLIA_USDC_TOKEN_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  baseSepoliaUsdcDecimals: parseInt(process.env.BASE_SEPOLIA_USDC_DECIMALS || '6'),

  // Radius Mainnet Configuration
  radiusRpcUrl: process.env.RADIUS_RPC_URL || 'https://rpc.radiustech.xyz',
  radiusFacilitatorPrivateKey: process.env.RADIUS_FACILITATOR_PRIVATE_KEY || '',
  radiusFacilitatorAddress: process.env.RADIUS_FACILITATOR_ADDRESS || '',
  radiusChainId: parseInt(process.env.RADIUS_CHAIN_ID || '723487'),
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
  sbcTokenAddress: process.env.SBC_TOKEN_ADDRESS || 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA',
  sbcDecimals: 9,
};

/** CAIP-2 identifier for Solana mainnet (truncated genesis hash). */
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * x402 v1 identifies networks by plain name ("base"); v2 uses CAIP-2 ("eip155:8453").
 * See specs/x402-specification-v1.md §11.1 and specs/x402-specification-v2.md.
 *
 * Canonical v1 name → CAIP-2. Chain IDs are read from config so the two stay in
 * sync when BASE_CHAIN_ID / RADIUS_CHAIN_ID are overridden.
 *
 * `base` and `base-sepolia` are spec-defined. Radius and Solana have no v1 spec
 * name — these match the names the SBC reference facilitator emits.
 */
const V1_NETWORK_TO_CAIP2: Record<string, string> = {
  'base': `eip155:${config.baseChainId}`,
  'base-sepolia': `eip155:${config.baseSepoliaChainId}`,
  'radius': `eip155:${config.radiusChainId}`,
  'radius-testnet': `eip155:${config.radiusTestnetChainId}`,
  'solana-mainnet-beta': SOLANA_MAINNET_CAIP2,
};

/** Additional inbound spellings we accept but never advertise. */
const V1_NETWORK_ALIASES: Record<string, string> = {
  'solana': SOLANA_MAINNET_CAIP2,
  'solana-mainnet': SOLANA_MAINNET_CAIP2,
};

/**
 * Normalize any incoming network identifier to CAIP-2.
 *
 * Already-CAIP-2 values pass through untouched. Unrecognized values are returned
 * as-is so the caller's error response and metrics show what the client actually
 * sent rather than a masked 'unknown'.
 */
export function toCaip2Network(network: unknown): string {
  if (typeof network !== 'string' || network === '') return 'unknown';
  if (network.includes(':')) return network;
  const key = network.toLowerCase();
  return V1_NETWORK_TO_CAIP2[key] || V1_NETWORK_ALIASES[key] || network;
}

/**
 * Reverse lookup: CAIP-2 → canonical v1 name, or null if this network has no v1
 * name. Used by /supported so v1 clients discover a network identifier they can
 * actually send back to us.
 */
export function toV1Network(caip2: string): string | null {
  const entry = Object.entries(V1_NETWORK_TO_CAIP2).find(([, v]) => v === caip2);
  return entry ? entry[0] : null;
}

/**
 * Resolve an asset address to token config for a given EVM chain.
 * Returns null if the asset is not whitelisted for that chain.
 */
export function resolveToken(chainId: number, asset: string): { address: string; decimals: number; name: string; version: string } | null {
  const a = asset.toLowerCase();

  if (chainId === config.baseChainId) {
    if (a === config.baseSbcTokenAddress.toLowerCase()) return { address: config.baseSbcTokenAddress, decimals: config.baseSbcDecimals, name: 'Stable Coin', version: '1' };
    if (a === config.baseUsdcTokenAddress.toLowerCase()) return { address: config.baseUsdcTokenAddress, decimals: config.baseUsdcDecimals, name: 'USD Coin', version: '2' };
  }
  if (chainId === config.baseSepoliaChainId) {
    if (a === config.baseSepoliaSbcTokenAddress.toLowerCase()) return { address: config.baseSepoliaSbcTokenAddress, decimals: config.baseSepoliaSbcDecimals, name: 'Stable Coin', version: '1' };
    if (a === config.baseSepoliaUsdcTokenAddress.toLowerCase()) return { address: config.baseSepoliaUsdcTokenAddress, decimals: config.baseSepoliaUsdcDecimals, name: 'USDC', version: '2' };
  }
  if (chainId === config.radiusChainId || chainId === 723487) {
    if (a === config.radiusSbcTokenAddress.toLowerCase()) return { address: config.radiusSbcTokenAddress, decimals: config.radiusSbcDecimals, name: 'Stable Coin', version: '1' };
  }
  if (chainId === config.radiusTestnetChainId) {
    if (a === config.radiusTestnetSbcTokenAddress.toLowerCase()) return { address: config.radiusTestnetSbcTokenAddress, decimals: config.radiusTestnetSbcDecimals, name: 'Stable Coin', version: '1' };
  }

  return null;
}

// Validate Solana config (optional - only if Solana is being used)
if (config.solanaFacilitatorPrivateKey && !config.solanaFacilitatorAddress) {
  throw new Error('SOLANA_FACILITATOR_ADDRESS is required for Solana');
}

// Startup log is emitted by server.ts with structured logger
