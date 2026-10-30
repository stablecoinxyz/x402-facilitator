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
  // a URL alone never expose a settlement capability. `SUI_NETWORKS` is a
  // comma-separated CAIP-2 list, so mainnet and testnet can be served at once;
  // each network needs its own gRPC endpoint, since a mainnet node cannot answer
  // for testnet.
  suiExactEnabled: process.env.SUI_EXACT_ENABLED === 'true',
  suiNetworks: (process.env.SUI_NETWORKS || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
  suiGrpcUrls: {
    'sui:mainnet': process.env.SUI_GRPC_URL_MAINNET || '',
    'sui:testnet': process.env.SUI_GRPC_URL_TESTNET || '',
  } as Record<string, string>,
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
 * `SUI_NETWORKS` entries are matched verbatim against these keys — CAIP-2 only,
 * no friendly-name aliases (repo rule). A typo therefore fails at boot instead
 * of silently matching nothing, and there is no second naming convention to
 * drift.
 */
export const SUI_NETWORKS: Record<string, { caip2: string; asset: string; decimals: number }> = {
  [SUI_MAINNET_CAIP2]: { caip2: SUI_MAINNET_CAIP2, asset: SUI_USDC_MAINNET, decimals: 6 },
  [SUI_TESTNET_CAIP2]: { caip2: SUI_TESTNET_CAIP2, asset: SUI_USDC_TESTNET, decimals: 6 },
};

/**
 * The Sui networks this process serves, deduplicated, in the order `SUI_NETWORKS`
 * names them (so `/supported` order follows the operator's list).
 *
 * Unknown ids are dropped here and rejected at boot (§ the startup checks at the
 * end of this file), so a request can never reach a network we did not name.
 */
export function getSuiNetworks(): Array<{ caip2: string; asset: string; decimals: number }> {
  const seen = new Set<string>();
  const networks = [];
  for (const id of config.suiNetworks) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (Object.prototype.hasOwnProperty.call(SUI_NETWORKS, id)) networks.push(SUI_NETWORKS[id]);
  }
  return networks;
}

/** One configured Sui network by CAIP-2 id, or null when it is not served. */
export function getSuiNetwork(caip2: string) {
  return Object.prototype.hasOwnProperty.call(SUI_NETWORKS, caip2) &&
    config.suiNetworks.includes(caip2)
    ? SUI_NETWORKS[caip2]
    : null;
}

/** True when this process serves the given Sui network. */
export function isSuiNetworkServed(caip2: string | undefined): boolean {
  return typeof caip2 === 'string' && getSuiNetwork(caip2) !== null;
}

/** The gRPC endpoint for a Sui network, or '' when the operator set none. */
export function getSuiGrpcUrl(caip2: string): string {
  // Own-property semantics so a key like `__proto__` cannot answer with an
  // inherited object where a URL is promised.
  const url = Object.prototype.hasOwnProperty.call(config.suiGrpcUrls, caip2)
    ? config.suiGrpcUrls[caip2]
    : '';
  return typeof url === 'string' ? url : '';
}

/**
 * The env var that carries a Sui network's gRPC endpoint.
 *
 * `sui:mainnet` → `SUI_GRPC_URL_MAINNET`. One var per network because a node for
 * one chain cannot answer for another, so a shared URL would be wrong for half
 * the served networks.
 */
export function suiGrpcEnvName(caip2: string): string {
  return `SUI_GRPC_URL_${caip2.replace(/^sui:/, '').toUpperCase()}`;
}

/** True only when an operator deliberately selects at least one supported Sui network. */
export function isSuiExactEnabled(): boolean {
  return config.suiExactEnabled && getSuiNetworks().length > 0;
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
  // Own-property semantics: `__proto__` / `constructor` are not aliases, and a
  // plain index would hand back an object where a string is promised — the
  // caller then throws on `.startsWith` and answers 500 to a malformed request.
  const hit = Object.prototype.hasOwnProperty.call(V1_NETWORK_TO_CAIP2, key)
    ? V1_NETWORK_TO_CAIP2[key]
    : Object.prototype.hasOwnProperty.call(V1_NETWORK_ALIASES, key)
      ? V1_NETWORK_ALIASES[key]
      : undefined;
  return typeof hit === 'string' ? hit : network;
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

// Validate Sui config (optional — only if Sui is being used). Every failure is a
// startup error: an enabled Sui network without a gRPC endpoint cannot verify or
// settle anything, and silently serving nothing is worse than refusing to boot.
// Ids are checked first so a typo is named rather than reported as an empty list.
for (const id of config.suiNetworks) {
  if (!Object.prototype.hasOwnProperty.call(SUI_NETWORKS, id)) {
    throw new Error(`SUI_NETWORKS contains "${id}", which is not sui:mainnet or sui:testnet`);
  }
}
if (config.suiExactEnabled && getSuiNetworks().length === 0) {
  throw new Error('SUI_NETWORKS must name at least one of sui:mainnet, sui:testnet when SUI_EXACT_ENABLED=true');
}
for (const id of config.suiNetworks) {
  if (!getSuiGrpcUrl(id)) {
    throw new Error(`${SUI_NETWORKS[id].caip2} is enabled but its gRPC endpoint is unset (set ${suiGrpcEnvName(id)})`);
  }
}

// Startup log is emitted by server.ts with structured logger
