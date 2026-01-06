import { createWalletClient, http, parseEther, defineChain, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { getAccount, loadOrGenerateKey, DATA_DIR } from './utils';
import fs from 'fs';
import path from 'path';

async function runDemo() {
  console.log('🚀 Starting x402 Facilitator Demo Client (Base Sepolia)');
  console.log('=====================================================');

  // 0. Load Configuration
  if (!fs.existsSync(path.join(DATA_DIR, 'client.key'))) {
      console.error('❌ Client wallet not found. Please run "npm run setup" first.');
      process.exit(1);
  }

  const client = getAccount('client');
  const merchant = getAccount('merchant');
  
  // Read .env to find port
  const port = 3001;
  const facilitatorUrl = `http://localhost:${port}`;

  console.log(`🔑 Client Wallet: ${client.address}`);
  console.log(`🏪 Merchant Wallet: ${merchant.address}`);

  // 1. Define payment details
  // SBC on Base Sepolia has 6 decimals.
  // We want to send 0.01 SBC = 10000 units
  const amount = '10000'; 
  const nonce = BigInt(Date.now()).toString();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600).toString(); // 1 hour from now

  // 2. Sign EIP-712 Message
  console.log('\n📝 Signing EIP-712 Payment...');

  const domain = {
    name: 'SBC x402 Facilitator',
    version: '1',
    chainId: 84532, // Base Sepolia
    verifyingContract: getAccount('facilitator').address, // Facilitator is the verifying contract in this model
  } as const;

  const types = {
    Payment: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  } as const;

  const message = {
    from: client.address,
    to: merchant.address,
    amount: BigInt(amount),
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
  } as const;

  // Sign with viem
  const clientWallet = createWalletClient({
    account: client,
    chain: baseSepolia,
    transport: http()
  });

  const signature = await clientWallet.signTypedData({
    domain,
    types,
    primaryType: 'Payment',
    message
  });
  
  console.log(`   Signature: ${signature.substring(0, 10)}...`);

  // 3. Create the x402 Header
  const payload = {
    from: client.address,
    to: merchant.address,
    amount,
    nonce,
    deadline,
    signature
  };

  const paymentHeader = Buffer.from(JSON.stringify({
    scheme: 'exact',
    network: 'base-sepolia',
    payload
  })).toString('base64');

  const paymentRequirements = {
    maxAmountRequired: amount,
    payTo: merchant.address
  };

  // 4. Verify Payment
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

    // 5. Settle Payment
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
          console.log(`   Explorer: https://sepolia.basescan.org/tx/${settleResult.transaction}`);
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
