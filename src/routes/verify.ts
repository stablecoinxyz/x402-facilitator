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

/** Parse CAIP-2 network identifier to extract chain ID, e.g. "eip155:8453" → 8453 */
function parseEvmChainId(network: string): number | null {
  const match = network.match(/^eip155:(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Resolve CAIP-2 network string to chain config from environment */
function resolveEvmNetwork(network: string) {
  const chainId = parseEvmChainId(network);
  if (chainId === null) return null;

  if (chainId === config.baseChainId) {
    return {
      label: 'Base Mainnet',
      emoji: '🔵',
      chainId: config.baseChainId,
      rpcUrl: config.baseRpcUrl,
      sbcTokenAddress: config.baseSbcTokenAddress,
      decimals: config.baseSbcDecimals,
    };
  }
  if (chainId === config.baseSepoliaChainId) {
    return {
      label: 'Base Sepolia',
      emoji: '🔵',
      chainId: config.baseSepoliaChainId,
      rpcUrl: config.baseSepoliaRpcUrl,
      sbcTokenAddress: config.baseSepoliaSbcTokenAddress,
      decimals: config.baseSepoliaSbcDecimals,
    };
  }
  if (chainId === config.radiusChainId) {
    return {
      label: 'Radius Mainnet',
      emoji: '🟢',
      chainId: config.radiusChainId,
      rpcUrl: config.radiusRpcUrl,
      sbcTokenAddress: config.radiusSbcTokenAddress,
      decimals: config.radiusSbcDecimals,
    };
  }
  if (chainId === config.radiusTestnetChainId) {
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
    const { paymentPayload, paymentRequirements } = req.body;

    console.log('\n🔍 Verifying payment (x402 V2)...');

    if (!paymentPayload) {
      return res.status(500).json({
        isValid: false,
        payer: 'unknown',
        invalidReason: 'Missing paymentPayload',
      });
    }

    const network = paymentPayload.accepted?.network;
    const scheme = paymentPayload.accepted?.scheme;

    console.log('   Scheme:', scheme);
    console.log('   Network:', network);

    // Verify scheme is "exact"
    if (scheme !== 'exact') {
      console.log('   ❌ Unsupported payment scheme');
      return res.json({
        isValid: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        invalidReason: `Unsupported scheme: ${scheme}`
      });
    }

    // Route by network — Solana uses CAIP-2 "solana:..." prefix
    if (network?.startsWith('solana:')) {
      console.log('   🟣 Solana payment detected');
      const result = await verifySolanaPayment(paymentPayload.payload, paymentRequirements);
      console.log(result.isValid ? '✅ Payment verification successful!\n' : '❌ Payment verification failed!\n');
      return res.json(result);
    }

    // Resolve EVM network from CAIP-2 identifier
    const networkConfig = resolveEvmNetwork(network);
    if (!networkConfig) {
      console.log('   ❌ Unknown payment network');
      return res.json({
        isValid: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        invalidReason: `Unknown network: ${network}`
      });
    }

    console.log(`   ${networkConfig.emoji} ${networkConfig.label} payment detected`);

    // Extract v2 authorization data
    const { authorization, signature } = paymentPayload.payload || {};

    if (!authorization) {
      console.log('   ❌ Missing authorization data');
      return res.json({
        isValid: false,
        payer: 'unknown',
        invalidReason: 'Missing authorization data in payload'
      });
    }

    const owner = authorization.from;
    const spender = authorization.to;
    const value = authorization.value;
    const deadline = authorization.validBefore;
    const nonce = authorization.nonce;
    const recipient = paymentRequirements.payTo;

    console.log('   Owner (Payer):', owner);
    console.log('   Spender (Facilitator):', spender);
    console.log('   Recipient (Merchant):', recipient);
    console.log('   Value:', value);
    console.log('   Deadline:', new Date(Number(deadline) * 1000).toISOString());

    // Build chain object for viem
    const chain = {
      id: networkConfig.chainId,
      name: networkConfig.label,
      network,
      nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
      rpcUrls: { default: { http: [networkConfig.rpcUrl] } },
      testnet: networkConfig.label.includes('Sepolia') || networkConfig.label.includes('Testnet'),
    };

    // Verify ERC-2612 Permit signature
    // Get EIP-712 domain name/version from extra or fall back to defaults
    const extra = paymentRequirements.extra || {};
    const permitDomain = {
      name: extra.name || 'Stable Coin',
      version: extra.version || '1',
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

    // Check deadline
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

    // Check amount
    if (BigInt(value) < BigInt(paymentRequirements.maxAmountRequired)) {
      console.log('   ❌ Insufficient amount');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'Insufficient amount'
      });
    }

    console.log('   ✅ Amount sufficient');

    // Check recipient
    if (recipient.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      console.log('   ❌ Invalid recipient');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'Invalid recipient'
      });
    }

    console.log('   ✅ Recipient valid');

    // Check on-chain ERC-20 token balance
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
      payer = req.body.paymentPayload?.payload?.authorization?.from || 'unknown';
    } catch {}

    res.status(500).json({
      isValid: false,
      payer,
      invalidReason: `Server error: ${error.message}`,
    });
  }
}
