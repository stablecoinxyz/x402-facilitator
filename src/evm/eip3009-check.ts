import { createPublicClient, http, erc20Abi, decodeEventLog, type PublicClient, type Log } from 'viem';
import type { Logger } from 'pino';
import { resolveToken, type ResolvedToken } from '../config';
import { parseEip3009, verifyEip3009Signature, selectsEip3009, eip3009Abi, EIP3009_NONCE_ALREADY_USED, type Eip3009Authorization } from './eip3009';
import { isAddress } from './permit2';

type EvmNetwork = { chainId: number; label: string; rpcUrl: string };

type Failure = { ok: false; reason: string; payer: string; metric: 'invalid' | 'invalid_signature' | 'settlement_asset_unavailable' };
export type Eip3009OfflineResult = { ok: true; auth: Eip3009Authorization; signature: string; token: ResolvedToken } | Failure;
export type Eip3009CheckResult = { ok: true; auth: Eip3009Authorization; signature: string; token: ResolvedToken; client: PublicClient } | Failure;

function sameAddr(a: unknown, b: unknown): boolean {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function normalizedMethod(extra: any): string | undefined {
  const m = extra?.assetTransferMethod;
  return m === undefined ? 'eip3009' : m;
}

/**
 * Every check `/verify` and `/settle` share for an EIP-3009 payment. `/settle`
 * runs it itself — it never relies on a prior `/verify`.
 */
export async function checkEip3009Payment(
  paymentPayload: any,
  paymentRequirements: any,
  networkConfig: EvmNetwork,
  minRemainingSeconds: bigint,
  log: Logger,
): Promise<Eip3009CheckResult> {
  const offline = await checkEip3009Offline(paymentPayload, paymentRequirements, networkConfig, minRemainingSeconds);
  if (!offline.ok) return offline;
  return checkEip3009Chain(offline, networkConfig, log);
}

/** Binding, token capability, payload and signature. No RPC. */
export async function checkEip3009Offline(
  paymentPayload: any,
  paymentRequirements: any,
  networkConfig: EvmNetwork,
  minRemainingSeconds: bigint,
): Promise<Eip3009OfflineResult> {
  const fromField = paymentPayload?.payload?.authorization?.from;
  const payer = typeof fromField === 'string' ? fromField : 'unknown';
  const accepted = paymentPayload?.accepted;
  if (
    accepted?.network !== paymentRequirements.network ||
    accepted?.amount !== paymentRequirements.amount ||
    !sameAddr(accepted?.asset, paymentRequirements.asset) ||
    !sameAddr(accepted?.payTo, paymentRequirements.payTo) ||
    normalizedMethod(accepted?.extra) !== normalizedMethod(paymentRequirements.extra) ||
    accepted?.extra?.name !== paymentRequirements.extra?.name ||
    accepted?.extra?.version !== paymentRequirements.extra?.version
  ) return { ok: false, reason: 'invalid_payload', payer, metric: 'invalid' };

  const token = isAddress(paymentRequirements.asset) ? resolveToken(networkConfig.chainId, paymentRequirements.asset) : null;
  if (!token) return { ok: false, reason: 'unsupported_asset', payer, metric: 'invalid' };
  if (!token.eip3009 || !selectsEip3009(paymentRequirements)) return { ok: false, reason: 'unsupported_asset_transfer_method', payer, metric: 'invalid' };

  const parsed = parseEip3009(paymentPayload.payload, paymentRequirements, BigInt(Math.floor(Date.now() / 1000)), minRemainingSeconds);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, payer: parsed.payer, metric: 'invalid' };

  let signatureOk = false;
  try { signatureOk = await verifyEip3009Signature(parsed.auth, parsed.signature, token, networkConfig.chainId); } catch { signatureOk = false; }
  if (!signatureOk) return { ok: false, reason: 'invalid_exact_evm_payload_signature', payer: parsed.auth.from, metric: 'invalid_signature' };
  return { ok: true, auth: parsed.auth, signature: parsed.signature, token };
}

/** Token bytecode, `authorizationState`, balance. */
export async function checkEip3009Chain(
  offline: { auth: Eip3009Authorization; signature: string; token: ResolvedToken },
  networkConfig: EvmNetwork,
  log: Logger,
): Promise<Eip3009CheckResult> {
  const { auth, token } = offline;
  const parsed = { auth, signature: offline.signature };
  const client = createPublicClient({
    chain: { id: networkConfig.chainId, name: networkConfig.label, nativeCurrency: { decimals: 18, name: 'Native', symbol: 'NATIVE' }, rpcUrls: { default: { http: [networkConfig.rpcUrl] } } },
    transport: http(networkConfig.rpcUrl),
  }) as PublicClient;

  const code = await client.getCode({ address: token.address as `0x${string}` });
  if (!code || code === '0x') {
    log.error({ payer: parsed.auth.from, network: networkConfig.chainId, token: token.address, result: 'settlement_asset_unavailable' }, 'EIP-3009 refused: configured token has no deployed bytecode on the target chain');
    return { ok: false, reason: 'unsupported_asset', payer: parsed.auth.from, metric: 'settlement_asset_unavailable' };
  }

  const [used, balance] = await Promise.all([
    client.readContract({ address: token.address as `0x${string}`, abi: eip3009Abi, functionName: 'authorizationState', args: [parsed.auth.from as `0x${string}`, parsed.auth.nonce as `0x${string}`] }),
    client.readContract({ address: token.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [parsed.auth.from as `0x${string}`] }),
  ]);
  // A used authorization is never answered as a success: after settlement its
  // calldata is public, and a merchant that branches on `success` would deliver
  // again to whoever replays it. Same decision as Permit2 (2026-10-29).
  if (used) return { ok: false, reason: EIP3009_NONCE_ALREADY_USED, payer: parsed.auth.from, metric: 'invalid' };
  if (balance < BigInt(parsed.auth.value)) return { ok: false, reason: 'insufficient_funds', payer: parsed.auth.from, metric: 'invalid' };

  return { ok: true, auth: parsed.auth, signature: parsed.signature, token, client };
}

/** True when the receipt carries `Transfer(from, to, value)` emitted by the token. */
export function receiptHasTransfer(logs: Log[], token: string, auth: Eip3009Authorization): boolean {
  return logs.some((l) => {
    if (!sameAddr(l.address, token)) return false;
    try {
      const ev = decodeEventLog({ abi: eip3009Abi, data: l.data, topics: l.topics });
      return ev.eventName === 'Transfer' && sameAddr(ev.args.from, auth.from) && sameAddr(ev.args.to, auth.to) && ev.args.value === BigInt(auth.value);
    } catch { return false; }
  });
}
