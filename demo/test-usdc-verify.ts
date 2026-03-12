/**
 * Test USDC + SBC permit verification + settlement against the local facilitator.
 *
 * Prerequisites:
 *   1. Facilitator running locally:  pnpm dev
 *   2. .env has facilitator keys for the network(s) you're testing
 *   3. PAYER_KEY wallet has USDC/SBC on the target network
 *
 * Usage:
 *   # Base Sepolia (default — testnet, safe)
 *   PAYER_KEY=0xYourKey npx tsx demo/test-usdc-verify.ts
 *
 *   # Base Mainnet (real money! amount = 0.0001 USDC = $0.0001)
 *   PAYER_KEY=0xYourKey NETWORK=mainnet npx tsx demo/test-usdc-verify.ts
 *
 *   # Verify only (skip settle)
 *   PAYER_KEY=0xYourKey VERIFY_ONLY=true npx tsx demo/test-usdc-verify.ts
 *
 * Token domains (verified on-chain):
 *   Base Mainnet USDC: name="USD Coin", version="2"
 *   Base Sepolia USDC: name="USDC", version="2"
 *   Base Mainnet SBC:  name="Stable Coin", version="1"
 *   Base Sepolia SBC:  name="Stable Coin", version="1"
 */

import { createPublicClient, http, formatUnits } from 'viem';
import { privateKeyToAccount, signTypedData } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3001';
const PAYER_KEY = process.env.PAYER_KEY;
const IS_MAINNET = process.env.NETWORK === 'mainnet';
const VERIFY_ONLY = process.env.VERIFY_ONLY === 'true';

if (!PAYER_KEY) {
  console.error('❌ Set PAYER_KEY env var to your test wallet private key');
  console.error('   PAYER_KEY=0x... npx tsx demo/test-usdc-verify.ts');
  process.exit(1);
}

// Network config
const NETWORKS = {
  mainnet: {
    chain: base,
    caip2: 'eip155:8453',
    rpcUrl: 'https://mainnet.base.org',
    usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, domainName: 'USD Coin', domainVersion: '2' },
    sbc: { address: '0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798', decimals: 18, domainName: 'Stable Coin', domainVersion: '1' },
    // 0.0001 USDC = 100 units (6 decimals). Tiny amount for safety.
    usdcAmount: 100n,
    // 0.0001 SBC = 100000000000000 units (18 decimals)
    sbcAmount: 100000000000000n,
  },
  sepolia: {
    chain: baseSepolia,
    caip2: 'eip155:84532',
    rpcUrl: 'https://sepolia.base.org',
    usdc: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, domainName: 'USDC', domainVersion: '2' },
    sbc: { address: '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16', decimals: 6, domainName: 'Stable Coin', domainVersion: '1' },
    // 0.01 on testnet — doesn't matter, it's fake
    usdcAmount: 10000n,
    sbcAmount: 10000n,
  },
} as const;

const net = IS_MAINNET ? NETWORKS.mainnet : NETWORKS.sepolia;

const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'nonces',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

interface TokenTestConfig {
  label: string;
  address: string;
  decimals: number;
  domainName: string;
  domainVersion: string;
  amount: bigint;
}

