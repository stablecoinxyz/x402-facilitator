/**
 * Sweep test funds from a merchant wallet back to origin.
 *
 * scripts/smoke-mainnet.ts now returns funds automatically, so this exists for
 * the case that motivated it: residue from earlier runs that had no recovery
 * path, or from a run interrupted before its final stage.
 *
 * The merchant holds no gas of its own, so this tops it up from the origin
 * wallet first, then transfers each token's full balance back.
 *
 *   PAYER_PRIVATE_KEY=0x... MERCHANT_PRIVATE_KEY=0x... \
 *     npx tsx scripts/recover-to-origin.ts --from-merchant 0x<merchant> [--dry-run]
 *
 * Exits non-zero if a transfer fails or a balance does not move.
 */

import { createWalletClient, createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORKS, getViemChain } from '../demo/utils';

const ERC20 = [
  { name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
  { name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
] as const;

const arg = (f: string, d?: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const has = (f: string) => process.argv.includes(f);
function die(m: string): never { console.error(`\n✖ ${m}`); process.exit(1); }

async function main() {
  const network = NETWORKS['base'];
  const chain = getViemChain(network);
  const rpcUrl = arg('--rpc', process.env.BASE_RPC_URL || network.rpcUrl) as string;
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  const payerPk = process.env.PAYER_PRIVATE_KEY;
  const merchantPk = process.env.MERCHANT_PRIVATE_KEY;
  if (!payerPk || !/^0x[0-9a-fA-F]{64}$/.test(payerPk)) die('PAYER_PRIVATE_KEY (the origin wallet) must be set');
  if (!merchantPk || !/^0x[0-9a-fA-F]{64}$/.test(merchantPk)) die('MERCHANT_PRIVATE_KEY must be set');

  const payer = privateKeyToAccount(payerPk as `0x${string}`);
  const merchant = privateKeyToAccount(merchantPk as `0x${string}`);
  const expected = arg('--from-merchant');
  if (expected && expected.toLowerCase() !== merchant.address.toLowerCase()) {
    die(`MERCHANT_PRIVATE_KEY is ${merchant.address}, not --from-merchant ${expected}`);
  }

  const payerWallet = createWalletClient({ account: payer, chain, transport: http(rpcUrl) });
  const merchantWallet = createWalletClient({ account: merchant, chain, transport: http(rpcUrl) });

  const TOKENS = [
    { address: network.sbcAddress as `0x${string}`, decimals: network.sbcDecimals },
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`, decimals: 6 },
  ];

  console.log(`Recover test funds to origin  (${has('--dry-run') ? 'DRY RUN' : 'LIVE'})`);
  console.log(`  from merchant : ${merchant.address}`);
  console.log(`  to origin     : ${payer.address}\n`);

  const pending: Array<{ address: `0x${string}`; decimals: number; bal: bigint; symbol: string }> = [];
  for (const t of TOKENS) {
    const [bal, symbol] = await Promise.all([
      pub.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [merchant.address] }),
      pub.readContract({ address: t.address, abi: ERC20, functionName: 'symbol' }),
    ]);
    console.log(`  ${symbol.padEnd(6)} ${formatUnits(bal, t.decimals)}`);
    if (bal > 0n) pending.push({ ...t, bal, symbol });
  }

  if (!pending.length) { console.log('\nNothing to recover.'); return; }
  if (has('--dry-run')) { console.log('\nDry run — no transactions sent.'); return; }

  // Merchant pays its own gas, so it needs a float first.
  const needed = parseUnits('0.00002', 18) * BigInt(pending.length);
  const gas = await pub.getBalance({ address: merchant.address });
  if (gas < needed) {
    const topUp = needed - gas;
    console.log(`\n  topping up merchant gas by ${formatUnits(topUp, 18)} ETH`);
    const h = await payerWallet.sendTransaction({ to: merchant.address, value: topUp });
    await pub.waitForTransactionReceipt({ hash: h, confirmations: 1 });
    console.log(`  ${h}`);
  }

  for (const t of pending) {
    const h = await merchantWallet.writeContract({ address: t.address, abi: ERC20, functionName: 'transfer', args: [payer.address, t.bal] });
    const r = await pub.waitForTransactionReceipt({ hash: h, confirmations: 1 });
    if (r.status !== 'success') die(`${t.symbol} transfer reverted: ${h}`);
    // Confirm from the receipt's Transfer event — authoritative and needs no
    // second read. Public Base RPCs are not reliably archive: pinning a read to
    // a just-mined block returns "Requested resource not found" on some nodes.
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const moved = r.logs.some(l =>
      l.address.toLowerCase() === t.address.toLowerCase() &&
      l.topics[0] === TRANSFER_TOPIC &&
      `0x${l.topics[2]?.slice(26)}`.toLowerCase() === payer.address.toLowerCase() &&
      BigInt(l.data) === t.bal);
    if (!moved) die(`${t.symbol}: no Transfer of ${formatUnits(t.bal, t.decimals)} to ${payer.address} in receipt ${h}`);
    console.log(`  recovered ${formatUnits(t.bal, t.decimals)} ${t.symbol}  tx ${h}`);
  }

  console.log('\nDone — all test funds returned to origin.');
}

main().catch(e => { console.error('\n✖', e?.shortMessage ?? e?.message ?? e); process.exit(1); });
