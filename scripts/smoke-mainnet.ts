/**
 * Live mainnet smoke test — one real settlement, end to end.
 *
 * Drives the PRODUCTION facilitator against REAL Base mainnet and verifies the
 * outcome INDEPENDENTLY: it reads token balances directly from chain before and
 * after, and reads the transaction receipt itself. It never trusts the
 * facilitator's own success response, because that response is the thing under
 * test (see ~/.claude/rules/verify-integration-on-real-target.md).
 *
 * THIS MOVES REAL FUNDS. It is opt-in twice: --yes on the command line and a
 * non-zero payer balance. Default amount is 0.01 SBC.
 *
 *   PAYER_PRIVATE_KEY=0x... npx tsx scripts/smoke-mainnet.ts --pay-to 0x<merchant> --yes
 *
 * Flags:
 *   --pay-to <addr>   merchant address (required)
 *   --amount <dec>    human amount, default 0.01
 *   --facilitator <u> default https://x402.stablecoin.xyz
 *   --asset sbc|usdc  default sbc
 *   --rpc <url>       override the Base RPC endpoint (else $BASE_RPC_URL, else public)
 *   --yes             skip the confirmation prompt
 *
 * Exits non-zero on any failure so it can gate a deploy.
 */

import { createWalletClient, createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORKS, getViemChain } from '../demo/utils';
import readline from 'readline';

const ERC20 = [
  { name: 'nonces', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
  { name: 'DOMAIN_SEPARATOR', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view', type: 'function' },
] as const;

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (flag: string) => process.argv.includes(flag);

function die(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a.trim().toLowerCase() === 'yes'); }));
}

