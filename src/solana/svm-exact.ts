/**
 * Official x402 SVM Exact adapter.
 *
 * A payer signs the complete transfer transaction. This service only verifies
 * that immutable transaction and supplies the configured fee-payer signature;
 * it never turns an off-chain Solana authorization into a token transfer.
 */
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { toFacilitatorSvmSigner } from '@x402/svm';
import bs58 from 'bs58';
import { config, getSolanaSvmNetwork, isSolanaSvmExactEnabled } from '../config';

type ExactSvmScheme = {
  verify(payload: unknown, requirements: unknown): Promise<any>;
  settle(payload: unknown, requirements: unknown): Promise<any>;
};

// The package publishes this public conditional-export subpath, but this
// repository's CommonJS TypeScript resolver cannot see its declaration.
const { ExactSvmScheme }: {
  ExactSvmScheme: new (
    signer: ReturnType<typeof toFacilitatorSvmSigner>,
    cache?: unknown,
    options?: Record<string, unknown>,
  ) => ExactSvmScheme;
} = require('@x402/svm/exact/facilitator');

let scheme: ExactSvmScheme | undefined;

/** Build the official scheme, including its short in-flight settlement cache. */
export async function getExactSvmScheme(): Promise<ExactSvmScheme> {
  const network = getSolanaSvmNetwork();
  if (!isSolanaSvmExactEnabled() || !network) {
    throw new Error('SVM Exact is not explicitly enabled for a supported Solana network');
  }
  if (scheme) return scheme;
  if (!config.solanaFacilitatorPrivateKey || !config.solanaFacilitatorAddress) {
    throw new Error('Solana facilitator signing configuration is incomplete');
  }

  const keypair = await createKeyPairSignerFromBytes(bs58.decode(config.solanaFacilitatorPrivateKey));
  if (keypair.address !== config.solanaFacilitatorAddress) {
    throw new Error('SOLANA_FACILITATOR_ADDRESS does not match SOLANA_FACILITATOR_PRIVATE_KEY');
  }

  // The official adapter selects a cluster-typed RPC from the request network;
  // supplying only the endpoint preserves that check instead of pretending a
  // devnet endpoint is mainnet through a type wrapper.
  scheme = new ExactSvmScheme(toFacilitatorSvmSigner(keypair, { defaultRpcUrl: config.solanaRpcUrl }), undefined, {
    maxComputeUnits: 400_000,
    maxPriorityFeeMicroLamports: 50_000,
    maxRequiredSignatures: 2,
  });
  return scheme;
}
