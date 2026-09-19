/**
 * End-to-end proof for the gated standard x402 SVM Exact flow.
 *
 * Uses throwaway devnet identities and a temporary SPL mint. It creates a
 * payer-signed transaction through the official x402 client, then sends it to
 * this facilitator's actual /verify and /settle handlers. No production key,
 * token, RPC endpoint, or feature flag is used.
 */
import express from 'express';
import request from 'supertest';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { createKeyPairSignerFromBytes } from '@solana/kit';

const RPC_URL = 'https://api.devnet.solana.com';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const DECIMALS = 6;
const AMOUNT = 1_000; // 0.001 of the temporary token
const SPONSOR_KEYPAIR_PATH = process.env.SVM_DEVNET_SPONSOR_KEYPAIR
  || path.resolve(process.cwd(), '.devnet-svm-sponsor.json');

function loadSponsor(): Keypair {
  if (!fs.existsSync(SPONSOR_KEYPAIR_PATH)) {
    throw new Error(`missing persistent devnet sponsor keypair at ${SPONSOR_KEYPAIR_PATH}; generate it with solana-keygen before running this proof`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(SPONSOR_KEYPAIR_PATH, 'utf8'))));
}

async function confirmAirdrop(connection: Connection, address: PublicKey) {
  let lastError: unknown;
  // The public devnet endpoint is intentionally rate-limited. Three small,
  // spaced requests make transient faucet errors recoverable without asking
  // for more than the proof needs.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const signature = await connection.requestAirdrop(address, LAMPORTS_PER_SOL / 10);
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 5_000));
    }
  }
  throw new Error(`devnet faucet could not fund the throwaway sponsor after 3 attempts: ${String(lastError)}`);
}

async function main() {
  const sponsor = loadSponsor();
  const payer = Keypair.generate();
  const merchant = Keypair.generate();
  const connection = new Connection(RPC_URL, 'confirmed');

  if ((await connection.getBalance(sponsor.publicKey, 'confirmed')) < LAMPORTS_PER_SOL / 50) {
    await confirmAirdrop(connection, sponsor.publicKey);
  }

  const mint = await createMint(connection, sponsor, sponsor.publicKey, null, DECIMALS);
  const payerAta = await getOrCreateAssociatedTokenAccount(connection, sponsor, mint, payer.publicKey);
  const merchantAta = await getOrCreateAssociatedTokenAccount(connection, sponsor, mint, merchant.publicKey);
  await mintTo(connection, sponsor, mint, payerAta.address, sponsor, AMOUNT);

  // Set these before importing application modules. dotenv does not overwrite
  // process environment values, so this isolated process cannot inherit the
  // production mainnet configuration from a developer's .env file.
  Object.assign(process.env, {
    SOLANA_RPC_URL: RPC_URL,
    SOLANA_FACILITATOR_PRIVATE_KEY: bs58.encode(sponsor.secretKey),
    SOLANA_FACILITATOR_ADDRESS: sponsor.publicKey.toBase58(),
    SOLANA_SVM_EXACT_ENABLED: 'true',
    SOLANA_SVM_NETWORK: 'solana-devnet',
    ENABLE_REAL_SETTLEMENT: 'true',
    ALLOW_SIMULATED_SETTLEMENT: 'false',
  });

  const [{ ExactSvmScheme: ExactSvmClient }, { verifyPayment }, { settlePayment }] = await Promise.all([
    import('@x402/svm/exact/client'),
    import('../src/routes/verify'),
    import('../src/routes/settle'),
  ]);
  const payerSigner = await createKeyPairSignerFromBytes(payer.secretKey);
  const client = new ExactSvmClient(payerSigner, { rpcUrl: RPC_URL });
  const requirements = {
    scheme: 'exact',
    network: DEVNET,
    amount: String(AMOUNT),
    asset: mint.toBase58(),
    payTo: merchant.publicKey.toBase58(),
    maxTimeoutSeconds: 60,
    extra: { feePayer: sponsor.publicKey.toBase58() },
  };
  const created = await client.createPaymentPayload(2, requirements);
  const paymentPayload = {
    x402Version: 2,
    resource: { url: 'https://devnet-proof.invalid', description: 'SVM Exact devnet proof', mimeType: 'application/json' },
    accepted: requirements,
    payload: created.payload,
  };

  const app = express();
  app.use(express.json());
  app.post('/verify', verifyPayment);
  app.post('/settle', settlePayment);

  const verified = await request(app).post('/verify').send({ paymentPayload, paymentRequirements: requirements });
  if (!verified.body.isValid) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);

  const settled = await request(app).post('/settle').send({ paymentPayload, paymentRequirements: requirements });
  if (!settled.body.success || typeof settled.body.transaction !== 'string' || !settled.body.transaction) {
    throw new Error(`settle failed: ${JSON.stringify(settled.body)}`);
  }

  const merchantBalance = await getAccount(connection, merchantAta.address, 'confirmed');
  if (merchantBalance.amount !== BigInt(AMOUNT)) {
    throw new Error(`unexpected merchant balance: ${merchantBalance.amount}`);
  }

  // Public identities and the devnet transaction are deliberately printed;
  // secret keys are never printed or stored.
  console.log(JSON.stringify({
    network: DEVNET,
    transaction: settled.body.transaction,
    mint: mint.toBase58(),
    sponsor: sponsor.publicKey.toBase58(),
    payer: payer.publicKey.toBase58(),
    merchant: merchant.publicKey.toBase58(),
    amount: String(AMOUNT),
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
