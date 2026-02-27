import { Request, Response } from 'express';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config';
import { settleSolanaPayment } from '../solana/settle';

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

export async function settlePayment(req: Request, res: Response) {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    console.log('\n💰 Settling payment...');

    if (!paymentPayload) {
      return res.status(400).json({
        success: false,
        payer: 'unknown',
        transaction: '',
        network: 'unknown',
        errorReason: 'Missing paymentPayload',
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
        success: false,
        payer: paymentPayload.payload?.authorization?.from || 'unknown',
        transaction: '',
        network: network || 'unknown',
        errorReason: `Unsupported scheme: ${scheme}`
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
        errorReason: `Unknown network: ${network}`
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
        errorReason: 'Missing authorization data in payload'
      });
    }

    const owner = authorization.from;
    const spender = authorization.to;
    const value = authorization.value;
    const deadline = authorization.validBefore;
    const recipient = paymentRequirements.payTo;

    // Derive v, r, s from compact signature for on-chain permit()
    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    const v = parseInt(signature.slice(130, 132), 16);

    console.log('   Owner (Payer):', owner);
    console.log('   Spender (Facilitator):', spender);
    console.log('   Recipient (Merchant):', recipient);
    console.log('   Value:', value);
    console.log('   Deadline:', new Date(Number(deadline) * 1000).toISOString());

    if (!networkConfig.privateKey) {
      throw new Error(`Facilitator private key not configured for ${networkConfig.label}. Set the appropriate env var in .env.`);
    }

    // Build chain object for viem
    const chain = {
      id: networkConfig.chainId,
      name: networkConfig.label,
      network,
      nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
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

    // Create public client
    const publicClient = createPublicClient({
      chain,
      transport: http(networkConfig.rpcUrl),
    });

    // Fetch pending nonce once — use explicitly to avoid stale nonce between permit + transferFrom
    const pendingNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });

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
      });

      console.log('   ⏳ Waiting for permit confirmation...');
      await publicClient.waitForTransactionReceipt({
        hash: permitHash,
        confirmations: 1
      });
      console.log('   ✅ Permit tx:', permitHash);

      // Step 2: Call transferFrom() to move tokens to merchant
      console.log('   📝 Step 2: Calling transferFrom()...');
      console.log('      from:', owner);
      console.log('      to:', recipient);
      console.log('      amount:', value);

      const transferHash = await walletClient.writeContract({
        address: networkConfig.sbcTokenAddress as `0x${string}`,
        abi: ERC20_PERMIT_ABI,
        functionName: 'transferFrom',
        args: [
          owner as `0x${string}`,      // Payer
          recipient as `0x${string}`,  // Merchant
          BigInt(value)
        ],
        nonce: pendingNonce + 1,
      });

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
