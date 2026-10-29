/**
 * End-to-end proof for x402 Sui `exact`.
 *
 * Drives this facilitator's REAL /verify and /settle handlers — in-process, the
 * same route code that serves production — against a REAL Sui gRPC fullnode:
 *
 *   1. build a gasless USDC payment (no SUI, no sponsor) for the configured
 *      network, exactly as an x402 client would;
 *   2. POST /verify and require a valid verdict;
 *   3. POST /settle and require success with the transaction digest;
 *   4. re-POST the SAME signed bytes and require `duplicate_settlement`, not a
 *      second success — the behaviour that differs from our EVM replay path;
 *   5. read both balances back from chain and confirm the credit and debit;
 *   6. confirm the digest is on chain.
 *
 * The payer is a throwaway key supplied by the operator, so no production key
 * is used and nothing is printed that identifies it beyond its public address.
 * The proof is self-limiting: it spends one small payment.
 *
 * Requirements:
 *   SUI_EXACT_ENABLED=true  SUI_NETWORK=<sui:testnet|sui:mainnet>  SUI_GRPC_URL=<gRPC endpoint>
 *   SUI_PROVE_PRIVATE_KEY=<hex Ed25519 secret key>
 *   SUI_PROVE_PAY_TO=<Sui address>            (default: the spike recipient below)
 *   SUI_PROVE_AMOUNT=<atomic units>           (default: 50000 = 0.05 USDC)
 *
 * The payer must hold at least SUI_PROVE_AMOUNT of the network's USDC and, for a
 * gasless payment, must end with an address balance of 0 or at least 0.01 USDC.
 */
import express from 'express';
import request from 'supertest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { config, getSuiNetwork, SUI_TESTNET_CAIP2 } from '../src/config';
import { verifyPayment } from '../src/routes/verify';
import { settlePayment } from '../src/routes/settle';

const DEFAULT_PAY_TO = '0xef77673777af31b83b7037de153b9a3b68ad304b761caed2e623437eae9b207a';
const PAY_TO = process.env.SUI_PROVE_PAY_TO || DEFAULT_PAY_TO;
const AMOUNT = BigInt(process.env.SUI_PROVE_AMOUNT || '50000');

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/**
 * A throwaway Ed25519 key from either a 64-char hex secret or a bech32
 * `suiprivkey...` string. Hex must be decoded first: the SDK reads a string as
 * bech32, so passing hex directly fails its checksum.
 */
function loadKeypair(raw: string): Ed25519Keypair {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(value, 'hex')));
  }
  return Ed25519Keypair.fromSecretKey(value);
}

function requireEnv(): { keypair: Ed25519Keypair; network: { caip2: string; asset: string; decimals: number } } {
  if (config.suiExactEnabled !== true) {
    fail('SUI_EXACT_ENABLED must be true. Run through `npm run prove:sui-testnet` or `npm run prove:sui-mainnet`.');
  }
  if (!config.suiGrpcUrl) {
    fail('SUI_GRPC_URL must be set to the gRPC fullnode for the configured network.');
  }
  const network = getSuiNetwork();
  if (!network) {
    fail('SUI_NETWORK must be exactly sui:mainnet or sui:testnet (CAIP-2, no aliases).');
  }
  const hex = process.env.SUI_PROVE_PRIVATE_KEY;
  if (!hex) {
    fail('SUI_PROVE_PRIVATE_KEY must hold a throwaway Ed25519 secret key (hex). Never use a production key.');
  }
  return { keypair: loadKeypair(hex), network };
}