async function main() {
  const networkLabel = IS_MAINNET ? 'Base Mainnet' : 'Base Sepolia';
  console.log(`=== USDC + SBC Test — ${networkLabel} ===`);
  if (IS_MAINNET) console.log('⚠️  MAINNET MODE — real tokens will move if settlement is enabled');
  if (VERIFY_ONLY) console.log('ℹ️  VERIFY_ONLY — skipping /settle');
  console.log();

  const payerAccount = privateKeyToAccount(PAYER_KEY as `0x${string}`);
  console.log('Payer wallet:', payerAccount.address);
  console.log('Facilitator:', FACILITATOR_URL);

  // Check facilitator is running
  try {
    const health = await fetch(`${FACILITATOR_URL}/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
    console.log('Facilitator health: OK\n');
  } catch (err: any) {
    console.error(`❌ Facilitator not reachable at ${FACILITATOR_URL}`);
    console.error('   Start it first: pnpm dev');
    process.exit(1);
  }

  // Get facilitator signer address from /supported
  const supported = await fetch(`${FACILITATOR_URL}/supported`).then(r => r.json());
  const signerAddresses = supported.signers?.['eip155:*'] || [];
  if (signerAddresses.length === 0) {
    console.error('❌ No EVM signers configured in .env');
    process.exit(1);
  }
  const facilitatorAddress = signerAddresses[0];
  console.log('Facilitator signer:', facilitatorAddress);

  // Check /supported has the right kinds
  const usdcKind = supported.kinds?.find((k: any) => k.network === net.caip2 && k.extra?.name === net.usdc.domainName);
  const sbcKind = supported.kinds?.find((k: any) => k.network === net.caip2 && k.extra?.name === 'Stable Coin');
  console.log(`USDC kind in /supported (${net.caip2}):`, usdcKind ? '✅' : '❌ MISSING');
  console.log(`SBC kind in /supported (${net.caip2}):`, sbcKind ? '✅' : '❌ MISSING');
  console.log();

  const publicClient = createPublicClient({
    chain: net.chain,
    transport: http(net.rpcUrl),
  });

  const tokens: TokenTestConfig[] = [
    { label: 'USDC', ...net.usdc, amount: net.usdcAmount },
    { label: 'SBC', ...net.sbc, amount: net.sbcAmount },
  ];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Wait between tokens to avoid on-chain nonce conflicts
    if (i > 0) {
      console.log('\n⏳ Waiting 10s for on-chain nonce to clear...');
      await new Promise(r => setTimeout(r, 10000));
    }
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  ${token.label} on ${networkLabel}`);
    console.log(`${'='.repeat(50)}\n`);

    // Check balance
    const balance = await publicClient.readContract({
      address: token.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [payerAccount.address],
    });

    console.log(`${token.label} balance: ${formatUnits(balance, token.decimals)}`);

    if (balance === 0n) {
      console.log(`⚠️  No ${token.label} balance — skipping`);
      continue;
    }

    if (balance < token.amount) {
      console.log(`⚠️  Balance too low for test amount (${formatUnits(token.amount, token.decimals)}) — skipping`);
      continue;
    }

    // Get nonce
    const nonce = await publicClient.readContract({
      address: token.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'nonces',
      args: [payerAccount.address],
    });

    console.log(`Permit nonce: ${nonce}`);
    console.log(`Test amount: ${formatUnits(token.amount, token.decimals)} ${token.label}`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min

    console.log(`Signing permit (domain: "${token.domainName}" v${token.domainVersion})...`);

    const domain = {
      name: token.domainName,
      version: token.domainVersion,
      chainId: net.chain.id,
      verifyingContract: token.address as `0x${string}`,
    };

    const message = {
      owner: payerAccount.address,
      spender: facilitatorAddress as `0x${string}`,
      value: token.amount,
      nonce,
      deadline,
    };

    const signature = await signTypedData({
      privateKey: PAYER_KEY as `0x${string}`,
      domain,
      types: permitTypes,
      primaryType: 'Permit',
      message,
    });

    console.log(`Signature: ${signature.slice(0, 20)}...`);

    // Build x402 v2 payload
    const paymentPayload = {
      x402Version: 2,
      accepted: { scheme: 'exact', network: net.caip2 },
      payload: {
        signature,
        authorization: {
          from: payerAccount.address,
          to: facilitatorAddress,
          value: token.amount.toString(),
          validAfter: '0',
          validBefore: deadline.toString(),
          nonce: nonce.toString(),
        },
      },
    };

    const paymentRequirements = {
      scheme: 'exact',
      network: net.caip2,
      amount: token.amount.toString(),
      asset: token.address,
      payTo: payerAccount.address, // pay ourselves for testing
      maxTimeoutSeconds: 300,
      extra: {
        name: token.domainName,
        version: token.domainVersion,
      },
    };

    // Test /verify
    console.log(`\n--- POST /verify (${token.label}) ---`);
    try {
      const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
      });
      const verifyData = await verifyRes.json();
      if (verifyData.isValid) {
        console.log(`✅ Verify passed — payer: ${verifyData.payer}, remainingSeconds: ${verifyData.remainingSeconds}`);
      } else {
        console.log(`❌ Verify failed — reason: ${verifyData.invalidReason}`);
      }
    } catch (err: any) {
      console.log(`❌ Verify error: ${err.message}`);
    }

    // Test /settle
    if (VERIFY_ONLY) {
      console.log(`\n--- Skipping /settle (VERIFY_ONLY=true) ---`);
    } else {
      console.log(`\n--- POST /settle (${token.label}) ---`);
      try {
        const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentPayload, paymentRequirements }),
        });
        const settleData = await settleRes.json();
        if (settleData.success) {
          console.log(`✅ Settle succeeded — tx: ${settleData.transaction}`);
        } else {
          console.log(`❌ Settle failed — reason: ${settleData.errorReason}`);
        }
      } catch (err: any) {
        console.log(`❌ Settle error: ${err.message}`);
      }
    }
  }

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
