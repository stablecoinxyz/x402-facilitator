import { Request, Response } from 'express';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from 'pino';
import { config, resolveToken, toCaip2Network } from '../config';
import { settleSolanaPayment } from '../solana/settle';
import { nonceTracker } from '../protection/nonce-tracker';
import { settleTotal, settleDuration } from '../lib/metrics';
import { settlementQueue } from '../lib/settlement-queue';
import logger from '../lib/logger';

/**
 * Payment Settlement Handler - x402 V2 with ERC-2612 Permit
 *
 * Executes on-chain transfers for multiple networks:
 *
 * - Solana: Delegated SPL token transfer (handled by solana/settle.ts)
 *   Facilitator executes transfer as delegate: Agent → Merchant
 *
 * - Base/Radius: ERC-2612 Permit + TransferFrom
 *   1. Facilitator calls permit(owner, spender, value, deadline, v, r, s)
 *   2. Facilitator calls transferFrom(owner, recipient, value)
 *   Tokens flow: Payer → Merchant (facilitator never holds funds)
 *
 * All settlement methods maintain non-custodial properties - the facilitator
 * never holds customer funds.
 */

/** Parse CAIP-2 network identifier to extract chain ID, e.g. "eip155:8453" → 8453 */
function parseEvmChainId(network: string): number | null {
  const match = network.match(/^eip155:(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Resolve CAIP-2 network string to chain config + credentials */
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
      privateKey: config.baseFacilitatorPrivateKey,
      testnet: false,
    };
  }
  if (chainId === config.baseSepoliaChainId) {
    return {
      label: 'Base Sepolia',
      chainId: config.baseSepoliaChainId,
      rpcUrl: config.baseSepoliaRpcUrl,
      sbcTokenAddress: config.baseSepoliaSbcTokenAddress,
      decimals: config.baseSepoliaSbcDecimals,
      privateKey: config.baseSepoliaFacilitatorPrivateKey,
      testnet: true,
    };
  }
  if (chainId === config.radiusChainId || chainId === 723487) {
    return {
      label: 'Radius Mainnet',
      chainId: config.radiusChainId,
      rpcUrl: config.radiusRpcUrl,
      sbcTokenAddress: config.radiusSbcTokenAddress,
      decimals: config.radiusSbcDecimals,
      privateKey: config.radiusFacilitatorPrivateKey,
      testnet: false,
    };
  }
  if (chainId === config.radiusTestnetChainId) {
    return {
      label: 'Radius Testnet',
      chainId: config.radiusTestnetChainId,
      rpcUrl: config.radiusTestnetRpcUrl,
      sbcTokenAddress: config.radiusTestnetSbcTokenAddress,
      decimals: config.radiusTestnetSbcDecimals,
      privateKey: config.radiusTestnetFacilitatorPrivateKey,
      testnet: true,
    };
  }
  return null;
}

/**
 * Detect whether an incoming paymentPayload is v1 (flat) or v2 (envelope).
 */
function isV1Payload(payload: any): boolean {
  return payload && !payload.accepted;
}

/**
 * Normalize a v1 flat payload into v2 envelope format for settlement.
 */
