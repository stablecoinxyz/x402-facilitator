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

// Base Mainnet Chain Config
const baseMainnet = {
  id: 8453,
  name: 'Base',
  network: 'base',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [config.baseRpcUrl],
    },
  },
  testnet: false,
};

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

    // Handle Base payments
    const isBaseSepolia = paymentData.network === 'base-sepolia' || paymentData.network === '84532';
    const isBaseMainnet = paymentData.network === 'base' || paymentData.network === '8453';
    const isBase = isBaseSepolia || isBaseMainnet;

    // Handle Radius payments
    const isRadiusTestnet = paymentData.network === 'radius-testnet' || paymentData.network === '72344';
    const isRadiusMainnet = paymentData.network === 'radius' || paymentData.network === '723';
    const isRadius = isRadiusTestnet || isRadiusMainnet;

    if (!isBase && !isRadius) {
      console.log('   ❌ Unknown payment network');
      return res.json({
        isValid: false,
        payer: paymentData.payload?.permit?.owner || 'unknown',
        invalidReason: `Unknown network: ${paymentData.network}`
      });
    }

    if (isBase) {
      console.log(isBaseSepolia ? '   🔵 Base Sepolia payment detected' : '   🔵 Base Mainnet payment detected');
    } else if (isRadius) {
      console.log(isRadiusTestnet ? '   🟢 Radius Testnet payment detected' : '   🟢 Radius Mainnet payment detected');
    }

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

    // Select chain config and RPC based on network
    let chain, chainId, rpcUrl, sbcTokenAddress: string, decimals: number;

    if (isBaseSepolia) {
      chain = { ...baseMainnet, id: 84532, name: 'Base Sepolia', testnet: true };
      chainId = 84532;
      rpcUrl = 'https://sepolia.base.org';
      sbcTokenAddress = '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16';
      decimals = 6;
    } else if (isBaseMainnet) {
      chain = baseMainnet;
      chainId = config.baseChainId;
      rpcUrl = config.baseRpcUrl;
      sbcTokenAddress = config.baseSbcTokenAddress;
      decimals = config.baseSbcDecimals;
    } else if (isRadiusTestnet) {
      if (!config.radiusRpcUrl || !config.radiusSbcTokenAddress) {
        throw new Error('RADIUS_RPC_URL and RADIUS_SBC_TOKEN_ADDRESS required for Radius');
      }
      chain = { ...baseMainnet, id: 72344, name: 'Radius Testnet', network: 'radius-testnet', testnet: true };
      chainId = 72344;
      rpcUrl = config.radiusRpcUrl;
      sbcTokenAddress = config.radiusSbcTokenAddress;
      decimals = config.radiusSbcDecimals;
    } else if (isRadiusMainnet) {
      if (!config.radiusRpcUrl || !config.radiusSbcTokenAddress) {
        throw new Error('RADIUS_RPC_URL and RADIUS_SBC_TOKEN_ADDRESS required for Radius');
      }
      chain = { ...baseMainnet, id: 723, name: 'Radius', network: 'radius', testnet: false };
      chainId = 723;
      rpcUrl = config.radiusRpcUrl;
      sbcTokenAddress = config.radiusSbcTokenAddress;
      decimals = config.radiusSbcDecimals;
    } else {
      chain = baseMainnet;
      chainId = config.baseChainId;
      rpcUrl = config.baseRpcUrl;
      sbcTokenAddress = config.baseSbcTokenAddress;
      decimals = config.baseSbcDecimals;
    }

    // 2. Verify ERC-2612 Permit signature
    // Domain is the TOKEN's domain, not facilitator
    // Token name from eip712Domain(): "Stable Coin" (not "SBC")
    const permitDomain = {
      name: 'Stable Coin',  // Actual token name from contract
      version: '1',
      chainId,
      verifyingContract: sbcTokenAddress as `0x${string}`,
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
      transport: http(rpcUrl),
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

    console.log('   SBC Token:', sbcTokenAddress);

    const balance = await publicClient.readContract({
      address: sbcTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`]
    });

    const balanceFormatted = Number(balance) / Math.pow(10, decimals);
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
