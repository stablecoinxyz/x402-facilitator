import { createWalletClient, http } from 'viem';
import { getAccount, getPublicClient, getNetwork, getViemChain, DATA_DIR } from './utils';
import fs from 'fs';
import path from 'path';

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
  const network = getNetwork();
  const publicClient = getPublicClient(network);
  const chain = getViemChain(network);

  console.log(`🚀 Starting x402 Facilitator Demo Client (${network.name}) — v2 Protocol`);
  console.log('========================================================');
  console.log(`🌐 Network: ${network.name} (CAIP-2: ${network.networkId})`);

  // 0. Load Configuration
  if (!fs.existsSync(path.join(DATA_DIR, 'client.key'))) {
      console.error('❌ Client wallet not found. Please run "npm run setup" first.');
      process.exit(1);
  }

  const client = getAccount('client');
  const merchant = getAccount('merchant');
  const facilitator = getAccount('facilitator');

  const port = parseInt(process.env.FACILITATOR_PORT || '3001');
  const facilitatorUrl = `http://localhost:${port}`;

  console.log(`🔑 Client Wallet: ${client.address}`);
  console.log(`🏪 Merchant Wallet: ${merchant.address}`);
  console.log(`🤝 Facilitator: ${facilitator.address}`);

  // 1. Define payment details
  // 0.01 SBC in the token's native decimals
  const amountUnits = BigInt(1) * BigInt(10) ** BigInt(network.sbcDecimals) / BigInt(100);
  const amount = amountUnits.toString();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600).toString(); // 1 hour from now

  console.log(`\n💰 Payment: 0.01 SBC (${amount} units, ${network.sbcDecimals} decimals)`);

  // 2. Read on-chain nonce for ERC-2612 permit
  console.log('\n🔍 Reading on-chain permit nonce...');

  const nonce = await publicClient.readContract({
    address: network.sbcAddress,
    abi: NONCES_ABI,
    functionName: 'nonces',
    args: [client.address]
  });

  console.log(`   Nonce: ${nonce}`);

  // 3. Sign ERC-2612 Permit
  console.log('\n📝 Signing ERC-2612 Permit...');

  const domain = {
    name: network.extra.name,
    version: network.extra.version,
    chainId: network.chainId,
    verifyingContract: network.sbcAddress,
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
    chain,
    transport: http(network.rpcUrl)
  });

  const signature = await clientWallet.signTypedData({
    domain,
    types,
    primaryType: 'Permit',
    message: permitMessage
  });

  console.log(`   Signature: ${signature.substring(0, 10)}...`);

  // 4. Build x402 v2 paymentPayload (JSON object, no base64)
  const resource = `${facilitatorUrl}/api/resource`;

  const paymentPayload = {
    x402Version: 2,
    resource,
    accepted: {
      scheme: 'exact',
      network: network.networkId,
    },
    payload: {
      signature,
      authorization: {
        from: client.address,
        to: facilitator.address,
        value: amount,
        validAfter: '0',
        validBefore: deadline,
        nonce: nonce.toString(),
      },
    },
    extensions: {},
  };

  const paymentRequirements = {
    scheme: 'exact',
    network: network.networkId,
    amount,
    asset: network.sbcAddress,
    payTo: merchant.address,
    maxTimeoutSeconds: 60,
    extra: network.extra,
  };

  // 5. Verify Payment
  console.log(`\n🔍 Sending VERIFICATION request to ${facilitatorUrl}/verify...`);

  try {
    const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentPayload,
        paymentRequirements,
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

    // 6. Settle Payment
    console.log(`\n💰 Sending SETTLEMENT request to ${facilitatorUrl}/settle...`);

    const settleRes = await fetch(`${facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements,
        })
      });

      const settleResult = await settleRes.json();
      console.log('   Response:', JSON.stringify(settleResult, null, 2));

      if (settleResult.success) {
          console.log('\n🎉 SUCCESS: Payment Settled!');
          console.log(`   Transaction Hash: ${settleResult.transaction}`);
          if (network.explorerTxUrl) {
            console.log(`   Explorer: ${network.explorerTxUrl}${settleResult.transaction}`);
          }
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
