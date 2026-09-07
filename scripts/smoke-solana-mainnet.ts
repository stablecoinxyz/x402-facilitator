/**
 * Live Solana settlement smoke test
 *
 *   npx tsx scripts/smoke-solana-mainnet.ts [--target https://x402.stablecoin.xyz]
 *
 * Drives the REAL production /settle endpoint over the network and checks that
 * the Solana path refuses a payment it was not authorized to make.
 *
 * WHY IT IS SAFE TO POINT AT MAINNET
 * ----------------------------------
 * Every probe pays FROM a keypair generated fresh in this process. That account
 * has never existed on chain: no SBC, no associated token account, and no SPL
 * delegation to the facilitator. There is no approval for the facilitator to
 * draw on, so no probe can move value even if every check failed at once. The
 * preflight asserts exactly that on chain before a single request is sent, and
 * refuses to continue otherwise.
 *
 * WHAT IT PROVES
 * --------------
 * Probes 1-4 are the gate: a payment that is unsigned, wrongly signed,
 * redirected to another recipient, or expired must be refused.
 *
 * Probe 5 is the NEGATIVE CONTROL and the reason this file is a test rather
 * than decoration. A service that refused every request would pass probes 1-4.
 * So probe 5 sends a CORRECTLY signed payment and requires that it be refused
 * for a funding reason rather than a signature one — proving the gate
 * discriminates instead of blanket-denying.
 *
 * EXPECTED RESULT BEFORE THE FIX SHIPS
 * ------------------------------------
 * Against a deployment that predates the Solana signature check, probes 1-4
 * FAIL, because that build accepts an unsigned payload and proceeds to attempt
 * the transfer. That failure is the point: the flip from red to green is the
 * evidence the new build actually deployed, not a dashboard saying so.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SBC_MINT = process.env.SBC_TOKEN_ADDRESS || 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA';
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TARGET = arg('--target', process.env.SMOKE_TARGET || 'https://x402.stablecoin.xyz');

/** A payer that exists only in this process. Nothing on chain has approved it. */
const payer = nacl.sign.keyPair();
const PAYER = bs58.encode(payer.publicKey);
/** A merchant the facilitator has never seen. */
const MERCHANT = bs58.encode(nacl.sign.keyPair().publicKey);

const AMOUNT = '50000000'; // 0.05 SBC at 9 decimals

function sign(fields: { from: string; to: string; amount: string; nonce: string; deadline: number }) {
  const message = `from:${fields.from}|to:${fields.to}|amount:${fields.amount}|nonce:${fields.nonce}|deadline:${fields.deadline}`;
  return bs58.encode(nacl.sign.detached(Buffer.from(message), payer.secretKey));
}

function body(payload: Record<string, unknown>, payTo: string) {
  return {
    paymentPayload: {
      x402Version: 2,
      accepted: { scheme: 'exact', network: SOLANA_MAINNET },
      payload,
      extensions: {},
    },
    paymentRequirements: {
      scheme: 'exact',
      network: SOLANA_MAINNET,
      amount: AMOUNT,
      payTo,
      asset: SBC_MINT,
    },
  };
}

