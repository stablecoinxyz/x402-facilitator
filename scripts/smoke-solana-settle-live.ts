/**
 * End-to-end Solana settlement against mainnet, with real funds.
 *
 *   SOLANA_PAYER_PRIVATE_KEY=<base58 secret key> \
 *   SOLANA_MERCHANT_ADDRESS=<base58 pubkey> \
 *   npm run smoke:solana:live -- --target $FACILITATOR_URL --yes
 *
 * The gate smoke (smoke-solana-mainnet.ts) proves the facilitator REFUSES what
 * it should. It cannot prove the opposite, because it pays from an unfunded
 * account and stops at the balance check. This one closes that half: a real
 * signed payment, real SPL tokens moving, verified by reading the chain rather
 * than by believing the facilitator's response.
 *
 * WHAT MAKES THIS SAFE ENOUGH TO RUN
 * ---------------------------------
 *  - Refuses to move more than MAX_AMOUNT unless --force is passed.
 *  - Prints the exact plan and requires --yes before any request.
 *  - Preflight reads the chain and refuses unless the payer's delegation to the
 *    facilitator, the delegated remainder, and the balance all cover the amount,
 *    and the destination token account already exists (a missing destination is
 *    how the one historical failed settlement burned a fee for nothing).
 *  - Fails loudly if the facilitator answers with X-Settlement-Mode: simulated.
 *    A simulated settlement fabricates a hash, and this test exists precisely to
 *    prove a real one.
 *  - Verifies the outcome INDEPENDENTLY: it re-reads both token balances from
 *    the chain and requires exact deltas. The facilitator's own success:true is
 *    never treated as evidence.
 *  - Optionally returns the funds when SOLANA_MERCHANT_PRIVATE_KEY is set.
 *
 * The private keys are read from the environment and never printed.
 */

import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import readline from 'readline';

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SBC_MINT = process.env.SBC_TOKEN_ADDRESS || 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const DECIMALS = 9;

/** Refuse to move more than this without --force. 0.01 SBC. */
const MAX_AMOUNT = 10000000n;

const has = (f: string) => process.argv.includes(f);
function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function die(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}
const fmt = (raw: bigint) => `${(Number(raw) / 10 ** DECIMALS).toFixed(9)} SBC (${raw} base units)`;

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise(res => rl.question(question, a => { rl.close(); res(a); }));
  return answer.trim().toLowerCase() === 'yes';
}

/** Seconds to wait for the facilitator before giving up. */
const REQUEST_TIMEOUT_S = 45;

