import { verifyTypedData, parseSignature } from 'viem';
import { isAddress, isUint, isSignature, sameAddress } from './permit2';

/**
 * x402 Exact EVM, `assetTransferMethod: "eip3009"`.
 *
 * The payer signs `TransferWithAuthorization` against the token's own EIP-712
 * domain; the token enforces `to`, `value`, the validity window and a one-time
 * `nonce`. No proxy is involved, so the recipient binding is the signature itself.
 * The facilitator only broadcasts.
 */

export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type Eip3009Authorization = {
  from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string;
};

/** Spec code (upstream `@x402/evm` `ErrEip3009NonceAlreadyUsed`). */
export const EIP3009_NONCE_ALREADY_USED = 'invalid_exact_evm_nonce_already_used';

const bytes32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * True when the requirements select EIP-3009. The spec makes it the default:
 * an absent `assetTransferMethod` means `eip3009`.
 */
export function selectsEip3009(requirements: any): boolean {
  const method = requirements?.extra?.assetTransferMethod;
  return method === undefined || method === 'eip3009';
}

/** secp256k1 n / 2. Signatures with s above this are malleable and rejected by the tokens. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Strictly decode an EIP-3009 payload and bind it to the requirements.
 * `minRemainingSeconds` is how long the authorization must still be valid:
 * a settle needs headroom for the transaction to be mined before `validBefore`.
 */
export function parseEip3009(
  payload: any,
  requirements: any,
  nowSeconds: bigint,
  minRemainingSeconds: bigint,
): { ok: true; auth: Eip3009Authorization; signature: string } | { ok: false; reason: string; payer: string } {
  const auth = payload?.authorization;
  const payer = typeof auth?.from === 'string' ? auth.from : 'unknown';
  if (!selectsEip3009(requirements)) return { ok: false, reason: 'unsupported_asset_transfer_method', payer };
  if ((requirements.extra?.name !== undefined && typeof requirements.extra.name !== 'string') || (requirements.extra?.version !== undefined && typeof requirements.extra.version !== 'string')) return { ok: false, reason: 'invalid_payload', payer };
  if (!auth || typeof auth !== 'object') return { ok: false, reason: 'invalid_payload', payer };
  // EOA signatures only (65 bytes). ERC-1271 / ERC-6492 smart-wallet signatures are out of scope.
  if (!isSignature(payload?.signature)) return { ok: false, reason: 'invalid_exact_evm_payload_signature', payer };
  // ecrecover accepts both s and n - s, so viem's verifyTypedData passes a high-s signature,
  // but the token contracts reject it on chain. Radius settles without a simulation, so a
  // high-s payload would be broadcast, revert, and burn the facilitator's gas.
  if (BigInt(`0x${payload.signature.slice(66, 130)}`) > SECP256K1_HALF_N) return { ok: false, reason: 'invalid_exact_evm_payload_signature', payer };
  if (!isAddress(auth.from) || !isAddress(auth.to) || !isUint(auth.value) || !isUint(auth.validAfter) || !isUint(auth.validBefore) || typeof auth.nonce !== 'string' || !bytes32.test(auth.nonce)) return { ok: false, reason: 'invalid_payload', payer };
  if (!isAddress(requirements?.payTo) || !sameAddress(auth.to, requirements.payTo)) return { ok: false, reason: 'invalid_exact_evm_payload_recipient_mismatch', payer };
  if (!isUint(requirements?.amount) || BigInt(auth.value) !== BigInt(requirements.amount)) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_value_mismatch', payer };
  if (sameAddress(auth.from, auth.to)) return { ok: false, reason: 'invalid_self_payment', payer };
  if (nowSeconds < BigInt(auth.validAfter)) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_after', payer };
  if (BigInt(auth.validBefore) - nowSeconds < minRemainingSeconds) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_before', payer };
  return { ok: true, auth: { from: auth.from, to: auth.to, value: auth.value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce }, signature: payload.signature };
}

/** Domain name/version come from our token config, never from the client. */
export async function verifyEip3009Signature(auth: Eip3009Authorization, signature: string, token: { address: string; name: string; version: string }, chainId: number): Promise<boolean> {
  return verifyTypedData({
    address: auth.from as `0x${string}`,
    domain: { name: token.name, version: token.version, chainId, verifyingContract: token.address as `0x${string}` },
    types: transferWithAuthorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: { from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` },
    signature: signature as `0x${string}`,
  });
}

/** Arguments for the v/r/s `transferWithAuthorization` overload. */
export function transferWithAuthorizationArgs(auth: Eip3009Authorization, signature: string) {
  const sig = parseSignature(signature as `0x${string}`);
  const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27;
  return [auth.from as `0x${string}`, auth.to as `0x${string}`, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce as `0x${string}`, v, sig.r, sig.s] as const;
}

export const eip3009Abi = [
  { type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', inputs: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
  ], outputs: [] },
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
] as const;