async function settle(b: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${TARGET}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _unparsed: text.slice(0, 300) }; }
  return { status: res.status, json };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}\n         ${detail}`);
}

/**
 * Did the facilitator refuse the payment BEFORE touching the chain?
 *
 * `success:false` on its own proves nothing here. A build with no signature
 * check also answers `success:false` for these probes, because it attempts the
 * transfer and the chain rejects it — the payer has no token account. Both
 * builds therefore return "false" with an empty transaction, and an assertion
 * that stops there can never fail. (It didn't: an earlier version of this file
 * passed against the vulnerable deployment.)
 *
 * The discriminator is WHERE the refusal came from. A validated refusal cites a
 * spec reason and never reaches an RPC; an unvalidated one carries the chain's
 * own words back. So require the expected reason AND the absence of any
 * simulation/RPC text.
 */
function refusedBeforeChain(json: any, expectedReason: string): { ok: boolean; why: string } {
  if (json?.success !== false) return { ok: false, why: 'success was not false' };
  if (json?.transaction) return { ok: false, why: `carried a transaction: ${json.transaction}` };
  const reason = String(json?.errorReason ?? '');
  if (/simulation|Program log|compute units|SendTransactionError|blockhash/i.test(reason)) {
    return { ok: false, why: 'reached the chain — the response quotes simulation output, so nothing validated the payment first' };
  }
  if (reason !== expectedReason) {
    return { ok: false, why: `expected errorReason "${expectedReason}", got "${reason}"` };
  }
  return { ok: true, why: `errorReason=${reason}, no chain contact` };
}

async function main() {
  console.log(`\nLive Solana settlement smoke test`);
  console.log(`target : ${TARGET}`);
  console.log(`payer  : ${PAYER}  (generated this run, never funded)`);

  console.log('\n[preflight] proving the payer cannot move value');
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const ata = await getAssociatedTokenAddress(new PublicKey(SBC_MINT), new PublicKey(PAYER));
  const info = await connection.getAccountInfo(ata);
  if (info !== null) {
    console.error(`\n✖ refusing to run: payer token account ${ata.toBase58()} exists on chain.`);
    console.error('  This script must only ever pay from an account with no balance and no delegation.');
    process.exit(1);
  }
  console.log(`  ok    no token account at ${ata.toBase58()} — no balance, no delegation, nothing to draw on`);

  const future = Math.floor(Date.now() / 1000) + 300;

  console.log('\n[gate] payments the facilitator must refuse');

  // 1. A signature that is not a signature.
  {
    const p = { from: PAYER, to: MERCHANT, amount: AMOUNT, nonce: 'smoke-garbage', deadline: future,
                signature: bs58.encode(Buffer.alloc(64, 7)) };
    const { json } = await settle(body(p, MERCHANT));
    const r = refusedBeforeChain(json, 'invalid_exact_evm_payload_signature');
    record('garbage signature is refused before any chain call', r.ok, r.why);
  }

  // 2. No signature at all — the shape that made this a live vulnerability.
  {
    const p = { from: PAYER, to: MERCHANT, amount: AMOUNT, nonce: 'smoke-unsigned', deadline: future };
    const { json } = await settle(body(p, MERCHANT));
    const r = refusedBeforeChain(json, 'invalid_exact_evm_payload_signature');
    record('unsigned payload is refused before any chain call', r.ok, r.why);
  }

  // 3. Validly signed, but redirected to a recipient the merchant did not ask for.
  {
    const attacker = bs58.encode(nacl.sign.keyPair().publicKey);
    const nonce = 'smoke-redirect';
    const p = { from: PAYER, to: attacker, amount: AMOUNT, nonce, deadline: future,
                signature: sign({ from: PAYER, to: attacker, amount: AMOUNT, nonce, deadline: future }) };
    const { json } = await settle(body(p, MERCHANT)); // requirements say pay MERCHANT
    const r = refusedBeforeChain(json, 'invalid_exact_evm_payload_recipient_mismatch');
    record('signed payment to the wrong recipient is refused before any chain call', r.ok, r.why);
  }

  // 4. Validly signed, but expired.
  {
    const past = Math.floor(Date.now() / 1000) - 60;
    const nonce = 'smoke-expired';
    const p = { from: PAYER, to: MERCHANT, amount: AMOUNT, nonce, deadline: past,
                signature: sign({ from: PAYER, to: MERCHANT, amount: AMOUNT, nonce, deadline: past }) };
    const { json } = await settle(body(p, MERCHANT));
    const r = refusedBeforeChain(json, 'invalid_exact_evm_payload_authorization_valid_before');
    record('expired payment is refused before any chain call', r.ok, r.why);
  }

  // 5. NEGATIVE CONTROL. Correctly signed and correctly addressed, so it must
  //    get PAST the signature gate and be refused for funding instead. Without
  //    this, a service that refuses everything would score four out of four.
  console.log('\n[negative control] a correct signature must survive the gate');
  {
    const nonce = 'smoke-control';
    const p = { from: PAYER, to: MERCHANT, amount: AMOUNT, nonce, deadline: future,
                signature: sign({ from: PAYER, to: MERCHANT, amount: AMOUNT, nonce, deadline: future }) };
    const { json } = await settle(body(p, MERCHANT));
    const reason = String(json?.errorReason ?? '');
    const signatureShaped = /signature/i.test(reason);
    // Deliberately loose: this one passes on both builds, which is the point of
    // a control. It fails only if the gate starts rejecting valid signatures.
    record('a correctly signed payment is not refused as a bad signature',
           json?.success === false && !signatureShaped,
           `errorReason=${reason.slice(0, 90) || '(none)'} — must not be a signature reason`);
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(64));
  if (failed.length) {
    console.log(`FAIL — ${failed.map(f => f.name).join('; ')}`);
    console.log('\nIf this is running against a build that predates the Solana signature');
    console.log('check, probes 1-4 failing is the expected "before" reading.');
    process.exit(1);
  }
  console.log('PASS — the Solana settle path refuses what it should and discriminates.');
  console.log('Nothing moved: the payer has no token account, balance or delegation.');
}

main().catch(e => { console.error('\n✖ smoke test threw:', e?.message ?? e); process.exit(1); });
