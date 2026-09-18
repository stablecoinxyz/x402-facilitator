import { verifyTypedData } from 'viem';

/** Canonical Uniswap Permit2 deployment on supported EVM networks. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
/** x402 Foundation proxy which enforces the signed Witness recipient. */
export const X402_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as const;

export const permit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;

export const erc2612Types = {
  Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type Permit2Authorization = {
  permitted: { token: string; amount: string };
  from: string; spender: string; nonce: string; deadline: string;
  witness: { to: string; validAfter: string };
};

export type Eip2612Sponsoring = {
  from: string; asset: string; spender: string; amount: string; nonce: string;
  deadline: string; signature: string; version: string;
};

const address = /^0x[0-9a-fA-F]{40}$/;
const uint = /^\d+$/;
const sig = /^0x[0-9a-fA-F]{130}$/;
export function isAddress(value: unknown): value is string { return typeof value === 'string' && address.test(value); }
export function isUint(value: unknown): value is string { return typeof value === 'string' && uint.test(value); }
export function isSignature(value: unknown): value is string { return typeof value === 'string' && sig.test(value); }
export function sameAddress(a: unknown, b: string): boolean { return isAddress(a) && a.toLowerCase() === b.toLowerCase(); }

/** Strictly decode and bind an official Exact EVM Permit2 payload to requirements. */
export function parsePermit2(payload: any, requirements: any, extensions: any = {}): { ok: true; auth: Permit2Authorization; signature: string; sponsor?: Eip2612Sponsoring } | { ok: false; reason: string; payer: string } {
  const auth = payload?.permit2Authorization;
  const payer = typeof auth?.from === 'string' ? auth.from : 'unknown';
  if (requirements?.extra?.assetTransferMethod !== 'permit2') return { ok: false, reason: 'unsupported_asset_transfer_method', payer };
  if ((requirements.extra.name !== undefined && typeof requirements.extra.name !== 'string') || (requirements.extra.version !== undefined && typeof requirements.extra.version !== 'string')) return { ok: false, reason: 'invalid_payload', payer };
  if (!auth) return { ok: false, reason: 'invalid_payload', payer };
  if (!isSignature(payload?.signature)) return { ok: false, reason: 'invalid_exact_evm_payload_signature', payer };
  if (!isAddress(auth.from) || !isAddress(auth.permitted?.token) || !isAddress(auth.spender) || !isAddress(auth.witness?.to) || !isUint(auth.permitted?.amount) || !isUint(auth.nonce) || !isUint(auth.deadline) || !isUint(auth.witness?.validAfter)) return { ok: false, reason: 'invalid_payload', payer };
  if (!sameAddress(auth.spender, X402_PERMIT2_PROXY)) return { ok: false, reason: 'invalid_exact_evm_payload_recipient_mismatch', payer };
  if (!sameAddress(auth.permitted.token, requirements.asset) || !sameAddress(auth.witness.to, requirements.payTo)) return { ok: false, reason: 'invalid_exact_evm_payload_recipient_mismatch', payer };
  if (BigInt(auth.permitted.amount) !== BigInt(requirements.amount)) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_value_mismatch', payer };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < BigInt(auth.witness.validAfter)) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_after', payer };
  if (now > BigInt(auth.deadline)) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_before', payer };
  const sponsor = extensions?.eip2612GasSponsoring?.info;
  if (sponsor !== undefined) {
    if (!isAddress(sponsor?.from) || !isAddress(sponsor?.asset) || !isAddress(sponsor?.spender) || !isUint(sponsor?.amount) || !isUint(sponsor?.nonce) || !isUint(sponsor?.deadline) || !isSignature(sponsor?.signature) || sponsor?.version !== '1' || !sameAddress(sponsor.from, auth.from) || !sameAddress(sponsor.asset, auth.permitted.token) || !sameAddress(sponsor.spender, PERMIT2_ADDRESS) || BigInt(sponsor.amount) !== BigInt(auth.permitted.amount) || BigInt(sponsor.deadline) < BigInt(auth.deadline)) return { ok: false, reason: 'invalid_payload', payer };
  }
  return { ok: true, auth, signature: payload.signature, ...(sponsor ? { sponsor } : {}) };
}

export async function verifyPermit2Signature(auth: Permit2Authorization, signature: string, chainId: number): Promise<boolean> {
  return verifyTypedData({ address: auth.from as `0x${string}`, domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS }, types: permit2WitnessTypes, primaryType: 'PermitWitnessTransferFrom', message: auth as any, signature: signature as `0x${string}` });
}

export async function verifySponsorSignature(s: Eip2612Sponsoring, name: string, version: string, chainId: number): Promise<boolean> {
  return verifyTypedData({ address: s.from as `0x${string}`, domain: { name, version, chainId, verifyingContract: s.asset as `0x${string}` }, types: erc2612Types, primaryType: 'Permit', message: { owner: s.from as `0x${string}`, spender: s.spender as `0x${string}`, value: BigInt(s.amount), nonce: BigInt(s.nonce), deadline: BigInt(s.deadline) }, signature: s.signature as `0x${string}` });
}

export const proxyAbi = [{ type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [
  { name: 'permit', type: 'tuple', components: [{ name: 'permitted', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  { name: 'owner', type: 'address' }, { name: 'witness', type: 'tuple', components: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }] }, { name: 'signature', type: 'bytes' },
], outputs: [] }, { type: 'function', name: 'settleWithPermit', stateMutability: 'nonpayable', inputs: [
  { name: 'permit2612', type: 'tuple', components: [{ name: 'value', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }, { name: 'v', type: 'uint8' }] },
  { name: 'permit', type: 'tuple', components: [{ name: 'permitted', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  { name: 'owner', type: 'address' }, { name: 'witness', type: 'tuple', components: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }] }, { name: 'signature', type: 'bytes' },
], outputs: [] }] as const;
