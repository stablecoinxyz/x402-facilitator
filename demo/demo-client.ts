import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

async function runDemo() {
  console.log('🚀 Starting x402 Facilitator Demo Client');
  console.log('========================================');

  // 1. Generate a fresh keypair (Simulating a client wallet)
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  
  console.log(`🔑 Generated Client Wallet: ${publicKey}`);
  console.log('   (Note: This wallet has 0 SOL and 0 SBC, so balance checks will fail)');

  // 2. Define payment details
  const facilitatorUrl = 'http://localhost:3001';
  const merchantAddress = 'Bimv2kMQnQoJjG7z2XkYQn7Qx6F7sR9uD4j8c3x5b8k7'; // Example address
  const amount = '50000000'; // 0.05 SBC (9 decimals)
  const nonce = Date.now().toString();
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  // 3. Construct the message to sign
  // Format must match server: "from:{from}|to:{to}|amount:{amount}|nonce:{nonce}|deadline:{deadline}"
  const messageStr = `from:${publicKey}|to:${merchantAddress}|amount:${amount}|nonce:${nonce}|deadline:${deadline}`;
  const messageBytes = Buffer.from(messageStr);

  console.log('\n📝 Constructing Payment Payload:');
  console.log(`   Message: "${messageStr}"`);

  // 4. Sign the message
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signature = bs58.encode(signatureBytes);
  
  console.log(`   Signature: ${signature.substring(0, 10)}...`);

  // 5. Create the x402 Header
  const payload = {
    from: publicKey,
    to: merchantAddress,
    amount,
    nonce,
    deadline,
    signature
  };

  const paymentHeader = Buffer.from(JSON.stringify({
    scheme: 'exact',
    network: 'solana-mainnet-beta',
    payload
  })).toString('base64');

  // 6. Define Requirements (what the merchant expects)
  const paymentRequirements = {
    maxAmountRequired: amount,
    payTo: merchantAddress
  };

  // 7. Send to Facilitator
  console.log(`\nmw Sending verification request to ${facilitatorUrl}/verify...`);
  
  try {
    const response = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: '1.0',
        paymentHeader,
        paymentRequirements
      })
    });

    const result = await response.json();
    
    console.log('\n✅ Response received:');
    console.log(JSON.stringify(result, null, 2));

    if (result.isValid) {
      console.log('\n🎉 SUCCESS: Payment is valid!');
    } else {
      console.log('\n❌ FAILURE (Expected): Payment is invalid.');
      console.log(`   Reason: ${result.invalidReason}`);
      
      if (result.invalidReason.includes('balance') || result.invalidReason.includes('account')) {
        console.log('   (This is expected because the generated wallet is empty)');
      }
    }

  } catch (error) {
    console.error('\n❌ Error connecting to facilitator:', error);
    console.log('   Is the server running? (npm run dev)');
  }
}

runDemo();
