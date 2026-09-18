import { createWalletClient, http } from 'viem';
import { getAccount, getNetwork, getViemChain, DATA_DIR } from './utils';
import { randomBytes } from 'crypto';
import { PERMIT2_ADDRESS, X402_PERMIT2_PROXY, permit2WitnessTypes } from '../src/evm/permit2';
import fs from 'fs';
import path from 'path';

async function runDemo() {
  const network = getNetwork();
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

  const facilitatorUrl = process.env.FACILITATOR_URL
    || `http://localhost:${parseInt(process.env.FACILITATOR_PORT || '3001')}`;

  console.log(`🔑 Client Wallet: ${client.address}`);
  console.log(`🏪 Merchant Wallet: ${merchant.address}`);
  console.log(`🤝 Facilitator: ${facilitator.address}`);

  // 1. Define payment details
  // 0.01 SBC in the token's native decimals
  const amountUnits = BigInt(1) * BigInt(10) ** BigInt(network.sbcDecimals) / BigInt(100);
  const amount = amountUnits.toString();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600).toString(); // 1 hour from now

  console.log(`\n💰 Payment: 0.01 SBC (${amount} units, ${network.sbcDecimals} decimals)`);

  // 2. Permit2 SignatureTransfer nonces are unordered.  A fresh 256-bit nonce
  // lets the payer authorize this exact payment without a mutable local counter.
  const nonce = BigInt(`0x${randomBytes(32).toString('hex')}`);
  console.log(`\n🔍 Generated Permit2 nonce: ${nonce}`);

  // 3. Sign the official Permit2 witness.  The witness binds the merchant;
  // the canonical x402 proxy is the only allowed spender.
  console.log('\n📝 Signing Permit2 witness...');

  const domain = {
    name: 'Permit2',
    chainId: network.chainId,
    verifyingContract: PERMIT2_ADDRESS,
  } as const;

  const permit2Authorization = {
    permitted: { token: network.sbcAddress, amount },
    from: client.address,
    spender: X402_PERMIT2_PROXY,
    nonce: nonce.toString(),
    deadline: BigInt(deadline),
    witness: { to: merchant.address, validAfter: 0n },
  } as const;

  const clientWallet = createWalletClient({
    account: client,
    chain,
    transport: http(network.rpcUrl)
  });

  const signature = await clientWallet.signTypedData({
    domain,
    types: permit2WitnessTypes,
    primaryType: 'PermitWitnessTransferFrom',
    message: permit2Authorization
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
      amount,
      asset: network.sbcAddress,
      payTo: merchant.address,
      extra: network.extra,
    },
    payload: {
      signature,
      permit2Authorization: {
        ...permit2Authorization,
        deadline,
        witness: { to: merchant.address, validAfter: '0' },
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
    // Refuse to send a settlement request to a real or unknown server unless
    // the operator has deliberately opted into moving funds.
    const healthRes = await fetch(`${facilitatorUrl}/health`);
    const health = await healthRes.json() as { settlement?: string };
    if (!healthRes.ok || (health.settlement !== 'simulated' && process.env.DEMO_ALLOW_REAL_SETTLEMENT !== 'true')) {
      console.error('\n❌ Refusing to settle: the facilitator is not in simulated demo mode.');
      console.error('   Set ALLOW_SIMULATED_SETTLEMENT=true on the server, or explicitly set DEMO_ALLOW_REAL_SETTLEMENT=true to allow a real transfer.');
      return;
    }

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
          if (settleRes.headers.get('x-settlement-mode') === 'simulated') {
            console.log('\n🎬 SIMULATED PAYMENT — no funds moved');
            console.log(`   Demo reference: ${settleResult.transaction}`);
          } else {
            console.log('\n🎉 SUCCESS: Payment Settled!');
            console.log(`   Transaction Hash: ${settleResult.transaction}`);
            if (network.explorerTxUrl) {
              console.log(`   Explorer: ${network.explorerTxUrl}${settleResult.transaction}`);
            }
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
