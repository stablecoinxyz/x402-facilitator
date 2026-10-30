/**
 * Sui Exact adapter.
 *
 * Wraps the vendored `ExactSuiScheme` (upstream PR #3082, implementing spec PR
 * #3081) so the routes see the same shape as the SVM adapter. One instance per
 * process, built only when `SUI_EXACT_ENABLED` is on and a network is set.
 *
 * No fee payer is configured: phase 1 accepts gasless USDC payments (Circle
 * USDC is on Sui's gasless allowlist) and self-paid payments. A sponsor is
 * needed only for assets outside that allowlist, which is phase 2.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import type { Network } from '@x402/core/types';
import { getSuiGrpcUrl, getSuiNetwork, getSuiNetworks } from '../config';
import { ExactSuiScheme } from './vendor/exact/facilitator';
import { getSuiNetworkName } from './vendor/utils';

let scheme: ExactSuiScheme | undefined;
const clients = new Map<string, SuiGrpcClient>();

/**
 * Build (once) the scheme, with one client per served network.
 *
 * Upstream takes a client per CAIP-2 id and picks by the request's network, so a
 * single scheme instance serves mainnet and testnet at the same time. The map
 * here is the authority for which endpoints exist: a network we do not serve has
 * no client, and the routes refuse it before the scheme is reached.
 */
export function getExactSuiScheme(): ExactSuiScheme {
  if (scheme) return scheme;
  const networks = getSuiNetworks();
  if (networks.length === 0) {
    throw new Error('SUI_NETWORKS must name at least one of sui:mainnet, sui:testnet when SUI_EXACT_ENABLED=true');
  }

  const byNetwork: Record<string, SuiGrpcClient> = {};
  for (const network of networks) {
    // `caip2` is always one of the literal ids in SUI_NETWORKS, so the cast only
    // restores the template-literal type that config.ts stores as `string`.
    const client = new SuiGrpcClient({
      network: getSuiNetworkName(network.caip2 as Network),
      baseUrl: getSuiGrpcUrl(network.caip2),
    });
    byNetwork[network.caip2] = client;
    clients.set(network.caip2, client);
  }

  scheme = new ExactSuiScheme({ clients: byNetwork });
  return scheme;
}

/** The client a network submits through, built with the scheme. */
function suiClient(caip2: string): SuiGrpcClient {
  getExactSuiScheme();
  const client = clients.get(caip2);
  if (!client) throw new Error(`Sui client is not configured for ${caip2}`);
  return client;
}

/**
 * Asset policy, enforced before the scheme sees the payment.
 *
 * Verification is effects-only, so the scheme accepts a transfer in *any* coin
 * type — it checks that `payTo` was credited `amount` of `requirements.asset`,
 * not that the asset is one we serve. Without this check the facilitator would
 * settle payments denominated in arbitrary Sui tokens, so the requirement's
 * asset must be the configured asset for the network.
 *
 * Struct tags are compared normalized: a payer may write the short form
 * (`0x2::sui::SUI`) where the node reports the full address, and the two are
 * the same coin.
 *
 * @param caip2 - The network the payment names; its asset is the only one served
 * @param asset - The requirement's asset, as the caller supplied it
 */
export function isAllowedSuiAsset(caip2: string, asset: unknown): boolean {
  const network = getSuiNetwork(caip2);
  if (!network || typeof asset !== 'string' || asset.length === 0) return false;
  try {
    return normalizeStructTag(asset) === normalizeStructTag(network.asset);
  } catch {
    // A malformed struct tag is not a payment we serve.
    return false;
  }
}

/**
 * The digest of a base64 transaction, or null when it does not decode.
 *
 * The scheme's `duplicate_settlement` answer carries an empty `transaction`,
 * which reads to a payer as "nothing happened" and would push them to sign a
 * second payment. The duplicate is keyed on this payload's own digest, so the
 * route restores it from the bytes it was given.
 */
export async function suiTransactionDigest(transaction: unknown): Promise<string | null> {
  if (typeof transaction !== 'string' || transaction.length === 0) return null;
  try {
    return await Transaction.from(transaction).getDigest();
  } catch {
    return null;
  }
}

