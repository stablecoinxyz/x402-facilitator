/**
 * End-to-end proof for x402 Exact EVM with `assetTransferMethod: "eip3009"`.
 *
 * The payment is built and signed by the STOCK upstream client
 * (`@x402/evm` `ExactEvmScheme`), not by this repo, so the proof checks our
 * reading of the spec against upstream's rather than against itself. By default
 * the requirements carry NO `assetTransferMethod` — the spec default — which is
 * what a stock seller and client send.
 *
 *   1. client signs a TransferWithAuthorization for the requirements;
 *   2. POST /verify → isValid;
 *   3. POST /settle → success with a transaction hash;
 *   4. POST the SAME payload to /settle again → `invalid_exact_evm_nonce_already_used`,
 *      empty transaction (a used authorization is never answered as success);
 *   5. read the receipt and both balances back from chain: payer −amount, payTo +amount.
 *
 * Targets:
 *   - in-process routes (default): the facilitator's own /verify and /settle code,
 *     using the RPC and facilitator key from the normal env (BASE_RPC_URL, BASE_FACILITATOR_PRIVATE_KEY, ...).
 *     Point BASE_RPC_URL at an anvil fork of Base mainnet to prove against the real
 *     SBC contract with no real money; EIP3009_PROVE_FORK=1 then funds the payer
 *     (SBC via storage) and the facilitator (ETH) on the fork.
 *   - a deployed host: EIP3009_PROVE_BASE_URL=https://x402.stablecoin.xyz — the live smoke.
 *
 * Env:
 *   EIP3009_PROVE_PRIVATE_KEY   payer key (throwaway). Must hold the asset unless EIP3009_PROVE_FORK=1
 *   EIP3009_PROVE_NETWORK       CAIP-2, default eip155:8453
 *   EIP3009_PROVE_ASSET         token address, default the network's SBC
 *   EIP3009_PROVE_PAY_TO        recipient, default the facilitator's Base signer
 *   EIP3009_PROVE_AMOUNT        atomic units of the asset, default 10000
 *   EIP3009_PROVE_EXPLICIT=1    send assetTransferMethod: "eip3009" instead of omitting it
 */
