import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { loadOrGenerateKeypair, DATA_DIR } from './utils';
import fs from 'fs';
import path from 'path';

async function runDemo() {
  console.log('🚀 Starting x402 Facilitator Demo Client');
  console.log('========================================');

  // 0. Load Configuration
  if (!fs.existsSync(path.join(DATA_DIR, 'client.json'))) {
      console.error('❌ Client wallet not found. Please run "npm run setup" first.');
      process.exit(1);
  }

  const client = loadOrGenerateKeypair('client');
  const merchant = loadOrGenerateKeypair('merchant');
  
  // Read .env to find port (optional, defaults to 3001)
  const port = 3001;
  const facilitatorUrl = `http://localhost:${port}`;

  console.log(`🔑 Client Wallet: ${client.publicKey.toBase58()}`);
  console.log(`🏪 Merchant Wallet: ${merchant.publicKey.toBase58()}`);

  // 1. Define payment details
  const amount = '50000000'; // 0.05 SBC (9 decimals)
  const nonce = Date.now().toString();
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  // 2. Construct the message to sign
  const messageStr = `from:${client.publicKey.toBase58()}|to:${merchant.publicKey.toBase58()}|amount:${amount}|nonce:${nonce}|deadline:${deadline}`;
  const messageBytes = Buffer.from(messageStr);

  console.log('\n📝 Constructing Payment Payload:');
  console.log(`   Message: "${messageStr}"`);

  // 3. Sign the message
  const signatureBytes = nacl.sign.detached(messageBytes, client.secretKey);
  const signature = bs58.encode(signatureBytes);
  
  console.log(`   Signature: ${signature.substring(0, 10)}...`);

  // 4. Create the x402 Header
  const payload = {
    from: client.publicKey.toBase58(),
    to: merchant.publicKey.toBase58(),
    amount,
    nonce,
    deadline,
    signature
  };

  const paymentHeader = Buffer.from(JSON.stringify({
    scheme: 'exact',
    network: 'solana-mainnet-beta', // The code currently uses 'solana-mainnet-beta' string identifier even for devnet if RPC is devnet
    payload
  })).toString('base64');

  const paymentRequirements = {
    maxAmountRequired: amount,
    payTo: merchant.publicKey.toBase58()
  };

  // 5. Verify Payment
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
        return;
    }
    console.log('   ✅ Verification Successful!');

    // 6. Settle Payment
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
          console.log(`   Explorer: https://explorer.solana.com/tx/${settleResult.transaction}?cluster=devnet`);
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