async function main() {
  const network = NETWORKS['base'];
  if (!network) die('base network missing from demo/utils.ts NETWORKS');
  if (network.chainId !== 8453) die(`expected Base mainnet chainId 8453, got ${network.chainId}`);

  const facilitatorUrl = (arg('--facilitator', 'https://x402.stablecoin.xyz') as string).replace(/\/$/, '');
  const payTo = arg('--pay-to');
  const assetKind = (arg('--asset', 'sbc') as string).toLowerCase();
  const humanAmount = arg('--amount', '0.01') as string;

  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) die('--pay-to <0xmerchant> is required');
  const pk = process.env.PAYER_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) die('PAYER_PRIVATE_KEY env var must be a 0x-prefixed 32-byte hex key');

  // Asset selection — SBC is the network default; USDC uses the mainnet Circle address.
  const asset = assetKind === 'usdc'
    ? { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const, decimals: 6, extra: { assetTransferMethod: 'erc2612', name: 'USD Coin', version: '2' } }
    : { address: network.sbcAddress as `0x${string}`, decimals: network.sbcDecimals, extra: network.extra };

  const payer = privateKeyToAccount(pk as `0x${string}`);
  const chain = getViemChain(network);
  // --rpc override: public Base endpoints are not uniformly reliable. During
  // development base-rpc.publicnode.com returned MISSING for USDC's
  // DOMAIN_SEPARATOR/version/nonces (wrong answers, not errors) and later 403'd
  // archive reads. Prefer a private endpoint for anything load bearing.
  const rpcUrl = arg('--rpc', process.env.BASE_RPC_URL || network.rpcUrl) as string;
  // Host only — a private endpoint carries its API key in the path or query.
  const rpcHost = (() => { try { return new URL(rpcUrl).host; } catch { return 'invalid-url'; } })();
  console.log(`  rpc         : ${rpcHost}`);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: payer, chain, transport: http(rpcUrl) });

  const value = parseUnits(humanAmount, asset.decimals);
  if (value <= 0n) die('--amount must be greater than zero');

  console.log('Live mainnet smoke test — THIS MOVES REAL FUNDS');
  console.log('='.repeat(60));
  console.log(`  facilitator : ${facilitatorUrl}`);
  console.log(`  network     : ${network.networkId} (chainId ${network.chainId})`);
  console.log(`  asset       : ${asset.extra.name} ${asset.address}`);
  console.log(`  payer       : ${payer.address}`);
  console.log(`  merchant    : ${payTo}`);
  console.log(`  amount      : ${humanAmount} (${value} units, ${asset.decimals} decimals)`);

  // ---- Preflight: fail before signing anything -------------------------------
  console.log('\n[1/6] Preflight');

  const sup = await fetch(`${facilitatorUrl}/supported`).then(r => r.json()).catch(() => die('facilitator /supported unreachable'));
  const kinds: any[] = sup?.kinds ?? [];
  const advertises = kinds.some(k => k.x402Version === 2 && k.network === network.networkId && k.extra?.name === asset.extra.name);
  if (!advertises) die(`facilitator does not advertise ${asset.extra.name} on ${network.networkId}`);
  const signers: string[] = sup?.signers?.['eip155:*'] ?? [];
  if (!signers.length) die('facilitator advertises no eip155 signer');
  const facilitatorAddr = signers[0] as `0x${string}`;
  console.log(`  facilitator signer   : ${facilitatorAddr}`);

  const [payerBal, merchantBal0, facGas, onchainName, domainSep] = await Promise.all([
    pub.readContract({ address: asset.address, abi: ERC20, functionName: 'balanceOf', args: [payer.address] }),
    pub.readContract({ address: asset.address, abi: ERC20, functionName: 'balanceOf', args: [payTo as `0x${string}`] }),
    pub.getBalance({ address: facilitatorAddr }),
    pub.readContract({ address: asset.address, abi: ERC20, functionName: 'name' }),
    pub.readContract({ address: asset.address, abi: ERC20, functionName: 'DOMAIN_SEPARATOR' }),
  ]);

  console.log(`  payer balance        : ${formatUnits(payerBal, asset.decimals)} ${onchainName}`);
  console.log(`  merchant balance     : ${formatUnits(merchantBal0, asset.decimals)} ${onchainName}`);
  console.log(`  facilitator gas      : ${formatUnits(facGas, 18)} ETH`);
  console.log(`  token DOMAIN_SEP     : ${domainSep}`);

  if (payerBal < value) die(`payer holds ${formatUnits(payerBal, asset.decimals)}, needs ${humanAmount}`);
  if (facGas === 0n) die('facilitator has zero ETH on Base — it cannot pay gas for the settlement');
  if (onchainName !== asset.extra.name) die(`token name() is ${JSON.stringify(onchainName)} but facilitator advertises ${JSON.stringify(asset.extra.name)} — EIP-712 domain will not match`);

  if (!has('--yes') && !(await confirm('\nType "yes" to send a REAL mainnet payment: '))) die('aborted by operator');

  // ---- Sign the permit -------------------------------------------------------
  console.log('\n[2/6] Signing ERC-2612 permit');
  const permitNonce = await pub.readContract({ address: asset.address, abi: ERC20, functionName: 'nonces', args: [payer.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min — well clear of the 30s safety margin

  const signature = await wallet.signTypedData({
    domain: { name: asset.extra.name, version: asset.extra.version, chainId: network.chainId, verifyingContract: asset.address },
    types: { Permit: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'Permit',
    message: { owner: payer.address, spender: facilitatorAddr, value, nonce: permitNonce, deadline },
  });
  console.log(`  permit nonce ${permitNonce}, deadline ${new Date(Number(deadline) * 1000).toISOString()}`);

  const paymentPayload = {
    x402Version: 2,
    resource: `${facilitatorUrl}/api/resource`,
    accepted: { scheme: 'exact', network: network.networkId },
    payload: { signature, authorization: {
      from: payer.address, to: facilitatorAddr, value: value.toString(),
      validAfter: '0', validBefore: deadline.toString(), nonce: permitNonce.toString(),
    } },
    extensions: {},
  };
  const paymentRequirements = {
    scheme: 'exact', network: network.networkId, amount: value.toString(),
    asset: asset.address, payTo, maxTimeoutSeconds: 60, extra: asset.extra,
  };

  const post = async (path: string) => {
    const r = await fetch(`${facilitatorUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });
    return { status: r.status, body: await r.json() as any };
  };

  // ---- Verify ----------------------------------------------------------------
  console.log('\n[3/6] POST /verify');
  const v = await post('/verify');
  console.log(`  ${v.status} ${JSON.stringify(v.body)}`);
  if (!v.body?.isValid) die(`verify rejected the payment: ${v.body?.invalidReason}`);

  // ---- Settle ----------------------------------------------------------------
  console.log('\n[4/6] POST /settle  (real on-chain transfer)');
  const s = await post('/settle');
  console.log(`  ${s.status} ${JSON.stringify(s.body)}`);
  if (!s.body?.success) die(`settle failed: ${s.body?.errorReason}`);
  const txHash = s.body.transaction as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) die(`settle reported success but returned no usable tx hash: ${txHash}`);

  // ---- Independent on-chain verification -------------------------------------
  // Everything below reads chain directly. The facilitator's response is not trusted.
  console.log('\n[5/6] Independent on-chain verification');
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  console.log(`  tx      : ${txHash}`);
  console.log(`  block   : ${receipt.blockNumber}`);
  console.log(`  status  : ${receipt.status}`);
  console.log(`  gasUsed : ${receipt.gasUsed}`);
  if (receipt.status !== 'success') die('transaction reverted on chain');

  // Primary proof: the ERC-20 Transfer event in this receipt. Authoritative and
  // immune to RPC lag, because it is carried by the receipt we already hold.
  //
  // A balance re-read is NOT sufficient on its own: public Base RPCs are load
  // balanced across nodes, and a read issued immediately after the receipt can
  // land on one that has not yet indexed the block. That produced a false
  // failure on the first real run (2026-08-26) — the payment had settled
  // correctly and the delta still read zero.
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const topicAddr = (t: string) => `0x${t.slice(26)}`.toLowerCase();
  const transfers = receipt.logs
    .filter(l => l.address.toLowerCase() === asset.address.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length >= 3)
    .map(l => ({ from: topicAddr(l.topics[1]!), to: topicAddr(l.topics[2]!), value: BigInt(l.data) }));

  const match = transfers.find(t =>
    t.from === payer.address.toLowerCase() &&
    t.to === payTo.toLowerCase() &&
    t.value === value);

  console.log(`  Transfer events in receipt: ${transfers.length}`);
  for (const t of transfers) console.log(`    ${t.from} -> ${t.to}  ${formatUnits(t.value, asset.decimals)}`);
  if (!match) die(`no Transfer event of ${humanAmount} from ${payer.address} to ${payTo} in the receipt`);
  console.log('  ✓ Transfer event matches payer, merchant and amount');

  // Corroboration only — the Transfer event above is the proof. This block can
  // never fail the run: public RPCs rate limit (429) and lag behind the block
  // they just gave us a receipt for, and neither means the payment failed.
  let confirmed = false;
  for (let attempt = 1; attempt <= 8 && !confirmed; attempt++) {
    try {
      const merchantBal1 = await pub.readContract({
        address: asset.address, abi: ERC20, functionName: 'balanceOf',
        args: [payTo as `0x${string}`], blockNumber: receipt.blockNumber,
      });
      const delta = merchantBal1 - merchantBal0;
      if (delta === value) {
        console.log(`  ✓ merchant balance delta +${formatUnits(delta, asset.decimals)} ${onchainName}`);
        confirmed = true;
      } else if (attempt === 8) {
        console.log(`  ~ balance read shows ${formatUnits(delta, asset.decimals)} after ${attempt} tries (RPC lag) — Transfer event already proved the payment`);
      }
    } catch (e: any) {
      if (attempt === 8) console.log(`  ~ balance read unavailable (${e?.shortMessage ?? e?.message}) — Transfer event already proved the payment`);
    }
    if (!confirmed) await new Promise(r => setTimeout(r, 2500));
  }

  // ---- Idempotency -----------------------------------------------------------
  console.log('\n[6/6] Replay is idempotent');
  const replay = await post('/settle');
  console.log(`  ${replay.status} ${JSON.stringify(replay.body)}`);
  if (!replay.body?.success) die(`replay returned failure instead of the original settlement: ${replay.body?.errorReason}`);
  if (replay.body.transaction !== txHash) die(`replay returned a different tx (${replay.body.transaction}) — the permit may have been settled twice`);

  console.log('\n' + '='.repeat(60));
  console.log('PASS — real mainnet settlement completed and verified on chain');
  console.log(`  ${humanAmount} ${onchainName}  ${payer.address} -> ${payTo}`);
  console.log(`  https://basescan.org/tx/${txHash}`);
}

main().catch(e => { console.error('\n✖ smoke test threw:', e?.message ?? e); process.exit(1); });
