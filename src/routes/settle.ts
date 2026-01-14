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

// Base Sepolia Chain Config
const baseSepolia = {
  id: 84532,
  name: 'Base Sepolia',
  network: 'base-sepolia',
  nativeCurrency: {
    decimals: 18,
    name: 'Sepolia Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['https://sepolia.base.org'],
    },
  },
  testnet: true,
};

// Radius Mainnet Chain Config
const radiusMainnet = {
  id: 723,
  name: 'Radius',
  network: 'radius',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [config.radiusRpcUrl],
    },
  },
  testnet: false,
};

// Radius Testnet Chain Config (rpcUrl set dynamically)
const radiusTestnet = {
  id: 72344,
  name: 'Radius Testnet',
  network: 'radius-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [config.radiusRpcUrl || ''],
    },
  },
  testnet: true,
};

export async function settlePayment(req: Request, res: Response) {
  try {
    const { paymentHeader, paymentRequirements } = req.body;

    console.log('\n💰 Settling payment...');

    // Decode payment header
    const paymentData = JSON.parse(
      Buffer.from(paymentHeader, 'base64').toString()
    );

    console.log('   Scheme:', paymentData.scheme);
    console.log('   Network:', paymentData.network);

    // Verify scheme is "exact"
    if (paymentData.scheme !== 'exact') {
      console.log('   ❌ Unsupported payment scheme');
      return res.json({
        success: false,
        payer: paymentData.payload?.from || 'unknown',
        transaction: '',
        network: paymentData.network || 'unknown',
        errorReason: `Unsupported scheme: ${paymentData.scheme}`
      });
    }

    // Route by network
    if (paymentData.network === 'solana-mainnet-beta') {
      console.log('   🟣 Solana settlement (delegated transfer)');
      const result = await settleSolanaPayment(paymentData.payload);
      console.log(result.success ? '✅ Settlement complete!\n' : '❌ Settlement failed!\n');
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
        success: false,
        payer: paymentData.payload?.from || 'unknown',
        transaction: '',
        network: paymentData.network || 'unknown',
        errorReason: `Unknown network: ${paymentData.network}`
      });
    }

    if (isBase) {
      console.log(isBaseSepolia ? '   🔵 Base Sepolia settlement' : '   🔵 Base Mainnet settlement');
    } else if (isRadius) {
      console.log(isRadiusTestnet ? '   🟢 Radius Testnet settlement' : '   🟢 Radius Mainnet settlement');
    }

    // Extract permit data (x402 V2 format)
    const { permit, recipient, signature, v, r, s } = paymentData.payload;

    if (!permit) {
      console.log('   ❌ Missing permit data');
      return res.json({
        success: false,
        payer: 'unknown',
        transaction: '',
        network: paymentData.network,
        errorReason: 'Missing permit data in payload'
      });
    }

    const { owner, spender, value, nonce, deadline } = permit;

    console.log('   Owner (Payer):', owner);
    console.log('   Spender (Facilitator):', spender);
    console.log('   Recipient (Merchant):', recipient);
    console.log('   Value:', value);
    console.log('   Deadline:', new Date(Number(deadline) * 1000).toISOString());

    // Select chain config and credentials based on network
    let chain, rpcUrl, chainName, privateKey;
    if (isBaseSepolia) {
      chain = baseSepolia;
      rpcUrl = 'https://sepolia.base.org';
      chainName = 'Base Sepolia';
      privateKey = config.baseFacilitatorPrivateKey;
    } else if (isBaseMainnet) {
      chain = baseMainnet;
      rpcUrl = config.baseRpcUrl;
      chainName = 'Base Mainnet';
      privateKey = config.baseFacilitatorPrivateKey;
    } else if (isRadiusTestnet) {
      if (!config.radiusRpcUrl) {
        throw new Error('RADIUS_RPC_URL is required for Radius Testnet. Set it in your .env file.');
      }
      if (!config.radiusFacilitatorPrivateKey) {
        throw new Error('RADIUS_FACILITATOR_PRIVATE_KEY is required for Radius. Set it in your .env file.');
      }
      chain = radiusTestnet;
      rpcUrl = config.radiusRpcUrl;
      chainName = 'Radius Testnet';
      privateKey = config.radiusFacilitatorPrivateKey;
    } else if (isRadiusMainnet) {
      if (!config.radiusRpcUrl) {
        throw new Error('RADIUS_RPC_URL is required for Radius Mainnet. Set it in your .env file.');
      }
      if (!config.radiusFacilitatorPrivateKey) {
        throw new Error('RADIUS_FACILITATOR_PRIVATE_KEY is required for Radius. Set it in your .env file.');
      }
      chain = radiusMainnet;
      rpcUrl = config.radiusRpcUrl;
      chainName = 'Radius Mainnet';
      privateKey = config.radiusFacilitatorPrivateKey;
    } else {
      chain = baseMainnet;
      rpcUrl = config.baseRpcUrl;
      chainName = 'Base Mainnet';
      privateKey = config.baseFacilitatorPrivateKey;
    }

    // Create facilitator account
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    // Create wallet client
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    // Create public client
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    console.log(`   Executing transfer on ${chainName}...`);

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

      // Use correct SBC token address for network
      let sbcTokenAddress: string;
      if (isBaseSepolia) {
        sbcTokenAddress = '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16';  // Base Sepolia (6 decimals)
      } else if (isBase) {
        sbcTokenAddress = config.baseSbcTokenAddress;  // Base Mainnet
      } else if (isRadius) {
        if (!config.radiusSbcTokenAddress) {
          throw new Error('RADIUS_SBC_TOKEN_ADDRESS is required for Radius. Set it in your .env file.');
        }
        sbcTokenAddress = config.radiusSbcTokenAddress;  // Radius
      } else {
        sbcTokenAddress = config.baseSbcTokenAddress;
      }

      console.log('   Token:', sbcTokenAddress);

      // Step 1: Call permit() to approve the facilitator
      console.log('   📝 Step 1: Calling permit()...');
      console.log('      owner:', owner);
      console.log('      spender:', spender);
      console.log('      value:', value);
      console.log('      deadline:', deadline);

      const permitHash = await walletClient.writeContract({
        address: sbcTokenAddress as `0x${string}`,
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
        ]
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
        address: sbcTokenAddress as `0x${string}`,
        abi: ERC20_PERMIT_ABI,
        functionName: 'transferFrom',
        args: [
          owner as `0x${string}`,      // Payer
          recipient as `0x${string}`,  // Merchant
          BigInt(value)
        ]
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
      console.log(`✅ Settlement complete on ${chainName}!\n`);
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
      network: paymentData.network,
    });

  } catch (error: any) {
    console.error('❌ Settlement error:', error);

    // Try to extract payer and network from request if possible
    let payer = 'unknown';
    let network = 'unknown';
    try {
      const paymentData = JSON.parse(Buffer.from(req.body.paymentHeader, 'base64').toString());
      payer = paymentData.payload?.permit?.owner || 'unknown';
      network = paymentData.network || 'unknown';
    } catch {}

    res.status(500).json({
      success: false,
      payer,
      transaction: '',
      network,
      errorReason: error.message,
    });
  }
}
