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

  // Solana Configuration. SVM Exact is intentionally an explicit opt-in: keys
  // alone never expose a settlement capability.
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  solanaFacilitatorPrivateKey: process.env.SOLANA_FACILITATOR_PRIVATE_KEY || process.env.FACILITATOR_SOLANA_PRIVATE_KEY || '',
  solanaFacilitatorAddress: process.env.SOLANA_FACILITATOR_ADDRESS || process.env.FACILITATOR_SOLANA_ADDRESS || '',
  solanaSvmExactEnabled: process.env.SOLANA_SVM_EXACT_ENABLED === 'true',
  solanaSvmNetwork: process.env.SOLANA_SVM_NETWORK || '',

  // Sui Configuration. Exact is an explicit opt-in, same shape as SVM: keys and
  // a URL alone never expose a settlement capability.
  suiExactEnabled: process.env.SUI_EXACT_ENABLED === 'true',
  suiNetwork: process.env.SUI_NETWORK || '',
  suiGrpcUrl: process.env.SUI_GRPC_URL || '',
  sbcTokenAddress: process.env.SBC_TOKEN_ADDRESS || 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA',
  sbcDecimals: 9,
};

/** CAIP-2 identifier for Solana mainnet (truncated genesis hash). */
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const SOLANA_TESTNET_CAIP2 = 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';

export const SOLANA_SVM_NETWORKS: Record<string, { caip2: string; v1: string; cluster: 'mainnet' | 'devnet' | 'testnet' }> = {
  [SOLANA_MAINNET_CAIP2]: { caip2: SOLANA_MAINNET_CAIP2, v1: 'solana', cluster: 'mainnet' },
  [SOLANA_DEVNET_CAIP2]: { caip2: SOLANA_DEVNET_CAIP2, v1: 'solana-devnet', cluster: 'devnet' },
  [SOLANA_TESTNET_CAIP2]: { caip2: SOLANA_TESTNET_CAIP2, v1: 'solana-testnet', cluster: 'testnet' },
};

export function getSolanaSvmNetwork() {
  return SOLANA_SVM_NETWORKS[toCaip2Network(config.solanaSvmNetwork)];
}

/** True only when an operator deliberately selects a supported SVM network. */
export function isSolanaSvmExactEnabled(): boolean {
  return config.solanaSvmExactEnabled && Boolean(getSolanaSvmNetwork());
}

/** CAIP-2 identifiers for Sui. */
export const SUI_MAINNET_CAIP2 = 'sui:mainnet';
export const SUI_TESTNET_CAIP2 = 'sui:testnet';

/** Circle native USDC coin types, full-length addresses per the x402 registry. */
export const SUI_USDC_MAINNET = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
export const SUI_USDC_TESTNET = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

/**
 * Sui networks this facilitator will serve, keyed by CAIP-2 id.
 *
 * `SUI_NETWORK` is matched verbatim against these keys — CAIP-2 only, no
 * friendly-name aliases (repo rule). A typo therefore fails at boot instead of
 * silently matching nothing, and there is no second naming convention to drift.
 */
export const SUI_NETWORKS: Record<string, { caip2: string; asset: string; decimals: number }> = {
  [SUI_MAINNET_CAIP2]: { caip2: SUI_MAINNET_CAIP2, asset: SUI_USDC_MAINNET, decimals: 6 },
  [SUI_TESTNET_CAIP2]: { caip2: SUI_TESTNET_CAIP2, asset: SUI_USDC_TESTNET, decimals: 6 },
};

/** The configured Sui network, or null when the env value is not one of ours. */
export function getSuiNetwork() {
  return Object.prototype.hasOwnProperty.call(SUI_NETWORKS, config.suiNetwork)
    ? SUI_NETWORKS[config.suiNetwork]
    : null;
}

/** True only when an operator deliberately selects a supported Sui network. */
export function isSuiExactEnabled(): boolean {
  return config.suiExactEnabled && Boolean(getSuiNetwork());
}

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
  'solana': SOLANA_MAINNET_CAIP2,
  'solana-devnet': SOLANA_DEVNET_CAIP2,
  'solana-testnet': SOLANA_TESTNET_CAIP2,
};

/** Additional inbound spellings we accept but never advertise. */
const V1_NETWORK_ALIASES: Record<string, string> = {
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
if (config.solanaSvmExactEnabled && !getSolanaSvmNetwork()) {
  throw new Error('SOLANA_SVM_NETWORK must explicitly be solana, solana-devnet, or solana-testnet when SOLANA_SVM_EXACT_ENABLED=true');
}

// Validate Sui config (optional — only if Sui is being used). Both failures are
// startup errors: an enabled Sui network without a gRPC endpoint cannot verify
// or settle anything, and silently serving nothing is worse than refusing to boot.
if (config.suiExactEnabled && !getSuiNetwork()) {
  throw new Error('SUI_NETWORK must be exactly sui:mainnet or sui:testnet when SUI_EXACT_ENABLED=true');
}
if (config.suiExactEnabled && !config.suiGrpcUrl) {
  throw new Error('SUI_GRPC_URL is required when SUI_EXACT_ENABLED=true');
}

// Startup log is emitted by server.ts with structured logger
