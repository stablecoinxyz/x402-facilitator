import { createWalletClient, createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { getAccount, DATA_DIR } from './utils';
import fs from 'fs';
import path from 'path';

// Base Mainnet SBC Token Address (18 decimals)
const SBC_ADDRESS = '0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798';
// Minimal ABI for nonces()
const NONCES_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'nonces',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

async function runDemo() {
  console.log('🚀 Starting x402 Facilitator Demo Client (Base Mainnet)');
  console.log('========================================================');

  // 0. Load Configuration
  if (!fs.existsSync(path.join(DATA_DIR, 'client.key'))) {
      console.error('❌ Client wallet not found. Please run "npm run setup" first.');
      process.exit(1);
  }

  const client = getAccount('client');
  const merchant = getAccount('merchant');
  const facilitator = getAccount('facilitator');

  const port = 3001;
  const facilitatorUrl = `http://localhost:${port}`;

  console.log(`🔑 Client Wallet: ${client.address}`);
  console.log(`🏪 Merchant Wallet: ${merchant.address}`);
  console.log(`🤝 Facilitator: ${facilitator.address}`);

  // 1. Define payment details
  // SBC on Base Mainnet has 18 decimals.
  // 0.01 SBC = 10000000000000000 units
  const amount = '10000000000000000';
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600).toString(); // 1 hour from now

  // 2. Read on-chain nonce for ERC-2612 permit
  console.log('\n🔍 Reading on-chain permit nonce...');
  const publicClient = createPublicClient({
    chain: base,
    transport: http()
  });

  const nonce = await publicClient.readContract({
    address: SBC_ADDRESS,
    abi: NONCES_ABI,
    functionName: 'nonces',
    args: [client.address]
  });

  console.log(`   Nonce: ${nonce}`);

  // 3. Sign ERC-2612 Permit
  console.log('\n📝 Signing ERC-2612 Permit...');

  const domain = {
    name: 'Stable Coin',
    version: '1',
    chainId: 8453,
    verifyingContract: SBC_ADDRESS as `0x${string}`,
  } as const;

  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  } as const;

  const permitMessage = {
    owner: client.address,
    spender: facilitator.address,
    value: BigInt(amount),
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
  } as const;

  const clientWallet = createWalletClient({
    account: client,
    chain: base,
    transport: http()
  });

  const signature = await clientWallet.signTypedData({
    domain,
    types,
    primaryType: 'Permit',
    message: permitMessage
  });

  console.log(`   Signature: ${signature.substring(0, 10)}...`);

  // 4. Extract v, r, s from signature
  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(signature.slice(130, 132), 16);

  // 5. Create the x402 Header with ERC-2612 Permit payload
  const payload = {
    permit: {
      owner: client.address,
      spender: facilitator.address,
      value: amount,
      nonce: nonce.toString(),
      deadline,
    },
    recipient: merchant.address,
    signature,
    v,
    r,
    s,
  };

  const paymentHeader = Buffer.from(JSON.stringify({
    scheme: 'exact',
    network: 'base',
    payload
  })).toString('base64');

  const paymentRequirements = {
    maxAmountRequired: amount,
    payTo: merchant.address
  };

  // 6. Verify Payment
  console.log(`\n🔍 Sending VERIFICATION request to ${facilitatorUrl}/verify...`);

  try {
    const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: '1.0',
        paymentHeader,
        paymentRequirements
      })
    });

    const verifyResult = await verifyRes.json();
    console.log('   Response:', JSON.stringify(verifyResult, null, 2));

    if (!verifyResult.isValid) {
        console.error('❌ Verification failed. Aborting settlement.');
        console.error(`Reason: ${verifyResult.invalidReason}`);
        return;
    }
    console.log('   ✅ Verification Successful!');

    // 7. Settle Payment
    console.log(`\n💰 Sending SETTLEMENT request to ${facilitatorUrl}/settle...`);

    const settleRes = await fetch(`${facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: '1.0',
          paymentHeader,
          paymentRequirements
        })
      });

      const settleResult = await settleRes.json();
      console.log('   Response:', JSON.stringify(settleResult, null, 2));

      if (settleResult.success) {
          console.log('\n🎉 SUCCESS: Payment Settled!');
          console.log(`   Transaction Hash: ${settleResult.transaction}`);
          console.log(`   Explorer: https://basescan.org/tx/${settleResult.transaction}`);
      } else {
          console.log('\n❌ FAILURE: Settlement failed.');
          console.log(`   Reason: ${settleResult.errorReason}`);
      }

  } catch (error) {
    console.error('\n❌ Error connecting to facilitator:', error);
    console.log('   Is the server running? (npm run dev)');
  }
}

runDemo();
