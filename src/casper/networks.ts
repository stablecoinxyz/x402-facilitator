/**
 * Casper Network Definitions
 *
 * Casper is a non-EVM chain, so — like Solana — it gets its own module rather
 * than reusing the eip155 permit path.
 *
 * Settlement asset is wCSPR, a CEP-18 token with 9 decimals. The base unit is
 * the "mote": 1 CSPR = 1_000_000_000 motes. All amount math in this module is
 * integer/BigInt only; sub-mote precision is rejected rather than truncated.
 */

/** CAIP-2 identifier for Casper mainnet. */
export const CASPER_MAINNET_CAIP2 = 'casper:casper';

/** CAIP-2 identifier for Casper testnet. */
export const CASPER_TESTNET_CAIP2 = 'casper:casper-test';

/** wCSPR is a CEP-18 token with 9 decimals; its base unit is the mote. */
export const CASPER_DECIMALS = 9;

/** 10 ** CASPER_DECIMALS, precomputed as a BigInt. */
const MOTES_PER_CSPR = 10n ** BigInt(CASPER_DECIMALS);

export interface CasperNetworkConfig {
  label: string;
  caip2: string;
  /** Casper network name as used by the node / RPC layer. */
  chainName: string;
  testnet: boolean;
}

const NETWORKS: Record<string, CasperNetworkConfig> = {
  [CASPER_MAINNET_CAIP2]: {
    label: 'Casper Mainnet',
    caip2: CASPER_MAINNET_CAIP2,
    chainName: 'casper',
    testnet: false,
  },
  [CASPER_TESTNET_CAIP2]: {
    label: 'Casper Testnet',
    caip2: CASPER_TESTNET_CAIP2,
    chainName: 'casper-test',
    testnet: true,
  },
};

/** True when a CAIP-2 identifier belongs to the Casper namespace. */
export function isCasperNetwork(network: unknown): boolean {
  return typeof network === 'string' && network.startsWith('casper:');
}

/**
 * Resolve a CAIP-2 identifier to its Casper network config.
 * Returns null for unknown Casper networks so the caller can emit
 * `invalid_network` rather than guessing a chain.
 */
export function resolveCasperNetwork(network: string): CasperNetworkConfig | null {
  return NETWORKS[network] || null;
}

/**
 * Casper addresses appear in two interchangeable forms:
 *
 * - account hash: `account-hash-<64 hex>`
 * - public key:   `01<64 hex>` (ed25519) or `02<66 hex>` (secp256k1)
 *
 * Contract-level recipients may also be given as `hash-<64 hex>`.
 */
const ACCOUNT_HASH_RE = /^account-hash-[0-9a-fA-F]{64}$/;
const CONTRACT_HASH_RE = /^hash-[0-9a-fA-F]{64}$/;
const ED25519_PUBLIC_KEY_RE = /^01[0-9a-fA-F]{64}$/;
const SECP256K1_PUBLIC_KEY_RE = /^02[0-9a-fA-F]{66}$/;

/** True for a `account-hash-...` string. */
export function isCasperAccountHash(address: unknown): boolean {
  return typeof address === 'string' && ACCOUNT_HASH_RE.test(address);
}

/** True for a hex-encoded ed25519 or secp256k1 Casper public key. */
export function isCasperPublicKey(address: unknown): boolean {
  return (
    typeof address === 'string' &&
    (ED25519_PUBLIC_KEY_RE.test(address) || SECP256K1_PUBLIC_KEY_RE.test(address))
  );
}

/** True for any address form this facilitator accepts on Casper. */
export function isValidCasperAddress(address: unknown): boolean {
  return (
    isCasperAccountHash(address) ||
    isCasperPublicKey(address) ||
    (typeof address === 'string' && CONTRACT_HASH_RE.test(address))
  );
}

/**
 * Compare two Casper addresses. Casper hex is case-insensitive, but an account
 * hash and a public key are different encodings of different values, so we only
 * normalize case — never across forms.
 */
export function isSameCasperAddress(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Parse an amount already denominated in motes (the x402 wire format for
 * `amount` / `maxAmountRequired`) into a BigInt.
 *
 * Throws on anything that is not a non-negative integer string, including
 * values carrying a fractional part — silently truncating a payment amount is
 * never acceptable.
 */
export function parseMotes(amount: unknown): bigint {
  if (typeof amount === 'bigint') return assertNonNegative(amount);
  if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) {
      throw new Error(`Amount ${amount} is not a whole number of motes`);
    }
    if (!Number.isSafeInteger(amount)) {
      throw new Error(`Amount ${amount} exceeds safe integer range; pass motes as a string`);
    }
    return assertNonNegative(BigInt(amount));
  }
  if (typeof amount !== 'string' || amount.trim() === '') {
    throw new Error('Amount is missing or not a string of motes');
  }
  const trimmed = amount.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Amount "${amount}" is not a whole number of motes`);
  }
  return BigInt(trimmed);
}

/**
 * Convert a decimal CSPR amount (e.g. "1.25") to motes.
 *
 * Uses string math rather than floats so no precision is lost. If the value has
 * more than CASPER_DECIMALS fractional digits it is *not* representable in
 * motes and we throw instead of rounding.
 */
export function csprToMotes(amount: string | number): bigint {
  const raw = typeof amount === 'number' ? formatNumber(amount) : String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid CSPR amount "${amount}"`);
  }
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > CASPER_DECIMALS) {
    throw new Error(
      `CSPR amount "${amount}" has sub-mote precision (max ${CASPER_DECIMALS} decimals)`,
    );
  }
  const padded = fraction.padEnd(CASPER_DECIMALS, '0');
  return BigInt(whole) * MOTES_PER_CSPR + BigInt(padded || '0');
}

/** Convert motes back to a decimal CSPR string, without float rounding. */
export function motesToCspr(motes: bigint | string): string {
  const value = typeof motes === 'bigint' ? motes : parseMotes(motes);
  const whole = value / MOTES_PER_CSPR;
  const fraction = (value % MOTES_PER_CSPR).toString().padStart(CASPER_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function assertNonNegative(value: bigint): bigint {
  if (value < 0n) throw new Error('Amount must not be negative');
  return value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid CSPR amount "${value}"`);
  // Avoid exponential notation for small/large magnitudes.
  return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}