function normalizeV1ToV2(payload: any, requirements: any): any {
  const network = requirements?.network || 'unknown';
  const scheme = requirements?.scheme || 'exact';

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
 */
function normalizeRequirements(req: any): any {
  if (!req) return req;
  const normalized = { ...req };
  if (normalized.amount === undefined && normalized.maxAmountRequired !== undefined) {
    normalized.amount = normalized.maxAmountRequired;
  }
  return normalized;
}

export async function settlePayment(req: Request, res: Response) {
  const log: Logger = res.locals.log || logger;
  const startTime = process.hrtime.bigint();
  let network = 'unknown';

  try {
    let { paymentPayload, paymentRequirements } = req.body;
    const isV1 = isV1Payload(paymentPayload);

    log.info({ action: 'settle', x402Version: isV1 ? 1 : 2 }, 'Settle request received');

    if (!paymentPayload) {
      log.warn({ action: 'settle' }, 'Missing paymentPayload');
      settleTotal.inc({ network, result: 'bad_request' });
      return res.status(400).json({
        success: false,
        payer: 'unknown',
        transaction: '',
        network: 'unknown',
        errorReason: 'Missing paymentPayload',
      });
    }

    // Normalize v1 → v2 internally
    if (isV1) {
      paymentPayload = normalizeV1ToV2(paymentPayload, paymentRequirements);
    }
    paymentRequirements = normalizeRequirements(paymentRequirements);

    // v1 clients send plain names ("base"); everything downstream expects CAIP-2.
    network = toCaip2Network(paymentPayload.accepted?.network);
    const scheme = paymentPayload.accepted?.scheme;

    log.debug({ scheme, network }, 'Payment details');

    // Verify scheme is "exact"
    if (scheme !== 'exact') {
      log.warn({ scheme, network }, 'Unsupported payment scheme');
      settleTotal.inc({ network, result: 'failed' });
      return res.json({
        success: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        transaction: '',
        network: network || 'unknown',
        errorReason: 'unsupported_scheme'
      });
    }

    // Reject zero-requirement and self-directed payments (EVM + Solana) before any on-chain work.
    // A zero maxAmountRequired lets a caller force useless 0-value settlements;
    // from==payTo is a self-transfer that only wastes facilitator gas.
    const reqAmount = paymentRequirements?.amount ?? '0';
    const payFrom = paymentPayload.payload?.authorization?.from ?? paymentPayload.payload?.from;
    if (BigInt(reqAmount) <= 0n) {
      log.warn({ payer: payFrom ?? 'unknown', network, errorReason: 'invalid_amount' }, 'Zero-value settlement rejected');
      settleTotal.inc({ network, result: 'failed' });
      return res.json({ success: false, payer: payFrom ?? 'unknown', transaction: '', network, errorReason: 'invalid_amount' });
    }
    if (payFrom && paymentRequirements?.payTo && payFrom.toLowerCase() === String(paymentRequirements.payTo).toLowerCase()) {
      log.warn({ payer: payFrom, network, errorReason: 'invalid_self_payment' }, 'Self-payment settlement rejected');
      settleTotal.inc({ network, result: 'failed' });
      return res.json({ success: false, payer: payFrom, transaction: '', network, errorReason: 'invalid_self_payment' });
    }

    // Route by network — Solana uses CAIP-2 "solana:..." prefix
    if (network?.startsWith('solana:')) {
      log.debug({ network }, 'Solana settlement (delegated transfer)');
      const result = await settleSolanaPayment(paymentPayload.payload, log);
      const resultLabel = result.success ? 'success' : 'failed';
      settleTotal.inc({ network, result: resultLabel });
      recordDuration(startTime, network);
      log.info({ action: 'settle', network, success: result.success, payer: result.payer, txHash: result.transaction }, 'Settle complete');
      return res.json(result);
    }

    // Resolve EVM network from CAIP-2 identifier
    const networkConfig = resolveEvmNetwork(network);
    if (!networkConfig) {
      log.warn({ network }, 'Unknown payment network');
      settleTotal.inc({ network, result: 'failed' });
      return res.json({
        success: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        transaction: '',
        network: network || 'unknown',
        errorReason: 'invalid_network'
      });
    }

    log.debug({ network, label: networkConfig.label }, 'EVM settlement');

    // Extract v2 authorization + signature
    const { authorization, signature } = paymentPayload.payload || {};

    if (!authorization) {
      log.warn({ network }, 'Missing authorization data');
      settleTotal.inc({ network, result: 'failed' });
      return res.json({
        success: false,
        payer: 'unknown',
        transaction: '',
        network,
        errorReason: 'invalid_payload'
      });
    }

    const owner = authorization.from;
    const spender = authorization.to;
    const value = authorization.value;
    const deadline = authorization.validBefore;
    const nonce = authorization.nonce;
    const recipient = paymentRequirements.payTo;

    // Resolve token from asset address in paymentRequirements
    const assetAddress = paymentRequirements.asset;
    const tokenConfig = assetAddress ? resolveToken(networkConfig.chainId, assetAddress) : null;
    const tokenAddress = tokenConfig?.address || networkConfig.sbcTokenAddress;

    if (assetAddress && !tokenConfig) {
      log.warn({ asset: assetAddress, network }, 'Unsupported asset for network');
      settleTotal.inc({ network, result: 'failed' });
      return res.json({
        success: false,
        payer: owner,
        transaction: '',
        network,
        errorReason: 'unsupported_asset'
      });
    }

    // Nonce replay protection — if already settled, return the original success response (idempotent)
    const previousSettlement = nonceTracker.getSettled(network, owner, nonce);
    if (previousSettlement) {
      log.info({ payer: owner, network, nonce, txHash: previousSettlement.txHash }, 'Idempotent replay — returning original settlement');
      settleTotal.inc({ network, result: 'replay' });
      return res.json({
        success: true,
        payer: previousSettlement.payer,
        transaction: previousSettlement.txHash,
        network: previousSettlement.network,
      });
    }

    // Reject a malformed signature before spending an RPC round trip on it.
    // A 65-byte compact signature is "0x" + 130 hex chars. Anything shorter makes
    // slice() return "" and parseInt() return NaN, which viem then throws on while
    // ABI-encoding — surfacing as a generic gas_estimation_failed rather than the
    // client error it actually is.
    if (!isWellFormedSignature(signature)) {
      log.warn({ payer: owner, network, errorReason: 'permit_signature_invalid' }, 'Malformed permit signature');
      settleTotal.inc({ network, result: 'invalid_signature' });
      recordDuration(startTime, network);
      return res.json({
        success: false,
        payer: owner,
        transaction: '',
        network,
        errorReason: 'permit_signature_invalid',
      });
    }

    // Derive v, r, s from compact signature for on-chain permit()
    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    const v = parseInt(signature.slice(130, 132), 16);

    log.debug({ payer: owner, spender, recipient, value, deadline: new Date(Number(deadline) * 1000).toISOString() }, 'Authorization details');

    // Pre-settle deadline check — don't waste gas on an expired permit
    const SAFETY_MARGIN_SECONDS = 30;
    const now = Math.floor(Date.now() / 1000);
    const deadlineNum = Number(deadline);
    if (now > deadlineNum) {
      log.warn({ payer: owner, network, errorReason: 'permit_expired', expiredAt: deadlineNum }, 'Permit already expired');
      settleTotal.inc({ network, result: 'expired' });
      return res.json({
        success: false,
        payer: owner,
        transaction: '',
        network,
        errorReason: 'permit_expired',
        expiredAt: deadlineNum,
        suggestRetry: true,
      });
    }
    if (deadlineNum - now < SAFETY_MARGIN_SECONDS) {
      log.warn({ payer: owner, network, errorReason: 'permit_expired', remainingSeconds: deadlineNum - now, safetyMargin: SAFETY_MARGIN_SECONDS }, 'Permit expires within safety margin');
      settleTotal.inc({ network, result: 'expired' });
      return res.json({
        success: false,
        payer: owner,
        transaction: '',
        network,
        errorReason: 'permit_expired',
        expiredAt: deadlineNum,
        remainingSeconds: deadlineNum - now,
        suggestRetry: true,
      });
    }
    log.debug({ remainingSeconds: deadlineNum - now }, 'Permit deadline OK');

    if (!networkConfig.privateKey) {
      throw new Error(`Facilitator private key not configured for ${networkConfig.label}. Set the appropriate env var in .env.`);
    }

    // Radius uses RUSD as native gas token with Turnstile auto-conversion from SBC.
    // Radius supports both legacy and EIP-1559 txs, BUT viem's default EIP-1559
    // sets maxPriorityFeePerGas=0 which Radius rejects as "gas price too low."
    // We use legacy (type 0) with explicit gasPrice — simpler and proven on mainnet.
    // eth_estimateGas is broken on Radius regardless of tx type (Turnstile issue).
    // Base: EIP-1559 tx (type 2) — viem default when no gasPrice override.
    const isRadius = networkConfig.chainId === config.radiusChainId || networkConfig.chainId === config.radiusTestnetChainId;

    // Build chain object for viem — Radius uses RUSD as native gas token
    const chain = {
      id: networkConfig.chainId,
      name: networkConfig.label,
      network,
      nativeCurrency: { decimals: 18, name: 'RUSD', symbol: 'RUSD' },
      rpcUrls: { default: { http: [networkConfig.rpcUrl] } },
      testnet: networkConfig.testnet,
    };

    // Create facilitator account
    const account = privateKeyToAccount(networkConfig.privateKey as `0x${string}`);

    // Create wallet client
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(networkConfig.rpcUrl),
    });

    // Create public client — use fast polling to minimize receipt wait overhead
    const publicClient = createPublicClient({
      chain,
      transport: http(networkConfig.rpcUrl),
      pollingInterval: 100,
    });

    log.debug({ label: networkConfig.label }, 'Executing transfer');

    // Check if we should use real or simulated settlement
    const useRealSettlement = process.env.ENABLE_REAL_SETTLEMENT === 'true';

    let txHash: string;

    if (useRealSettlement) {
      log.info({ payer: owner, network, mode: 'real', queueDepth: settlementQueue.pending(account.address) }, 'Real settlement: ERC-2612 Permit + TransferFrom');

      // ERC-2612 Permit ABI
      const ERC20_PERMIT_ABI = [
        {
          inputs: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
            { name: 'v', type: 'uint8' },
            { name: 'r', type: 'bytes32' },
            { name: 's', type: 'bytes32' }
          ],
          name: 'permit',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function'
        },
        {
          inputs: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          name: 'transferFrom',
          outputs: [{ name: '', type: 'bool' }],
          stateMutability: 'nonpayable',
          type: 'function'
        }
      ] as const;

      log.debug({ token: tokenAddress }, 'Token contract');

      // Gas estimation dry-run — catch reverts before wasting gas.
      // Skip for Radius: eth_estimateGas always returns "Exec Failed" on Radius
      if (!isRadius) {
        log.debug('Estimating gas for permit()');
        try {
          await publicClient.estimateContractGas({
            address: tokenAddress as `0x${string}`,
            abi: ERC20_PERMIT_ABI,
            functionName: 'permit',
            args: [
              owner as `0x${string}`,
              spender as `0x${string}`,
              BigInt(value),
              BigInt(deadline),
              v,
              r as `0x${string}`,
              s as `0x${string}`
            ],
            account: account.address,
          });
          log.debug('Gas estimation passed');
        } catch (gasError: any) {
          // Estimation simulates permit(); a revert here is normally the client's
          // permit being invalid, so classify it instead of dumping everything
          // into the catch-all `failed` label the settle alert watches.
          const gasErr = categorizeSettleError(gasError);
          const classified = gasErr.errorCategory !== 'unknown';
          log.warn({ err: gasError, payer: owner, network, errorCategory: gasErr.errorCategory }, 'Gas estimation failed');
          settleTotal.inc({ network, result: classified ? gasErr.errorCategory : 'failed' });
          recordDuration(startTime, network);
          return res.json({
            success: false,
            payer: owner,
            transaction: '',
            network,
            errorReason: classified ? gasErr.errorReason : `gas_estimation_failed: ${gasError.message}`,
          });
        }
      } else {
        log.debug('Skipping gas estimation (Radius fee abstraction incompatible)');
      }

      // Serialize on-chain execution per facilitator wallet to prevent nonce collisions.
      // Critical for chains without a mempool (Radius) where concurrent nonce submissions fail.
      const onChainResult = await settlementQueue.enqueue(account.address, async () => {
        // Fetch nonce INSIDE the queue — guarantees sequential nonce assignment
        const pendingNonce = await publicClient.getTransactionCount({
          address: account.address,
          blockTag: 'pending',
        });

        // Passing gasPrice forces viem to send type 0 (legacy) tx for Radius.
        const gasOverrides: { gasPrice?: bigint } = {};
        if (isRadius) {
          gasOverrides.gasPrice = (await publicClient.getGasPrice()) + 1000000000n;
          log.debug({ gasPrice: gasOverrides.gasPrice.toString() }, 'Radius legacy gasPrice');
        }

        // Step 1: Call permit() to approve the facilitator
        log.debug({ step: 1, payer: owner, spender, value, deadline, nonce: pendingNonce }, 'Calling permit()');

        const permitHash = await walletClient.writeContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_PERMIT_ABI,
          functionName: 'permit',
          args: [
            owner as `0x${string}`,
            spender as `0x${string}`,
            BigInt(value),
            BigInt(deadline),
            v,
            r as `0x${string}`,
            s as `0x${string}`
          ],
          nonce: pendingNonce,
          ...gasOverrides,
        });

        log.debug({ permitHash }, 'Waiting for permit confirmation');
        await publicClient.waitForTransactionReceipt({
          hash: permitHash,
          confirmations: 1
        });
        log.debug({ permitHash }, 'Permit confirmed');

        // Step 2: Call transferFrom() to move tokens to merchant
        // Retry up to 3 times — RPC nodes may not have the permit tx yet
        log.debug({ step: 2, from: owner, to: recipient, amount: value }, 'Calling transferFrom()');

        let transferHash = '' as `0x${string}`;
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            transferHash = await walletClient.writeContract({
              address: tokenAddress as `0x${string}`,
              abi: ERC20_PERMIT_ABI,
              functionName: 'transferFrom',
              args: [
                owner as `0x${string}`,      // Payer
                recipient as `0x${string}`,  // Merchant
                BigInt(value)
              ],
              nonce: pendingNonce + 1,
              ...gasOverrides,
            });
            break;
          } catch (err: any) {
            const msg = err?.message || '';
            if (attempt < maxRetries && msg.includes('insufficient allowance')) {
              log.warn({ attempt, maxRetries }, 'transferFrom failed (allowance not propagated), retrying');
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            // Attach the permit hash so the caller can debug on-chain
            err.permitHash = permitHash;
            throw err;
          }
        }

        log.debug({ txHash: transferHash }, 'Waiting for transfer confirmation');

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: transferHash,
          confirmations: 1
        });

        return { txHash: transferHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
      });

      txHash = onChainResult.txHash;

      log.info({
        action: 'settle', network, payer: owner, txHash, blockNumber: onChainResult.blockNumber.toString(), gasUsed: onChainResult.gasUsed.toString(), success: true,
      }, 'Settlement complete');
    } else {
      log.info({ payer: owner, network, mode: 'simulated' }, 'Simulated settlement');

      // Simulate a transaction hash
      txHash = `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;

      log.info({ action: 'settle', network, payer: owner, txHash, success: true, mode: 'simulated' }, 'Simulated settlement complete');
    }

    // Mark nonce as settled with tx hash for idempotent replay
    nonceTracker.markSettled(network, owner, nonce, { txHash, payer: owner, network });
    settleTotal.inc({ network, result: 'success' });
    recordDuration(startTime, network);

    res.json({
      success: true,
      payer: owner,
      transaction: txHash,
      network,
    });

  } catch (error: any) {
    // Try to extract payer and network from request if possible
    let payer = 'unknown';
    try {
      payer = req.body.paymentPayload?.payload?.authorization?.from || 'unknown';
      const rawNetwork = req.body.paymentPayload?.accepted?.network;
      if (rawNetwork) network = toCaip2Network(rawNetwork);
    } catch {}

    // Categorize the error for precise metrics
    const { errorCategory, errorReason } = categorizeSettleError(error);

    // Include partial tx hash if permit succeeded but transferFrom failed
    const partialTxHash = error?.permitHash || '';

    log.error({ err: error, action: 'settle', network, payer, errorCategory, errorReason, permitHash: partialTxHash || undefined }, `Settlement error: ${errorCategory}`);
    settleTotal.inc({ network, result: errorCategory });
    recordDuration(startTime, network);

    res.status(200).json({
      success: false,
      payer,
      transaction: partialTxHash,
      network,
      errorReason,
    });
  }
}

/**
 * A compact ECDSA signature is 65 bytes: r (32) + s (32) + v (1), hex-encoded
 * with an 0x prefix, so exactly 132 characters.
 *
 * Validated up front because the downstream slice/parseInt produces NaN on a
 * short input, and viem throws a RangeError while ABI-encoding it. That lands in
 * the catch-all `failed` metric label instead of `invalid_signature`, which
 * makes a client sending junk look like a facilitator fault.
 */
function isWellFormedSignature(signature: unknown): signature is string {
  return typeof signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(signature);
}

/**
 * Map a thrown settlement error to a metric label + client-facing reason.
 *
 * Shared by the catch-all handler and the gas-estimation dry run. Estimation
 * simulates permit(), so a revert there is normally the client's permit being
 * bad — a wrong signature, a consumed nonce — not a facilitator fault. It used
 * to return early under the catch-all `failed` label, which put client errors in
 * the bucket the settle alert watches.
 *
 * Order matters: the ECDSA branch must precede the generic revert branch,
 * because viem's message for a bad signature contains both.
 */
export function categorizeSettleError(error: any): { errorCategory: string; errorReason: string } {
  const msg = error?.message || '';
  const shortMsg = error?.shortMessage || '';

  if (msg.includes('insufficient allowance') || shortMsg.includes('insufficient allowance')) {
    return { errorCategory: 'insufficient_allowance', errorReason: 'permit_not_effective' };
  }
  if (msg.includes('nonce too low') || msg.includes('replacement transaction underpriced') || msg.includes('already known')) {
    return { errorCategory: 'nonce_conflict', errorReason: 'tx_nonce_conflict' };
  }
  if (msg.includes('insufficient funds') || msg.includes('gas price too low') || msg.includes('intrinsic gas too low')) {
    return { errorCategory: 'gas_error', errorReason: 'insufficient_gas' };
  }
  if (msg.includes('ECDSA') || msg.includes('invalid signature') || msg.includes('Invalid signer')) {
    return { errorCategory: 'invalid_signature', errorReason: 'permit_signature_invalid' };
  }
  if (msg.includes('execution reverted') || msg.includes('revert')) {
    return { errorCategory: 'tx_reverted', errorReason: `tx_reverted: ${shortMsg || msg.slice(0, 200)}` };
  }
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
    return { errorCategory: 'rpc_error', errorReason: 'rpc_connection_error' };
  }
  if (msg.includes('TransactionReceiptNotFoundError') || msg.includes('could not be found')) {
    return { errorCategory: 'receipt_timeout', errorReason: 'tx_receipt_not_found' };
  }
  return { errorCategory: 'unknown', errorReason: msg.slice(0, 300) };
}

function recordDuration(startTime: bigint, network: string) {
  const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  settleDuration.observe({ network }, durationMs / 1000);
}