import express from 'express';
import request from 'supertest';
import { createPublicClient, http, erc20Abi, keccak256, encodeAbiParameters, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { config, resolveToken } from '../src/config';
import { verifyPayment } from '../src/routes/verify';
import { settlePayment } from '../src/routes/settle';

const NETWORK = process.env.EIP3009_PROVE_NETWORK || 'eip155:8453';
const BASE_URL = process.env.EIP3009_PROVE_BASE_URL;
const FORK = process.env.EIP3009_PROVE_FORK === '1';
const EXPLICIT = process.env.EIP3009_PROVE_EXPLICIT === '1';
const DEFAULT_PAY_TO = '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6';
const PAY_TO = (process.env.EIP3009_PROVE_PAY_TO || DEFAULT_PAY_TO) as `0x${string}`;
const AMOUNT = BigInt(process.env.EIP3009_PROVE_AMOUNT || '10000');

/**
 * SBC `_balances` mapping slot (OpenZeppelin ERC20Upgradeable v4 layout). Measured on Base SBC
 * 2026-11-12 by matching a known holder's storage to its balanceOf. Fork funding only; the
 * script re-reads balanceOf and fails if it did not take.
 */
const SBC_BALANCES_SLOT = `0x${(51).toString(16).padStart(64, '0')}` as `0x${string}`;

function fail(message: string): never { console.error(`FAIL: ${message}`); process.exit(1); }

const NETWORKS: Record<string, { chainId: number; rpcUrl: string; defaultAsset: string }> = {
  'eip155:8453': { chainId: config.baseChainId, rpcUrl: config.baseRpcUrl, defaultAsset: config.baseSbcTokenAddress },
  'eip155:84532': { chainId: config.baseSepoliaChainId, rpcUrl: config.baseSepoliaRpcUrl, defaultAsset: config.baseSepoliaUsdcTokenAddress },
  'eip155:723487': { chainId: config.radiusChainId, rpcUrl: config.radiusRpcUrl, defaultAsset: config.radiusSbcTokenAddress },
  'eip155:72344': { chainId: config.radiusTestnetChainId, rpcUrl: config.radiusTestnetRpcUrl, defaultAsset: config.radiusTestnetSbcTokenAddress },
};

async function post(path: string, body: unknown): Promise<any> {
  if (BASE_URL) {
    const r = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }
  const app = express();
  app.use(express.json());
  app.post('/verify', verifyPayment);
  app.post('/settle', settlePayment);
  return (await request(app).post(path).send(body as object)).body;
}

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) fail(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function main() {
  const key = process.env.EIP3009_PROVE_PRIVATE_KEY;
  if (!key) fail('EIP3009_PROVE_PRIVATE_KEY is required');
  const net = NETWORKS[NETWORK] ?? fail(`unknown network ${NETWORK}`);
  const asset = (process.env.EIP3009_PROVE_ASSET || net.defaultAsset) as `0x${string}`;
  const token = resolveToken(net.chainId, asset) ?? fail(`asset ${asset} is not configured for ${NETWORK}`);
  if (!token.eip3009) fail(`${asset} on ${NETWORK} is Permit2-only in config`);
  if (FORK && BASE_URL) fail('EIP3009_PROVE_FORK funds a local fork; it cannot be combined with a deployed host');

  const payer = privateKeyToAccount(key as `0x${string}`);
  const client = createPublicClient({ transport: http(net.rpcUrl) }) as PublicClient;
  const chainId = await client.getChainId();
  if (chainId !== net.chainId) fail(`RPC reports chain ${chainId}, expected ${net.chainId}`);

  if (FORK) {
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [payer.address, SBC_BALANCES_SLOT]));
    await rpc(net.rpcUrl, 'anvil_setStorageAt', [asset, slot, `0x${(AMOUNT * 10n).toString(16).padStart(64, '0')}`]);
    const signer = privateKeyToAccount((config.baseFacilitatorPrivateKey || fail('BASE_FACILITATOR_PRIVATE_KEY is required for the fork')) as `0x${string}`);
    await rpc(net.rpcUrl, 'anvil_setBalance', [signer.address, '0x8ac7230489e80000']);
    const funded = await client.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] });
    if (funded !== AMOUNT * 10n) fail(`fork funding did not take (balance ${funded}); the token's balance slot is not 51`);
  }

  const requirements: any = {
    scheme: 'exact', network: NETWORK, amount: AMOUNT.toString(), asset, payTo: PAY_TO, maxTimeoutSeconds: 120,
    extra: EXPLICIT ? { assetTransferMethod: 'eip3009', name: token.name, version: token.version } : { name: token.name, version: token.version },
  };
  const scheme = new ExactEvmScheme(payer as any);
  const built: any = await scheme.createPaymentPayload(2, requirements);
  if (!built.payload?.authorization) fail(`stock client did not build an EIP-3009 payload: ${JSON.stringify(built)}`);
  const paymentPayload = { x402Version: 2, accepted: requirements, payload: built.payload };

  const bal = async (who: `0x${string}`) => client.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  const [payerBefore, payToBefore] = [await bal(payer.address), await bal(PAY_TO)];
  console.log(`network ${NETWORK} asset ${asset} (${token.name} v${token.version}) amount ${AMOUNT} method ${EXPLICIT ? 'eip3009 (explicit)' : '(absent → spec default)'}`);
  console.log(`target ${BASE_URL ?? 'in-process routes'} rpc-host ${new URL(net.rpcUrl).host}`);
  console.log(`payer ${payer.address} ${payerBefore} · payTo ${PAY_TO} ${payToBefore}`);

  const v = await post('/verify', { x402Version: 2, paymentPayload, paymentRequirements: requirements });
  console.log('verify', JSON.stringify(v));
  if (v.isValid !== true) fail('verify did not accept the stock client payment');

  const s = await post('/settle', { x402Version: 2, paymentPayload, paymentRequirements: requirements });
  console.log('settle', JSON.stringify(s));
  if (s.success !== true || !/^0x[0-9a-fA-F]{64}$/.test(s.transaction)) fail('settle did not succeed with a transaction hash');

  const replay = await post('/settle', { x402Version: 2, paymentPayload, paymentRequirements: requirements });
  console.log('replay', JSON.stringify(replay));
  if (replay.success !== false || replay.errorReason !== 'invalid_exact_evm_nonce_already_used' || replay.transaction !== '') fail('replay was not refused as an already-used authorization');

  const receipt = await client.getTransactionReceipt({ hash: s.transaction });
  if (receipt.status !== 'success') fail(`receipt status ${receipt.status}`);
  const [payerAfter, payToAfter] = [await bal(payer.address), await bal(PAY_TO)];
  console.log(`payer ${payerBefore} → ${payerAfter} · payTo ${payToBefore} → ${payToAfter} · block ${receipt.blockNumber} · tx ${s.transaction}`);
  if (payerBefore - payerAfter !== AMOUNT || payToAfter - payToBefore !== AMOUNT) fail('balances did not move by exactly the amount');
  console.log('PASS');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
