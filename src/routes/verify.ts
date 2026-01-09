import { Request, Response } from 'express';
import { createPublicClient, http, verifyTypedData } from 'viem';
import { config } from '../config';
import { verifySolanaPayment } from '../solana/verify';

/**
 * Payment Verification Handler
 *
 * Verifies payment authorizations for multiple networks:
 *
 * - Solana: Ed25519 signature verification (handled by solana/verify.ts)
 * - Base: EIP-712 typed data signature verification
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

// EIP-712 Domain (used for Base payments only)
const getDomain = (verifyingContract: string, chainId: number) => ({
  name: 'SBC x402 Facilitator',
  version: '1',
  chainId,
  verifyingContract: verifyingContract as `0x${string}`,
});

// EIP-712 Types (used for Base payments only)
const types = {
  Payment: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export async function verifyPayment(req: Request, res: Response) {
  try {
    const { x402Version, paymentHeader, paymentRequirements } = req.body;

    console.log('\n🔍 Verifying payment...');

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
        payer: paymentData.payload?.from || 'unknown',
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
        payer: paymentData.payload?.from || 'unknown',
        invalidReason: `Unknown network: ${paymentData.network}`
      });
    }

    if (isBase) {
      console.log(isBaseSepolia ? '   🔵 Base Sepolia payment detected' : '   🔵 Base Mainnet payment detected');
    } else if (isRadius) {
      console.log(isRadiusTestnet ? '   🟢 Radius Testnet payment detected' : '   🟢 Radius Mainnet payment detected');
    }

    const { from, to, amount, nonce, deadline, signature } = paymentData.payload;

    console.log('   From:', from);
    console.log('   To:', to);
    console.log('   Amount:', amount);
    console.log('   Deadline:', new Date(deadline * 1000).toISOString());

    // Select chain config and RPC based on network
    let chain, chainId, rpcUrl, facilitatorAddress;
    if (isBaseSepolia) {
      chain = { ...baseMainnet, id: 84532, name: 'Base Sepolia', testnet: true };
      chainId = 84532;
      rpcUrl = 'https://sepolia.base.org';
      facilitatorAddress = config.baseFacilitatorAddress;
    } else if (isBaseMainnet) {
      chain = baseMainnet;
      chainId = config.baseChainId;
      rpcUrl = config.baseRpcUrl;
      facilitatorAddress = config.baseFacilitatorAddress;
    } else if (isRadiusTestnet) {
      if (!config.radiusRpcUrl) {
        throw new Error('RADIUS_RPC_URL is required for Radius Testnet. Set it in your .env file.');
      }
      if (!config.radiusFacilitatorAddress) {
        throw new Error('RADIUS_FACILITATOR_ADDRESS is required for Radius. Set it in your .env file.');
      }
      chain = { ...baseMainnet, id: 72344, name: 'Radius Testnet', network: 'radius-testnet', testnet: true };
      chainId = 72344;
      rpcUrl = config.radiusRpcUrl;
      facilitatorAddress = config.radiusFacilitatorAddress;
    } else if (isRadiusMainnet) {
      if (!config.radiusRpcUrl) {
        throw new Error('RADIUS_RPC_URL is required for Radius Mainnet. Set it in your .env file.');
      }
      if (!config.radiusFacilitatorAddress) {
        throw new Error('RADIUS_FACILITATOR_ADDRESS is required for Radius. Set it in your .env file.');
      }
      chain = { ...baseMainnet, id: 723, name: 'Radius', network: 'radius', testnet: false };
      chainId = 723;
      rpcUrl = config.radiusRpcUrl;
      facilitatorAddress = config.radiusFacilitatorAddress;
    } else {
      chain = baseMainnet;
      chainId = config.baseChainId;
      rpcUrl = config.baseRpcUrl;
      facilitatorAddress = config.baseFacilitatorAddress;
    }

    // 2. Verify EIP-712 signature
    // IMPORTANT: verifyingContract must be facilitator address (who verifies), not merchant (who receives)
    const domain = getDomain(facilitatorAddress, chainId);
    const message = { from, to, amount: BigInt(amount), nonce: BigInt(nonce), deadline: BigInt(deadline) };

    try {
      const isValidSig = await verifyTypedData({
        address: from as `0x${string}`,
        domain,
        types,
        primaryType: 'Payment',
        message,
        signature: signature as `0x${string}`,
      });

      if (!isValidSig) {
        console.log('   ❌ Invalid signature');
        return res.json({
          isValid: false,
          payer: from,
          invalidReason: 'Invalid signature'
        });
      }

      console.log('   ✅ Signature valid');
    } catch (error) {
      console.log('   ❌ Signature verification failed:', error);
      return res.json({
        isValid: false,
        payer: from,
        invalidReason: 'Signature verification failed'
      });
    }

    // 3. Check deadline
    const now = Math.floor(Date.now() / 1000);
    if (now > deadline) {
      console.log('   ❌ Payment expired');
      return res.json({
        isValid: false,
        payer: from,
        invalidReason: 'Payment expired'
      });
    }

    console.log('   ✅ Deadline valid');

    // 4. Check amount
    if (BigInt(amount) < BigInt(paymentRequirements.maxAmountRequired)) {
      console.log('   ❌ Insufficient amount');
      return res.json({
        isValid: false,
        payer: from,
        invalidReason: 'Insufficient amount'
      });
    }

    console.log('   ✅ Amount sufficient');

    // 5. Check recipient
    if (to.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      console.log('   ❌ Invalid recipient');
      return res.json({
        isValid: false,
        payer: from,
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

    // Use correct SBC token address for network
    let sbcTokenAddress: string;
    let decimals: number;
    if (isBaseSepolia) {
      sbcTokenAddress = '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16';  // Base Sepolia (6 decimals)
      decimals = 6;
    } else if (isBase) {
      sbcTokenAddress = config.baseSbcTokenAddress;  // Base Mainnet
      decimals = config.baseSbcDecimals;
    } else if (isRadius) {
      if (!config.radiusSbcTokenAddress) {
        throw new Error('RADIUS_SBC_TOKEN_ADDRESS is required for Radius. Set it in your .env file.');
      }
      sbcTokenAddress = config.radiusSbcTokenAddress;  // Radius
      decimals = config.radiusSbcDecimals;
    } else {
      sbcTokenAddress = config.baseSbcTokenAddress;
      decimals = config.baseSbcDecimals;
    }

    console.log('   SBC Token:', sbcTokenAddress);

    const balance = await publicClient.readContract({
      address: sbcTokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [from as `0x${string}`]
    });

    const balanceFormatted = Number(balance) / Math.pow(10, decimals);
    console.log(`   Sender SBC balance: ${balance.toString()} (${balanceFormatted} SBC)`);

    if (balance < BigInt(amount)) {
      console.log('   ❌ Insufficient balance');
      return res.json({
        isValid: false,
        payer: from,
        invalidReason: 'Insufficient balance'
      });
    }

    console.log('   ✅ Balance sufficient');

    // All checks passed
    console.log('✅ Payment verification successful!\n');
    res.json({
      isValid: true,
      payer: from,
      invalidReason: null
    });

  } catch (error: any) {
    console.error('❌ Verification error:', error);

    // Try to extract payer from request if possible
    let payer = 'unknown';
    try {
      const paymentData = JSON.parse(Buffer.from(req.body.paymentHeader, 'base64').toString());
      payer = paymentData.payload?.from || 'unknown';
    } catch {}

    res.status(500).json({
      isValid: false,
      payer,
      invalidReason: `Server error: ${error.message}`,
    });
  }
}