async function main() {
  const { keypair, network } = requireEnv();
  const payer = keypair.toSuiAddress();
  const client = new SuiGrpcClient({ network: network.caip2 === SUI_TESTNET_CAIP2 ? 'testnet' : 'mainnet', baseUrl: config.suiGrpcUrl });

  const readBalance = async (owner: string): Promise<bigint> => {
    const { balance } = await client.core.getBalance({ owner, coinType: network.asset });
    return BigInt(balance.balance);
  };

  console.log(`network   ${network.caip2}`);
  console.log(`asset     ${network.asset}`);
  console.log(`payer     ${payer}`);
  console.log(`payTo     ${PAY_TO}`);
  console.log(`amount    ${AMOUNT} (atomic)`);

  const payerBefore = await readBalance(payer);
  const payToBefore = await readBalance(PAY_TO);
  console.log(`balances  payer=${payerBefore} payTo=${payToBefore}`);

  if (payerBefore < AMOUNT) {
    fail(`payer holds ${payerBefore} of the asset, less than the ${AMOUNT} this proof pays. Fund it first; the proof does not fund anything.`);
  }

  // Build the payment the way an x402 client does: a gasless
  // `balance::send_funds` bounded by a two-epoch window. No sponsor, no gas coin.
  const tx = new Transaction();
  tx.setSender(payer);
  tx.moveCall({
    target: '0x2::balance::send_funds',
    typeArguments: [network.asset],
    arguments: [
      tx.balance({ type: network.asset, balance: AMOUNT, useGasCoin: false }),
      tx.pure.address(PAY_TO),
    ],
  });

  const [{ systemState }, { chainIdentifier }] = await Promise.all([
    client.core.getCurrentSystemState(),
    client.core.getChainIdentifier(),
  ]);
  const epoch = BigInt(systemState.epoch);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(epoch),
      maxEpoch: String(epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: (Math.random() * 0x100000000) >>> 0,
    },
  });

  const built = await tx.build({ client });
  const signed = await keypair.signTransaction(built);
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: network.caip2,
      amount: String(AMOUNT),
      asset: network.asset,
      payTo: PAY_TO,
      maxTimeoutSeconds: 600,
      extra: {},
    },
    payload: { transaction: signed.bytes, signature: signed.signature },
  };
  const body = { paymentPayload: payload, paymentRequirements: payload.accepted };

  // Default: the real route handlers in this process. Set SUI_PROVE_BASE_URL to
  // drive a deployed host instead — the live smoke a deploy needs, over the real
  // socket, through the proxy, with the host's own secrets.
  const baseUrl = process.env.SUI_PROVE_BASE_URL?.replace(/\/$/, '');
  const app = express();
  app.use(express.json());
  app.post('/verify', verifyPayment);
  app.post('/settle', settlePayment);
  const post = async (path: string, payloadBody: unknown) => {
    if (!baseUrl) return request(app).post(path).send(payloadBody);
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadBody),
    });
    return { status: response.status, body: await response.json() };
  };
  console.log(`target    ${baseUrl ?? 'in-process routes'}`);

  const verified = await post('/verify', body);
  console.log(`verify    ${JSON.stringify(verified.body)}`);
  if (verified.status !== 200 || verified.body.isValid !== true) {
    fail(`verify rejected the payment: ${JSON.stringify(verified.body)}`);
  }

  const settled = await post('/settle', body);
  console.log(`settle    ${JSON.stringify(settled.body)}`);
  if (settled.status !== 200 || settled.body.success !== true) {
    fail(`settle failed: ${JSON.stringify(settled.body)}`);
  }
  const digest: string = settled.body.transaction;
  if (!digest || digest.startsWith('0x')) {
    fail(`settle must report the base58 digest, got ${JSON.stringify(digest)}`);
  }

  // Success at most once: the same bytes, again, must not read as a second
  // payment. The scheme's own duplicate answer carries an empty `transaction`
  // (measured on testnet 2026-10-29), so this also guards the route's
  // restoration of the digest: a payer must be able to reconcile.
  const replay = await post('/settle', body);
  console.log(`replay    ${JSON.stringify(replay.body)}`);
  if (replay.body.success !== false || replay.body.errorReason !== 'duplicate_settlement') {
    fail(`a re-settle must answer duplicate_settlement, got ${JSON.stringify(replay.body)}`);
  }
  if (replay.body.transaction !== digest) {
    fail(`the replay must carry the same digest ${digest}, got ${JSON.stringify(replay.body.transaction)}`);
  }

  const payerAfter = await readBalance(payer);
  const payToAfter = await readBalance(PAY_TO);
  console.log(`balances  payer=${payerAfter} payTo=${payToAfter}`);

  if (payerBefore - payerAfter !== AMOUNT) {
    fail(`payer debit is ${payerBefore - payerAfter}, expected ${AMOUNT}`);
  }
  if (payToAfter - payToBefore !== AMOUNT) {
    fail(`payTo credit is ${payToAfter - payToBefore}, expected ${AMOUNT}`);
  }

  const onChain = await client.core.getTransaction({ digest });
  if (onChain.$kind !== 'Transaction') {
    fail(`digest ${digest} is not a successful transaction on chain (${onChain.$kind})`);
  }

  console.log('');
  console.log('PASS');
  console.log(`  digest    ${digest}`);
  console.log(`  debit     ${payerBefore} -> ${payerAfter}`);
  console.log(`  credit    ${payToBefore} -> ${payToAfter}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
