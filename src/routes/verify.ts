import { Request, Response } from 'express';
import { createPublicClient, http, verifyTypedData } from 'viem';
import { config } from '../config';
import { verifySolanaPayment } from '../solana/verify';

/**
 * Payment Verification Handler - x402 V2 with ERC-2612 Permit
 *
 * Verifies payment authorizations for multiple networks:
 *
 * - Solana: Ed25519 signature verification (handled by solana/verify.ts)
 * - Base/Radius: ERC-2612 Permit signature verification
 */

// ERC-2612 Permit EIP-712 Types
const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/** Resolve network string to chain config from environment */
function resolveEvmNetwork(network: string) {
  const isBaseSepolia = network === 'base-sepolia' || network === '84532';
  const isBaseMainnet = network === 'base' || network === '8453';
  const isRadiusTestnet = network === 'radius-testnet' || network === '72344';
  const isRadiusMainnet = network === 'radius' || network === '723';

  if (isBaseMainnet) {
    return {
      label: 'Base Mainnet',
      emoji: '🔵',
      chainId: config.baseChainId,
      rpcUrl: config.baseRpcUrl,
      sbcTokenAddress: config.baseSbcTokenAddress,
      decimals: config.baseSbcDecimals,
    };
  }
  if (isBaseSepolia) {
    return {
      label: 'Base Sepolia',
      emoji: '🔵',
      chainId: config.baseSepoliaChainId,
      rpcUrl: config.baseSepoliaRpcUrl,
      sbcTokenAddress: config.baseSepoliaSbcTokenAddress,
      decimals: config.baseSepoliaSbcDecimals,
    };
  }
  if (isRadiusMainnet) {
    return {
      label: 'Radius Mainnet',
      emoji: '🟢',
      chainId: config.radiusChainId,
      rpcUrl: config.radiusRpcUrl,
      sbcTokenAddress: config.radiusSbcTokenAddress,
      decimals: config.radiusSbcDecimals,
    };
  }
  if (isRadiusTestnet) {
    return {
      label: 'Radius Testnet',
      emoji: '🟢',
      chainId: config.radiusTestnetChainId,
      rpcUrl: config.radiusTestnetRpcUrl,
      sbcTokenAddress: config.radiusTestnetSbcTokenAddress,
      decimals: config.radiusTestnetSbcDecimals,
    };
  }
  return null;
}

