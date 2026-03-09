import { Request, Response } from 'express';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config';
import { settleSolanaPayment } from '../solana/settle';
import { nonceTracker } from '../protection/nonce-tracker';

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
      emoji: '🔵',
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
      emoji: '🔵',
      chainId: config.baseSepoliaChainId,
      rpcUrl: config.baseSepoliaRpcUrl,
      sbcTokenAddress: config.baseSepoliaSbcTokenAddress,
      decimals: config.baseSepoliaSbcDecimals,
      privateKey: config.baseSepoliaFacilitatorPrivateKey,
      testnet: true,
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
      privateKey: config.radiusFacilitatorPrivateKey,
      testnet: false,
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
  try {
    let { paymentPayload, paymentRequirements } = req.body;
    const isV1 = isV1Payload(paymentPayload);

    console.log(`\n💰 Settling payment (${isV1 ? 'v1' : 'v2'})...`);

    if (!paymentPayload) {
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

    const network = paymentPayload.accepted?.network;
    const scheme = paymentPayload.accepted?.scheme;

    console.log('   Scheme:', scheme);
    console.log('   Network:', network);

    // Verify scheme is "exact"
    if (scheme !== 'exact') {
      console.log('   ❌ Unsupported payment scheme');
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
      console.log('   🟣 Solana settlement (delegated transfer)');
      const result = await settleSolanaPayment(paymentPayload.payload);
      console.log(result.success ? '✅ Settlement complete!\n' : '❌ Settlement failed!\n');
      return res.json(result);
    }

    // Resolve EVM network from CAIP-2 identifier
    const networkConfig = resolveEvmNetwork(network);
    if (!networkConfig) {
      console.log('   ❌ Unknown payment network');
      return res.json({
        success: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        transaction: '',
        network: network || 'unknown',
        errorReason: 'invalid_network'
      });
    }

    console.log(`   ${networkConfig.emoji} ${networkConfig.label} settlement`);

    // Extract v2 authorization + signature
    const { authorization, signature } = paymentPayload.payload || {};

    if (!authorization) {
      console.log('   ❌ Missing authorization data');
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

    // Nonce replay protection — reject if we've already settled this exact permit
    if (nonceTracker.hasSettled(network, owner, nonce)) {
      console.log('   ❌ Nonce already settled (replay rejected)');
      return res.json({
        success: false,
        payer: owner,
        transaction: '',
        network,
        errorReason: 'nonce_already_settled',
      });
    }

    // Derive v, r, s from compact signature for on-chain permit()
    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    const v = parseInt(signature.slice(130, 132), 16);

    console.log('   Owner (Payer):', owner);
    console.log('   Spender (Facilitator):', spender);
    console.log('   Recipient (Merchant):', recipient);
    console.log('   Value:', value);
    console.log('   Deadline:', new Date(Number(deadline) * 1000).toISOString());

    // Pre-settle deadline check — don't waste gas on an expired permit
    const SAFETY_MARGIN_SECONDS = 30;
    const now = Math.floor(Date.now() / 1000);
    const deadlineNum = Number(deadline);
    if (now > deadlineNum) {
      console.log('   ❌ Permit already expired');
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
      console.log(`   ❌ Permit expires in ${deadlineNum - now}s (within ${SAFETY_MARGIN_SECONDS}s safety margin)`);
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
    console.log(`   ✅ Permit deadline OK (${deadlineNum - now}s remaining)`);

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

    // Fetch pending nonce once — use explicitly to avoid stale nonce between permit + transferFrom
    const pendingNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });

    // Passing gasPrice forces viem to send type 0 (legacy) tx for Radius.
    // Without it, viem sends type 2 (EIP-1559) with maxPriorityFeePerGas=0,
    // which Radius rejects. EIP-1559 works with explicit non-zero fees, but
    // legacy is simpler and proven.
    const gasOverrides: { gasPrice?: bigint } = {};
    if (isRadius) {
      gasOverrides.gasPrice = (await publicClient.getGasPrice()) + 1000000000n;
      console.log(`   ⛽ Radius legacy gasPrice: ${gasOverrides.gasPrice}`);
    }

    console.log(`   Executing transfer on ${networkConfig.label}...`);

    // Check if we should use real or simulated settlement
    const useRealSettlement = process.env.ENABLE_REAL_SETTLEMENT === 'true';

    let txHash: string;

    if (useRealSettlement) {
      console.log('   🔥 REAL SETTLEMENT MODE - ERC-2612 Permit + TransferFrom');

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

      console.log('   Token:', networkConfig.sbcTokenAddress);

      // Gas estimation dry-run — catch reverts before wasting gas.
      // Skip for Radius: eth_estimateGas always returns "Exec Failed" on Radius
      // due to Turnstile/RUSD fee abstraction (tested both legacy & EIP-1559).
      if (!isRadius) {
        console.log('   ⛽ Estimating gas for permit()...');
        try {
          await publicClient.estimateContractGas({
            address: networkConfig.sbcTokenAddress as `0x${string}`,
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
          console.log('   ✅ Gas estimation passed');
        } catch (gasError: any) {
          console.log('   ❌ Gas estimation failed:', gasError.message);
          return res.json({
            success: false,
            payer: owner,
            transaction: '',
            network,
            errorReason: `gas_estimation_failed: ${gasError.message}`,
          });
        }
      } else {
        console.log('   ⏭️  Skipping gas estimation (Radius fee abstraction incompatible)');
      }

      // Step 1: Call permit() to approve the facilitator
      console.log('   📝 Step 1: Calling permit()...');
      console.log('      owner:', owner);
      console.log('      spender:', spender);
      console.log('      value:', value);
      console.log('      deadline:', deadline);

      const permitHash = await walletClient.writeContract({
        address: networkConfig.sbcTokenAddress as `0x${string}`,
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

      console.log('   ⏳ Waiting for permit confirmation...');
      await publicClient.waitForTransactionReceipt({
        hash: permitHash,
        confirmations: 1
      });
      console.log('   ✅ Permit tx:', permitHash);

      // Step 2: Call transferFrom() to move tokens to merchant
      // Retry up to 3 times — RPC nodes may not have the permit tx yet
      console.log('   📝 Step 2: Calling transferFrom()...');
      console.log('      from:', owner);
      console.log('      to:', recipient);
      console.log('      amount:', value);

      let transferHash = '' as `0x${string}`;
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          transferHash = await walletClient.writeContract({
            address: networkConfig.sbcTokenAddress as `0x${string}`,
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
            console.log(`   ⚠️  transferFrom attempt ${attempt} failed (allowance not propagated), retrying in 1s...`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          throw err;
        }
      }

      txHash = transferHash;

      console.log('   ⏳ Waiting for transfer confirmation...');

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transferHash,
        confirmations: 1
      });

      console.log('   ✅ Transfer tx:', txHash);
      console.log('   ✅ Block number:', receipt.blockNumber);
      console.log('   ✅ Gas used:', receipt.gasUsed);
      console.log(`✅ Settlement complete on ${networkConfig.label}!\n`);
    } else {
      console.log('   ⚠️  SIMULATED MODE - Set ENABLE_REAL_SETTLEMENT=true for real transactions');

      // Simulate a transaction hash
      txHash = `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;

      console.log('   ✅ Simulated tx hash:', txHash);
      console.log('✅ Simulated settlement complete!\n');
    }

    // Mark nonce as settled to prevent replay
    nonceTracker.markSettled(network, owner, nonce);

    res.json({
      success: true,
      payer: owner,
      transaction: txHash,
      network,
    });

  } catch (error: any) {
    console.error('❌ Settlement error:', error);

    // Try to extract payer and network from request if possible
    let payer = 'unknown';
    let network = 'unknown';
    try {
      payer = req.body.paymentPayload?.payload?.authorization?.from || 'unknown';
      network = req.body.paymentPayload?.accepted?.network || 'unknown';
    } catch {}

    res.status(200).json({
      success: false,
      payer,
      transaction: '',
      network,
      errorReason: error.message,
    });
  }
}
