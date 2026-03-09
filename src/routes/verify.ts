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

/** Resolve facilitator address for a given CAIP-2 EVM network */
function resolveEvmFacilitatorAddress(network: string): string | null {
  const chainId = parseEvmChainId(network);
  if (chainId === null) return null;
  if (chainId === config.baseChainId) return config.baseFacilitatorAddress;
  if (chainId === config.baseSepoliaChainId) return config.baseSepoliaFacilitatorAddress;
  if (chainId === config.radiusChainId) return config.radiusFacilitatorAddress;
  if (chainId === config.radiusTestnetChainId) return config.radiusTestnetFacilitatorAddress;
  return null;
}

/**
 * Detect whether an incoming paymentPayload is v1 (flat) or v2 (envelope).
 * v2 payloads have `accepted.scheme` and `accepted.network`.
 * v1 payloads have a flat structure with no `accepted` envelope.
 */
function isV1Payload(payload: any): boolean {
  return payload && !payload.accepted;
}

/**
 * Normalize a v1 flat payload into v2 envelope format.
 * v1 payloads carry scheme/network at the top level or in paymentRequirements.
 */
function normalizeV1ToV2(payload: any, requirements: any): any {
  // v1 EVM payloads have signature + authorization at top level
  // v1 Solana payloads have from/to/amount/signature at top level
  const network = requirements?.network || 'unknown';
  const scheme = requirements?.scheme || 'exact';

  // Check if this looks like a Solana payload (has `from` as base58, not 0x)
  const isSolana = network?.startsWith('solana:') ||
    (payload.from && !payload.from.startsWith('0x'));

  if (isSolana) {
    return {
      x402Version: 1,
      accepted: { scheme, network },
      payload: {
        from: payload.from,
        to: payload.to,
        amount: payload.amount,
        nonce: payload.nonce,
        deadline: payload.deadline,
        signature: payload.signature,
      },
      extensions: {},
    };
  }

  // EVM: v1 may have authorization nested or flat
  const auth = payload.authorization || {
    from: payload.from,
    to: payload.to,
    value: payload.value,
    validAfter: payload.validAfter || '0',
    validBefore: payload.validBefore || payload.deadline,
    nonce: payload.nonce,
  };

  return {
    x402Version: 1,
    accepted: { scheme, network },
    payload: {
      signature: payload.signature,
      authorization: auth,
    },
    extensions: {},
  };
}

/**
 * Normalize paymentRequirements: accept both v2 `amount` and v1 `maxAmountRequired`.
 * Internally we use `amount`.
 */
function normalizeRequirements(req: any): any {
  if (!req) return req;
  const normalized = { ...req };
  // Accept both field names, prefer `amount` if both present
  if (normalized.amount === undefined && normalized.maxAmountRequired !== undefined) {
    normalized.amount = normalized.maxAmountRequired;
  }
  return normalized;
}

export async function verifyPayment(req: Request, res: Response) {
  try {
    let { paymentPayload, paymentRequirements } = req.body;
    const isV1 = isV1Payload(paymentPayload);

    console.log(`\n🔍 Verifying payment (x402 ${isV1 ? 'V1' : 'V2'})...`);

    if (!paymentPayload) {
      return res.status(500).json({
        isValid: false,
        payer: 'unknown',
        invalidReason: 'Missing paymentPayload',
      });
    }

    // Normalize v1 → v2 internally
    if (isV1) {
      paymentPayload = normalizeV1ToV2(paymentPayload, paymentRequirements);
    }
    paymentRequirements = normalizeRequirements(paymentRequirements);

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
        invalidReason: 'unsupported_scheme'
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
        invalidReason: 'invalid_network'
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
        invalidReason: 'invalid_payload'
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
      nativeCurrency: { decimals: 18, name: 'RUSD', symbol: 'RUSD' },
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
          invalidReason: 'invalid_exact_evm_payload_signature'
        });
      }

      console.log('   ✅ Permit signature valid');
    } catch (error) {
      console.log('   ❌ Permit signature verification failed:', error);
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_signature'
      });
    }

    // Check time window — validAfter and validBefore (spec step 4)
    const now = Math.floor(Date.now() / 1000);
    const validAfter = Number(authorization.validAfter || '0');
    if (now < validAfter) {
      console.log('   ❌ Permit not yet valid (validAfter in the future)');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_authorization_valid_after'
      });
    }

    if (now > Number(deadline)) {
      console.log('   ❌ Permit expired');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_authorization_valid_before'
      });
    }

    console.log('   ✅ Time window valid');

    // Check amount (spec step 3)
    if (BigInt(value) < BigInt(paymentRequirements.amount)) {
      console.log('   ❌ Insufficient amount');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch'
      });
    }

    console.log('   ✅ Amount sufficient');

    // Check spender matches our facilitator address (spec step 5)
    const facilitatorAddress = resolveEvmFacilitatorAddress(network);
    if (facilitatorAddress && spender.toLowerCase() !== facilitatorAddress.toLowerCase()) {
      console.log('   ❌ Spender does not match facilitator');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_recipient_mismatch'
      });
    }

    console.log('   ✅ Spender valid');

    // Check recipient
    if (recipient.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      console.log('   ❌ Invalid recipient');
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_recipient_mismatch'
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
        invalidReason: 'insufficient_funds'
      });
    }

    console.log('   ✅ Balance sufficient');

    // All checks passed
    const remainingSeconds = Number(deadline) - Math.floor(Date.now() / 1000);
    console.log(`✅ Payment verification successful! (${remainingSeconds}s until permit expires)\n`);
    res.json({
      isValid: true,
      payer: owner,
      invalidReason: null,
      remainingSeconds,
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