export async function verifyPayment(req: Request, res: Response) {
  try {
    const { x402Version, paymentHeader, paymentRequirements } = req.body;

    console.log('\n🔍 Verifying payment (x402 V2 Permit)...');

    // 1. Decode payment header (Base64)
    const paymentData = JSON.parse(
      Buffer.from(paymentHeader, 'base64').toString()
    );

    console.log('   Scheme:', paymentData.scheme);
    console.log('   Network:', paymentData.network);

    // Verify scheme is "exact"
    if (paymentData.scheme !== 'exact') {
      console.log('   ❌ Unsupported payment scheme');
      return res.json({
        isValid: false,
        payer: paymentData.payload?.permit?.owner || 'unknown',
        invalidReason: `Unsupported scheme: ${paymentData.scheme}`
      });
    }

    // Route by network
    if (paymentData.network === 'solana-mainnet-beta') {
      console.log('   🟣 Solana payment detected');
      const result = await verifySolanaPayment(paymentData.payload, paymentRequirements);
      console.log(result.isValid ? '✅ Payment verification successful!\n' : '❌ Payment verification failed!\n');
      return res.json(result);
    }

    // Resolve EVM network
    const networkConfig = resolveEvmNetwork(paymentData.network);
    if (!networkConfig) {
      console.log('   ❌ Unknown payment network');
      return res.json({
        isValid: false,
        payer: paymentData.payload?.permit?.owner || 'unknown',
        invalidReason: `Unknown network: ${paymentData.network}`
      });
    }

    console.log(`   ${networkConfig.emoji} ${networkConfig.label} payment detected`);

    // Extract permit data
    const { permit, recipient, signature, v, r, s } = paymentData.payload;

    if (!permit) {
      console.log('   ❌ Missing permit data');
      return res.json({
        isValid: false,
        payer: 'unknown',
        invalidReason: 'Missing permit data in payload'
      });
    }

    const { owner, spender, value, nonce, deadline } = permit;

    console.log('   Owner (Payer):', owner);
    console.log('   Spender (Facilitator):', spender);
    console.log('   Recipient (Merchant):', recipient);
    console.log('   Value:', value);
    console.log('   Deadline:', new Date(Number(deadline) * 1000).toISOString());

    // Build chain object for viem
    const chain = {
      id: networkConfig.chainId,
      name: networkConfig.label,
      network: paymentData.network,
      nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
      rpcUrls: { default: { http: [networkConfig.rpcUrl] } },
      testnet: networkConfig.label.includes('Sepolia') || networkConfig.label.includes('Testnet'),
    };

    // 2. Verify ERC-2612 Permit signature
    const permitDomain = {
      name: 'Stable Coin',
      version: '1',
      chainId: networkConfig.chainId,
      verifyingContract: networkConfig.sbcTokenAddress as `0x${string}`,
    };

    const permitMessage = {
      owner: owner as `0x${string}`,
      spender: spender as `0x${string}`,
      value: BigInt(value),
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    };

    try {
      const isValidSig = await verifyTypedData({
        address: owner as `0x${string}`,
        domain: permitDomain,
        types: permitTypes,
        primaryType: 'Permit',
        message: permitMessage,
        signature: signature as `0x${string}`,
      });

      if (!isValidSig) {
        console.log('   ❌ Invalid permit signature');
        return res.json({
          isValid: false,
          payer: owner,
          invalidReason: 'Invalid permit signature'
        });
      }

      console.log('   ✅ Permit signature valid');
    } catch (error) {
      console.log('   ❌ Permit signature verification failed:', error);
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'Permit signature verification failed'
      });
    }

    // 3. Check deadline
    const now = Math.floor(Date.now() / 1000);
    if (now > Number(deadline)) {
      console.log('   ❌ Permit expired');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'Permit expired'
      });
    }

    console.log('   ✅ Deadline valid');

    // 4. Check amount
    if (BigInt(value) < BigInt(paymentRequirements.maxAmountRequired)) {
      console.log('   ❌ Insufficient amount');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'Insufficient amount'
      });
    }

    console.log('   ✅ Amount sufficient');

    // 5. Check recipient
    if (recipient.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      console.log('   ❌ Invalid recipient');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'Invalid recipient'
      });
    }

    console.log('   ✅ Recipient valid');

    // 6. Check on-chain ERC-20 token balance
    const publicClient = createPublicClient({
      chain,
      transport: http(networkConfig.rpcUrl),
    });

    const ERC20_ABI = [
      {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function'
      }
    ] as const;

    console.log('   SBC Token:', networkConfig.sbcTokenAddress);

    const balance = await publicClient.readContract({
      address: networkConfig.sbcTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`]
    });

    const balanceFormatted = Number(balance) / Math.pow(10, networkConfig.decimals);
    console.log(`   Sender SBC balance: ${balance.toString()} (${balanceFormatted} SBC)`);

    if (balance < BigInt(value)) {
      console.log('   ❌ Insufficient balance');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'Insufficient balance'
      });
    }

    console.log('   ✅ Balance sufficient');

    // All checks passed
    console.log('✅ Payment verification successful!\n');
    res.json({
      isValid: true,
      payer: owner,
      invalidReason: null
    });

  } catch (error: any) {
    console.error('❌ Verification error:', error);

    // Try to extract payer from request if possible
    let payer = 'unknown';
    try {
      const paymentData = JSON.parse(Buffer.from(req.body.paymentHeader, 'base64').toString());
      payer = paymentData.payload?.permit?.owner || 'unknown';
    } catch {}

    res.status(500).json({
      isValid: false,
      payer,
      invalidReason: `Server error: ${error.message}`,
    });
  }
}
