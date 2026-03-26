import { Request, Response } from 'express';
import { createPublicClient, http, verifyTypedData } from 'viem';
import type { Logger } from 'pino';
import { config, resolveToken } from '../config';
import { verifySolanaPayment } from '../solana/verify';
import { verifyTotal, verifyDuration } from '../lib/metrics';
import logger from '../lib/logger';

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
      chainId: config.baseChainId,
      rpcUrl: config.baseRpcUrl,
      sbcTokenAddress: config.baseSbcTokenAddress,
      decimals: config.baseSbcDecimals,
    };
  }
  if (chainId === config.baseSepoliaChainId) {
    return {
      label: 'Base Sepolia',
      chainId: config.baseSepoliaChainId,
      rpcUrl: config.baseSepoliaRpcUrl,
      sbcTokenAddress: config.baseSepoliaSbcTokenAddress,
      decimals: config.baseSepoliaSbcDecimals,
    };
  }
  if (chainId === config.radiusChainId || chainId === 723 || chainId === 723487) {
    return {
      label: 'Radius Mainnet',
      chainId: config.radiusChainId,
      rpcUrl: config.radiusRpcUrl,
      sbcTokenAddress: config.radiusSbcTokenAddress,
      decimals: config.radiusSbcDecimals,
    };
  }
  if (chainId === config.radiusTestnetChainId) {
    return {
      label: 'Radius Testnet',
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
  if (chainId === config.radiusChainId || chainId === 723 || chainId === 723487) return config.radiusFacilitatorAddress;
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
  const log: Logger = res.locals.log || logger;
  const startTime = process.hrtime.bigint();
  let network = 'unknown';

  try {
    let { paymentPayload, paymentRequirements } = req.body;
    const isV1 = isV1Payload(paymentPayload);

    log.info({ action: 'verify', x402Version: isV1 ? 1 : 2 }, 'Verify request received');

    if (!paymentPayload) {
      log.warn({ action: 'verify' }, 'Missing paymentPayload');
      verifyTotal.inc({ network, result: 'bad_request' });
      return res.status(400).json({
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

    network = paymentPayload.accepted?.network || 'unknown';
    const scheme = paymentPayload.accepted?.scheme;

    log.debug({ scheme, network }, 'Payment details');

    // Verify scheme is "exact"
    if (scheme !== 'exact') {
      log.warn({ scheme, network }, 'Unsupported payment scheme');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        invalidReason: 'unsupported_scheme'
      });
    }

    // Route by network — Solana uses CAIP-2 "solana:..." prefix
    if (network?.startsWith('solana:')) {
      log.debug({ network }, 'Solana payment detected');
      try {
        const result = await verifySolanaPayment(paymentPayload.payload, paymentRequirements, log);
        verifyTotal.inc({ network, result: result.isValid ? 'valid' : 'invalid' });
        recordDuration(startTime, network);
        log.info({ action: 'verify', network, success: result.isValid, payer: result.payer }, 'Verify complete');
        return res.json(result);
      } catch (solanaErr: any) {
        const payer = paymentPayload.payload?.from || 'unknown';
        log.warn({ err: solanaErr, network, payer }, 'Solana verification error');
        verifyTotal.inc({ network, result: 'invalid' });
        recordDuration(startTime, network);
        return res.json({
          isValid: false,
          payer,
          invalidReason: 'invalid_solana_signature',
        });
      }
    }

    // Resolve EVM network from CAIP-2 identifier
    const networkConfig = resolveEvmNetwork(network);
    if (!networkConfig) {
      log.warn({ network }, 'Unknown payment network');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        invalidReason: 'invalid_network'
      });
    }

    log.debug({ network, label: networkConfig.label }, 'EVM payment detected');

    // Extract v2 authorization data
    const { authorization, signature } = paymentPayload.payload || {};

    if (!authorization) {
      log.warn({ network }, 'Missing authorization data');
      verifyTotal.inc({ network, result: 'invalid' });
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

    log.debug({ payer: owner, spender, recipient, value, deadline: new Date(Number(deadline) * 1000).toISOString() }, 'Authorization details');

    // Build chain object for viem
    const chain = {
      id: networkConfig.chainId,
      name: networkConfig.label,
      network,
      nativeCurrency: { decimals: 18, name: 'RUSD', symbol: 'RUSD' },
      rpcUrls: { default: { http: [networkConfig.rpcUrl] } },
      testnet: networkConfig.label.includes('Sepolia') || networkConfig.label.includes('Testnet'),
    };

    // Resolve token from asset address in paymentRequirements
    const assetAddress = paymentRequirements.asset;
    const tokenConfig = assetAddress ? resolveToken(networkConfig.chainId, assetAddress) : null;

    // Fall back to network default (SBC token) if no asset specified
    const tokenAddress = tokenConfig?.address || networkConfig.sbcTokenAddress;
    const tokenDecimals = tokenConfig?.decimals || networkConfig.decimals;

    if (assetAddress && !tokenConfig) {
      log.warn({ asset: assetAddress, network }, 'Unsupported asset for network');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'unsupported_asset'
      });
    }

    // Verify ERC-2612 Permit signature
    // Get EIP-712 domain name/version from token config or extra fields
    const extra = paymentRequirements.extra || {};
    const permitDomain = {
      name: extra.name || tokenConfig?.name || 'Stable Coin',
      version: extra.version || tokenConfig?.version || '1',
      chainId: networkConfig.chainId,
      verifyingContract: tokenAddress as `0x${string}`,
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
        log.warn({ payer: owner, network, errorReason: 'invalid_exact_evm_payload_signature' }, 'Invalid permit signature');
        verifyTotal.inc({ network, result: 'invalid' });
        return res.json({
          isValid: false,
          payer: owner,
          invalidReason: 'invalid_exact_evm_payload_signature'
        });
      }

      log.debug('Permit signature valid');
    } catch (error) {
      log.warn({ err: error, payer: owner, network }, 'Permit signature verification failed');
      verifyTotal.inc({ network, result: 'invalid' });
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
      log.warn({ payer: owner, network, errorReason: 'invalid_exact_evm_payload_authorization_valid_after' }, 'Permit not yet valid');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_authorization_valid_after'
      });
    }

    if (now > Number(deadline)) {
      log.warn({ payer: owner, network, errorReason: 'invalid_exact_evm_payload_authorization_valid_before' }, 'Permit expired');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_authorization_valid_before'
      });
    }

    log.debug('Time window valid');

    // Check amount (spec step 3)
    if (BigInt(value) < BigInt(paymentRequirements.amount)) {
      log.warn({ payer: owner, network, errorReason: 'invalid_exact_evm_payload_authorization_value_mismatch' }, 'Insufficient amount');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch'
      });
    }

    log.debug('Amount sufficient');

    // Check spender matches our facilitator address (spec step 5)
    const facilitatorAddress = resolveEvmFacilitatorAddress(network);
    if (facilitatorAddress && spender.toLowerCase() !== facilitatorAddress.toLowerCase()) {
      log.warn({ payer: owner, network, errorReason: 'invalid_exact_evm_payload_recipient_mismatch' }, 'Spender does not match facilitator');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_recipient_mismatch'
      });
    }

    log.debug('Spender valid');

    // Check recipient
    if (recipient.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      log.warn({ payer: owner, network, errorReason: 'invalid_exact_evm_payload_recipient_mismatch' }, 'Invalid recipient');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'invalid_exact_evm_payload_recipient_mismatch'
      });
    }

    log.debug('Recipient valid');

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

    log.debug({ token: tokenAddress }, 'Checking on-chain balance');

    const balance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`]
    });

    const balanceFormatted = Number(balance) / Math.pow(10, tokenDecimals);
    log.debug({ balance: balance.toString(), balanceFormatted, payer: owner }, 'Balance check');

    if (balance < BigInt(value)) {
      log.warn({ payer: owner, network, balance: balance.toString(), required: value, errorReason: 'insufficient_funds' }, 'Insufficient balance');
      verifyTotal.inc({ network, result: 'invalid' });
      return res.json({
        isValid: false,
        payer: owner,
        invalidReason: 'insufficient_funds'
      });
    }

    log.debug('Balance sufficient');

    // All checks passed
    const remainingSeconds = Number(deadline) - Math.floor(Date.now() / 1000);
    verifyTotal.inc({ network, result: 'valid' });
    recordDuration(startTime, network);
    log.info({ action: 'verify', network, payer: owner, success: true, remainingSeconds }, 'Verify successful');
    res.json({
      isValid: true,
      payer: owner,
      invalidReason: null,
      remainingSeconds,
    });

  } catch (error: any) {
    // Try to extract payer from request if possible
    let payer = 'unknown';
    try {
      payer = req.body.paymentPayload?.payload?.authorization?.from || 'unknown';
    } catch {}

    const msg = error?.message || '';
    let errorCategory: string;

    if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      errorCategory = 'rpc_error';
    } else if (msg.includes('execution reverted') || msg.includes('revert')) {
      errorCategory = 'rpc_reverted';
    } else {
      errorCategory = 'unknown';
    }

    log.error({ err: error, action: 'verify', network, payer, errorCategory }, `Verification error: ${errorCategory}`);
    verifyTotal.inc({ network, result: errorCategory });

    res.status(500).json({
      isValid: false,
      payer,
      invalidReason: `Server error: ${error.message}`,
    });
  }
}

function recordDuration(startTime: bigint, network: string) {
  const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  verifyDuration.observe({ network }, durationMs / 1000);
}
