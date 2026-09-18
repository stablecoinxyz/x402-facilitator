/**
 * Official x402 SVM Exact scheme adapter.
 *
 * The client signs the complete transfer transaction.  This process only
 * verifies the required payment outcome and adds its fee-payer signature; it
 * never constructs a delegated token transfer from an off-chain message.
 */
import { createKeyPairSignerFromBytes, createSolanaRpc, mainnet } from '@solana/kit';
import { toFacilitatorSvmSigner } from '@x402/svm';
import bs58 from 'bs58';
import { config, SOLANA_MAINNET_CAIP2 } from '../config';

type ExactSvmScheme = {
  verify(payload: unknown, requirements: unknown): Promise<any>;
  settle(payload: unknown, requirements: unknown): Promise<any>;
  getExtra(network: string): Record<string, unknown> | undefined;
  getSigners(network: string): string[];
};

// TypeScript's CommonJS resolver cannot see this package's conditional
// subpath declaration, although Node can load it. Keep the integration on the
// official public subpath rather than importing package internals.
const { ExactSvmScheme }: { ExactSvmScheme: new (signer: ReturnType<typeof toFacilitatorSvmSigner>, cache?: unknown, options?: Record<string, unknown>) => ExactSvmScheme } = require('@x402/svm/exact/facilitator');

let scheme: ExactSvmScheme | undefined;

/** Build one process-wide official scheme, including its 120-second dedup cache. */
export async function getExactSvmScheme(): Promise<ExactSvmScheme> {
  if (scheme) return scheme;
  if (!config.solanaFacilitatorPrivateKey || !config.solanaFacilitatorAddress) {
    throw new Error('Solana facilitator signing configuration is incomplete');
  }

  const keypair = await createKeyPairSignerFromBytes(bs58.decode(config.solanaFacilitatorPrivateKey));
  if (keypair.address !== config.solanaFacilitatorAddress) {
    throw new Error('SOLANA_FACILITATOR_ADDRESS does not match SOLANA_FACILITATOR_PRIVATE_KEY');
  }

  const rpc = createSolanaRpc(mainnet(config.solanaRpcUrl));
  scheme = new ExactSvmScheme(toFacilitatorSvmSigner(keypair, rpc), undefined, {
    // Conservative sponsor caps for a simple token transfer. Smart-wallet
    // simulation stays opt-in until its complete post-settlement verifier and
    // ALT policy are deliberately configured.
    maxComputeUnits: 400_000,
    maxPriorityFeeMicroLamports: 50_000,
    maxRequiredSignatures: 2,
  });
  return scheme;
}

export { SOLANA_MAINNET_CAIP2 };