/**
 * What the chain says about the transaction inside a payment payload.
 *
 * `absent` and `unknown` are different answers. `absent` means the chain was
 * read and holds no such transaction — nothing was broadcast, so a terminal
 * failure is accurate. `unknown` means the chain could not be read at all, and
 * must never read as "did not happen", or a broadcast whose receipt was lost
 * would be reported as a terminal failure and the payer would sign a second
 * payment.
 */
export type SuiChainVerdict =
  | { state: 'executed'; digest: string; sender: string; succeeded: boolean }
  | { state: 'absent'; digest: string; sender: string }
  | { state: 'unknown'; digest: string; sender: string };

/**
 * Look the payload's transaction up on chain.
 *
 * A lookup that throws is disambiguated by probing the chain itself: a chain
 * that answers a second, unrelated call simply does not hold the transaction,
 * while a chain that fails both calls told us nothing.
 *
 * @param transaction - Base64 transaction bytes from the payment payload
 * @param caip2 - The network the payment names; its client is the one that answers
 * @returns The chain's answer, or null when the bytes do not decode
 */
export async function suiChainVerdict(transaction: unknown, caip2: string): Promise<SuiChainVerdict | null> {
  if (typeof transaction !== 'string' || transaction.length === 0) return null;
  let digest: string;
  let sender: string;
  try {
    const decoded = Transaction.from(transaction);
    digest = await decoded.getDigest();
    sender = decoded.getData().sender ?? '';
  } catch {
    return null;
  }
  try {
    const executed = await suiClient(caip2).core.getTransaction({ digest });
    return { state: 'executed', digest, sender, succeeded: executed.$kind === 'Transaction' };
  } catch {
    // The lookup failed. Was that because the transaction is not there, or
    // because the chain is not answering? A chain that cannot answer this
    // either has told us nothing.
    try {
      await suiClient(caip2).core.getChainIdentifier();
      return { state: 'absent', digest, sender };
    } catch {
      return { state: 'unknown', digest, sender };
    }
  }
}

/**
 * Whether the client's echoed acceptance is the same offer the requirements
 * state — the envelope binding every other scheme here enforces.
 *
 * The money check does not depend on this: the scheme compares chain effects to
 * `paymentRequirements`, and the payer's signature commits the transaction
 * bytes, so swapping either object after signing yields a transfer mismatch.
 * What it prevents is a resource server that inspects the echoed `accepted`
 * being told a different offer was verified than the one that was.
 *
 * Sui is v2-only here, so every security input must be present. A v1 flat
 * payload normalizes to `{scheme, network}` and cannot satisfy this; it is
 * refused rather than guessed at.
 */
export function suiAcceptanceBindsRequirements(accepted: unknown, requirements: unknown): boolean {
  const a = accepted as Record<string, unknown> | null | undefined;
  const r = requirements as Record<string, unknown> | null | undefined;
  if (!a || !r) return false;
  if (typeof a.network !== 'string' || a.network !== r.network) return false;
  if (typeof a.amount !== 'string' || a.amount !== r.amount) return false;
  if (typeof a.asset !== 'string' || typeof r.asset !== 'string') return false;
  if (typeof a.payTo !== 'string' || typeof r.payTo !== 'string') return false;
  try {
    return (
      normalizeStructTag(a.asset) === normalizeStructTag(r.asset) &&
      normalizeSuiAddress(a.payTo) === normalizeSuiAddress(r.payTo)
    );
  } catch {
    return false;
  }
}

/**
 * Error codes whose message is a caught exception or node text, and so may
 * carry transport detail such as the gRPC endpoint that holds the provider key.
 *
 * Codes absent from this set carry messages this codebase composes itself
 * (`recipient X credited Y, expected Z`, epoch windows), which are the
 * diagnostics callers need and are safe to return.
 */
const TRANSPORT_TEXT_REASONS: Record<string, true> = {
  transaction_failed: true,
  invalid_exact_sui_payload_verification_error: true,
  invalid_exact_sui_payload_transaction_could_not_be_decoded: true,
  invalid_exact_sui_payload_simulation_failed: true,
  sponsor_rejected: true,
};

/**
 * Whether a response's message must be replaced before it leaves the process.
 *
 * @param reason - `invalidReason` or `errorReason` from the scheme
 * @returns True when the message originates outside this codebase
 */
export function suiMessageNeedsRedaction(reason: unknown): boolean {
  return typeof reason === 'string' && TRANSPORT_TEXT_REASONS[reason] === true;
}