async function post(target: string, path: string, body: unknown) {
  // Without a deadline a facilitator stuck on a rate-limited RPC hangs this
  // script indefinitely, which makes it useless as a gate: it never reports.
  let res: Response;
  try {
    res = await fetch(`${target}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_S * 1000),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      die(`${path} did not answer within ${REQUEST_TIMEOUT_S}s. The facilitator is most likely stuck on ` +
          'its Solana RPC. Check SOLANA_RPC_URL on the server, and its log.');
    }
    die(`${path} request failed: ${e?.message ?? e}`);
  }
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _unparsed: text.slice(0, 400) }; }
  return { status: res.status, json, settlementMode: res.headers.get('x-settlement-mode') };
}

async function balanceOf(connection: Connection, ata: PublicKey): Promise<bigint> {
  const info = await connection.getTokenAccountBalance(ata).catch(() => null);
  return info ? BigInt(info.value.amount) : 0n;
}

async function main() {
  const target = arg('--target');
  if (!target) die('--target is required. There is no default: this moves real funds, so the destination must be stated explicitly.');

  const payerSecret = process.env.SOLANA_PAYER_PRIVATE_KEY;
  if (!payerSecret) die('SOLANA_PAYER_PRIVATE_KEY is not set (base58 secret key of the funded, delegated payer).');
  const merchantAddress = process.env.SOLANA_MERCHANT_ADDRESS;
  if (!merchantAddress) die('SOLANA_MERCHANT_ADDRESS is not set (base58 pubkey that receives the payment).');

  let payerKeypair: Keypair;
  try { payerKeypair = Keypair.fromSecretKey(bs58.decode(payerSecret)); }
  catch { die('SOLANA_PAYER_PRIVATE_KEY is not a valid base58 secret key.'); }

  const PAYER = payerKeypair.publicKey.toBase58();
  const amount = BigInt(arg('--amount', '1000000')!); // default 0.001 SBC
  if (amount <= 0n) die('--amount must be positive.');
  if (amount > MAX_AMOUNT && !has('--force')) {
    die(`--amount ${fmt(amount)} exceeds the ${fmt(MAX_AMOUNT)} ceiling. Pass --force if that is deliberate.`);
  }

  const connection = new Connection(RPC, 'confirmed');
  const mint = new PublicKey(SBC_MINT);
  const payerAta = await getAssociatedTokenAddress(mint, new PublicKey(PAYER));
  const merchantAta = await getAssociatedTokenAddress(mint, new PublicKey(merchantAddress));

  console.log('\nEnd-to-end Solana settlement (REAL FUNDS ON MAINNET)');
  console.log(`  facilitator : ${target}`);
  console.log(`  payer       : ${PAYER}`);
  console.log(`  payer ATA   : ${payerAta.toBase58()}`);
  console.log(`  merchant    : ${merchantAddress}`);
  console.log(`  merchant ATA: ${merchantAta.toBase58()}`);
  console.log(`  amount      : ${fmt(amount)}`);

  console.log('\n[1/6] Preflight — reading the chain');
  const payerInfo = await connection.getParsedAccountInfo(payerAta);
  const parsed: any = (payerInfo.value?.data as any)?.parsed?.info;
  if (!parsed) die(`payer token account ${payerAta.toBase58()} does not exist. Fund it with SBC first.`);

  const balance = BigInt(parsed.tokenAmount.amount);
  const delegate: string | undefined = parsed.delegate;
  const delegated = BigInt(parsed.delegatedAmount?.amount ?? '0');
  console.log(`  balance          : ${fmt(balance)}`);
  console.log(`  delegate         : ${delegate ?? '(none)'}`);
  console.log(`  delegated amount : ${fmt(delegated)}`);

  if (balance < amount) die(`payer balance ${fmt(balance)} is below the amount ${fmt(amount)}.`);
  if (!delegate) die('payer token account has no delegate. The facilitator cannot move these tokens.');
  if (delegated < amount) die(`delegated remainder ${fmt(delegated)} is below the amount ${fmt(amount)}.`);

  const merchantInfo = await connection.getAccountInfo(merchantAta);
  if (merchantInfo === null) {
    die(`merchant token account ${merchantAta.toBase58()} does not exist. Create it before settling — ` +
        'a transfer into a missing account fails on chain and burns the facilitator fee for nothing.');
  }
  const merchantBefore = await balanceOf(connection, merchantAta);
  console.log(`  merchant balance : ${fmt(merchantBefore)}`);
  console.log('  ok — delegation, balance and destination all check out');

  if (!has('--yes')) {
    const ok = await confirm(`\nMove ${fmt(amount)} from ${PAYER} to ${merchantAddress}? Type "yes": `);
    if (!ok) die('aborted by operator.');
  }

  console.log('\n[2/6] Signing the payment');
  const nonce = `live-smoke-${Date.now()}`;
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const message = `from:${PAYER}|to:${merchantAddress}|amount:${amount}|nonce:${nonce}|deadline:${deadline}`;
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(message), payerKeypair.secretKey));
  const payload = { from: PAYER, to: merchantAddress, amount: amount.toString(), nonce, deadline, signature };
  const requirements = { scheme: 'exact', network: SOLANA_MAINNET, amount: amount.toString(), payTo: merchantAddress, asset: SBC_MINT };
  const requestBody = {
    paymentPayload: { x402Version: 2, accepted: { scheme: 'exact', network: SOLANA_MAINNET }, payload, extensions: {} },
    paymentRequirements: requirements,
  };
  console.log(`  nonce ${nonce}, deadline ${new Date(deadline * 1000).toISOString()}`);

  console.log('\n[3/6] POST /verify');
  const verify = await post(target, '/verify', requestBody);
  console.log(`  isValid=${verify.json?.isValid} invalidReason=${verify.json?.invalidReason ?? '(none)'}`);
  if (verify.json?.isValid !== true) die(`/verify rejected a payment this test signed correctly: ${verify.json?.invalidReason}`);

  console.log('\n[4/6] POST /settle  (real on-chain transfer)');
  const settle = await post(target, '/settle', requestBody);
  console.log(`  success=${settle.json?.success} transaction=${settle.json?.transaction ?? '(none)'} errorReason=${settle.json?.errorReason ?? '(none)'}`);
  if (settle.settlementMode === 'simulated') {
    die('facilitator answered X-Settlement-Mode: simulated. That hash is fabricated and nothing moved. ' +
        'Set ENABLE_REAL_SETTLEMENT=true on the target and run again.');
  }
  if (settle.json?.success !== true) die(`settlement failed: ${settle.json?.errorReason}`);
  const txSignature: string = settle.json.transaction;
  if (!txSignature) die('settlement reported success with no transaction signature.');

  console.log('\n[5/6] Independent on-chain verification');
  console.log('  (reading balances from the chain — the facilitator own answer is not evidence)');
  let payerAfter = 0n, merchantAfter = 0n;
  for (let attempt = 1; attempt <= 10; attempt++) {
    payerAfter = await balanceOf(connection, payerAta);
    merchantAfter = await balanceOf(connection, merchantAta);
    if (merchantAfter - merchantBefore === amount) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  const payerDelta = balance - payerAfter;
  const merchantDelta = merchantAfter - merchantBefore;
  console.log(`  payer    ${fmt(balance)} -> ${fmt(payerAfter)}   (delta -${payerDelta})`);
  console.log(`  merchant ${fmt(merchantBefore)} -> ${fmt(merchantAfter)}   (delta +${merchantDelta})`);
  if (payerDelta !== amount) die(`payer balance moved by ${payerDelta}, expected ${amount}.`);
  if (merchantDelta !== amount) die(`merchant balance moved by ${merchantDelta}, expected ${amount}.`);

  const tx = await connection.getTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
  if (!tx) die(`transaction ${txSignature} not found on chain.`);
  if (tx.meta?.err) die(`transaction ${txSignature} landed but failed: ${JSON.stringify(tx.meta.err)}`);
  console.log(`  tx ${txSignature} confirmed in slot ${tx.slot}, no error`);

  console.log('\n[6/6] Replay is idempotent and moves nothing further');
  const replay = await post(target, '/settle', requestBody);
  console.log(`  success=${replay.json?.success} transaction=${replay.json?.transaction}`);
  if (replay.json?.transaction !== txSignature) {
    die(`replay returned a different transaction (${replay.json?.transaction}). The same signed payment settled twice.`);
  }
  const merchantAfterReplay = await balanceOf(connection, merchantAta);
  if (merchantAfterReplay !== merchantAfter) {
    die(`replay moved more tokens: merchant went ${merchantAfter} -> ${merchantAfterReplay}.`);
  }
  console.log('  ok — same signature returned, no further movement');

  const merchantSecret = process.env.SOLANA_MERCHANT_PRIVATE_KEY;
  if (merchantSecret) {
    console.log('\n[cleanup] returning the funds to the payer');
    const merchantKeypair = Keypair.fromSecretKey(bs58.decode(merchantSecret));
    const tx2 = new Transaction().add(
      createTransferInstruction(merchantAta, payerAta, merchantKeypair.publicKey, amount),
    );
    const sig = await sendAndConfirmTransaction(connection, tx2, [merchantKeypair], { commitment: 'confirmed' });
    console.log(`  returned ${fmt(amount)} — ${sig}`);
  } else {
    console.log(`\n[cleanup] SOLANA_MERCHANT_PRIVATE_KEY not set, so ${fmt(amount)} stays with the merchant.`);
  }

  console.log('\n' + '='.repeat(64));
  console.log('PASS — a real signed Solana payment settled on mainnet, verified on chain,');
  console.log('       and replaying it moved nothing further.');
}

main().catch(e => { console.error('\n✖ live settle smoke threw:', e?.message ?? e); process.exit(1); });
