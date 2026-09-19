/**
 * One low-value production proof of the standard x402 SVM Exact flow.
 *
 * Requires a funded, gitignored payer at .mainnet-svm-test-payer.json and an
 * existing SBC ATA for SVM_MAINNET_MERCHANT. The payer signs the transfer;
 * the live facilitator is the only fee payer and is reached over HTTPS.
 */
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import { createKeyPairSignerFromBytes } from '@solana/kit';

const RPC_URL = 'https://api.mainnet-beta.solana.com';
const FACILITATOR_URL = 'https://x402.stablecoin.xyz';
const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SBC_MINT = 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA';
const FEE_PAYER = '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K';
const AMOUNT = '1000000'; // 0.001 SBC (nine decimals)
const PAYER_PATH = path.resolve(process.cwd(), '.mainnet-svm-test-payer.json');
const merchant = process.env.SVM_MAINNET_MERCHANT;

async function post(pathname: string, body: unknown) {
  const response = await fetch(`${FACILITATOR_URL}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result as any;
}

async function main() {
  if (!merchant) throw new Error('SVM_MAINNET_MERCHANT must name the merchant public key');
  if (!fs.existsSync(PAYER_PATH)) throw new Error(`missing payer keypair: ${PAYER_PATH}`);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(PAYER_PATH, 'utf8'))));
  const connection = new Connection(RPC_URL, 'confirmed');
  const merchantAta = await getAssociatedTokenAddress(new PublicKey(SBC_MINT), new PublicKey(merchant));
  await getAccount(connection, merchantAta, 'confirmed');

  const { ExactSvmScheme } = await import('@x402/svm/exact/client');
  const client = new ExactSvmScheme(await createKeyPairSignerFromBytes(payer.secretKey), { rpcUrl: RPC_URL });
  const requirements = {
    scheme: 'exact', network: NETWORK, amount: AMOUNT, asset: SBC_MINT, payTo: merchant,
    maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER },
  };
  const created = await client.createPaymentPayload(2, requirements);
  const paymentPayload = {
    x402Version: 2,
    resource: { url: 'https://mainnet-proof.invalid', description: 'SVM Exact mainnet proof', mimeType: 'application/json' },
    accepted: requirements,
    payload: created.payload,
  };

  const verified = await post('/verify', { paymentPayload, paymentRequirements: requirements });
  if (!verified.isValid) throw new Error(`verify failed: ${JSON.stringify(verified)}`);
  const settled = await post('/settle', { paymentPayload, paymentRequirements: requirements });
  if (!settled.success || !settled.transaction) throw new Error(`settle failed: ${JSON.stringify(settled)}`);

  console.log(JSON.stringify({ network: NETWORK, transaction: settled.transaction, payer: payer.publicKey.toBase58(), merchant, amount: AMOUNT }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
