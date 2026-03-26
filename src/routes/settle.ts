import { Request, Response } from 'express';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from 'pino';
import { config, resolveToken } from '../config';
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
  if (chainId === config.radiusChainId || chainId === 723 || chainId === 723487) {
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

    network = paymentPayload.accepted?.network || 'unknown';
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
          log.warn({ err: gasError, payer: owner, network }, 'Gas estimation failed');
          settleTotal.inc({ network, result: 'failed' });
          return res.json({
            success: false,
            payer: owner,
            transaction: '',
            network,
            errorReason: `gas_estimation_failed: ${gasError.message}`,
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
      network = req.body.paymentPayload?.accepted?.network || network;
    } catch {}

    // Categorize the error for precise metrics
    const msg = error?.message || '';
    const shortMsg = error?.shortMessage || '';
    let errorCategory: string;
    let errorReason: string;

    if (msg.includes('insufficient allowance') || shortMsg.includes('insufficient allowance')) {
      errorCategory = 'insufficient_allowance';
      errorReason = 'permit_not_effective';
    } else if (msg.includes('nonce too low') || msg.includes('replacement transaction underpriced') || msg.includes('already known')) {
      errorCategory = 'nonce_conflict';
      errorReason = 'tx_nonce_conflict';
    } else if (msg.includes('insufficient funds') || msg.includes('gas price too low') || msg.includes('intrinsic gas too low')) {
      errorCategory = 'gas_error';
      errorReason = 'insufficient_gas';
    } else if (msg.includes('ECDSA') || msg.includes('invalid signature') || msg.includes('Invalid signer')) {
      errorCategory = 'invalid_signature';
      errorReason = 'permit_signature_invalid';
    } else if (msg.includes('execution reverted') || msg.includes('revert')) {
      errorCategory = 'tx_reverted';
      errorReason = `tx_reverted: ${shortMsg || msg.slice(0, 200)}`;
    } else if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
      errorCategory = 'rpc_error';
      errorReason = 'rpc_connection_error';
    } else if (msg.includes('TransactionReceiptNotFoundError') || msg.includes('could not be found')) {
      errorCategory = 'receipt_timeout';
      errorReason = 'tx_receipt_not_found';
    } else {
      errorCategory = 'unknown';
      errorReason = msg.slice(0, 300);
    }

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

function recordDuration(startTime: bigint, network: string) {
  const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  settleDuration.observe({ network }, durationMs / 1000);
}
