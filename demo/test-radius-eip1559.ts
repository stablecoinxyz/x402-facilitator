/**
 * Test: Can Radius handle EIP-1559 (type 2) transactions?
 *
 * Sends a minimal balanceOf read and a real SBC transfer to verify
 * that viem's default EIP-1559 fee estimation works on Radius.
 *
 * Usage: npx ts-node demo/test-radius-eip1559.ts
 */

import { createPublicClient, createWalletClient, http, defineChain, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../src/config';

const BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
] as const;

const TRANSFER_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
] as const;

async function main() {
  console.log('=== Radius EIP-1559 Compatibility Test ===\n');

  const rpcUrl = config.radiusRpcUrl;
  const chainId = config.radiusChainId;
  const sbcToken = config.radiusSbcTokenAddress as `0x${string}`;
  const pk = config.radiusFacilitatorPrivateKey;

  if (!pk) {
    console.error('❌ RADIUS_FACILITATOR_PRIVATE_KEY not set');
    process.exit(1);
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  console.log('Facilitator:', account.address);
  console.log('RPC:', rpcUrl);
  console.log('Chain ID:', chainId);
  console.log('SBC Token:', sbcToken);

  const chain = defineChain({
    id: chainId,
    name: 'Radius',
    nativeCurrency: { decimals: 18, name: 'RUSD', symbol: 'RUSD' },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // Test 1: Read-only call (eth_call)
  console.log('\n--- Test 1: eth_call (balanceOf) ---');
  try {
    const balance = await publicClient.readContract({
      address: sbcToken,
      abi: BALANCE_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });
    console.log(`✅ SBC Balance: ${formatUnits(balance, 6)} SBC`);
  } catch (err: any) {
    console.log('❌ eth_call failed:', err.message);
  }

  // Test 2: RUSD balance
  console.log('\n--- Test 2: RUSD (native) balance ---');
  try {
    const rusd = await publicClient.getBalance({ address: account.address });
    console.log(`✅ RUSD Balance: ${formatUnits(rusd, 18)} RUSD`);
  } catch (err: any) {
    console.log('❌ getBalance failed:', err.message);
  }

  // Test 3: Gas estimation WITHOUT gasPrice (viem will try EIP-1559)
  console.log('\n--- Test 3: estimateContractGas (EIP-1559 default, no gasPrice) ---');
  try {
    const gas = await publicClient.estimateContractGas({
      address: sbcToken,
      abi: BALANCE_ABI,
      functionName: 'balanceOf',
      args: [account.address],
      account: account.address,
    });
    console.log(`✅ Gas estimate: ${gas}`);
  } catch (err: any) {
    console.log('❌ estimateContractGas (EIP-1559) failed:', err.message);
  }

  // Test 4: Gas estimation WITH gasPrice (legacy)
  console.log('\n--- Test 4: estimateContractGas (legacy, explicit gasPrice) ---');
  try {
    const gasPrice = await publicClient.getGasPrice();
    console.log(`   gasPrice from RPC: ${gasPrice} (${formatUnits(gasPrice, 9)} gwei)`);
    const gas = await publicClient.estimateContractGas({
      address: sbcToken,
      abi: BALANCE_ABI,
      functionName: 'balanceOf',
      args: [account.address],
      account: account.address,
      gasPrice: gasPrice + 1000000000n,
    });
    console.log(`✅ Gas estimate (legacy): ${gas}`);
  } catch (err: any) {
    console.log('❌ estimateContractGas (legacy) failed:', err.message);
  }

  // Test 5: Actual self-transfer (0 SBC) — EIP-1559 (no gasPrice override)
  console.log('\n--- Test 5: writeContract (EIP-1559 default — real tx, 0 SBC self-transfer) ---');
  try {
    const hash = await walletClient.writeContract({
      address: sbcToken,
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [account.address, 0n],
      // NO gasPrice — let viem use EIP-1559
    });
    console.log(`✅ EIP-1559 tx sent: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}, type: ${receipt.type}`);
  } catch (err: any) {
    console.log('❌ EIP-1559 tx failed:', err.message);
  }

  // Test 6: Actual self-transfer (0 SBC) — Legacy (with gasPrice)
  console.log('\n--- Test 6: writeContract (legacy — real tx, 0 SBC self-transfer) ---');
  try {
    const gasPrice = await publicClient.getGasPrice();
    const hash = await walletClient.writeContract({
      address: sbcToken,
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [account.address, 0n],
      gasPrice: gasPrice + 1000000000n,
    });
    console.log(`✅ Legacy tx sent: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}, type: ${receipt.type}`);
  } catch (err: any) {
    console.log('❌ Legacy tx failed:', err.message);
  }

  // Test 7: EIP-1559 with explicit non-zero fees
  // Distinguishes "Radius rejects all type 2" from "Radius rejects zero priority fee"
  console.log('\n--- Test 7: writeContract (EIP-1559 with explicit fees — real tx) ---');
  try {
    const gasPrice = await publicClient.getGasPrice();
    const maxFee = gasPrice * 2n; // 2x current gas price — definitely not "too low"
    const maxPriority = gasPrice; // non-zero priority fee
    console.log(`   maxFeePerGas: ${formatUnits(maxFee, 9)} gwei`);
    console.log(`   maxPriorityFeePerGas: ${formatUnits(maxPriority, 9)} gwei`);
    const hash = await walletClient.writeContract({
      address: sbcToken,
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [account.address, 0n],
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxPriority,
      gas: 100000n, // explicit gas limit to bypass estimation
    });
    console.log(`✅ EIP-1559 (explicit fees) tx sent: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}, type: ${receipt.type}`);
  } catch (err: any) {
    console.log('❌ EIP-1559 (explicit fees) tx failed:', err.message?.split('\n').slice(0, 3).join('\n'));
  }

  // Test 8: estimateGas for a WRITE function (transfer, not balanceOf)
  // Our actual use case is estimating gas for permit(), a write function
  console.log('\n--- Test 8: estimateContractGas for transfer (write fn, legacy gasPrice) ---');
  try {
    const gasPrice = await publicClient.getGasPrice();
    const gas = await publicClient.estimateContractGas({
      address: sbcToken,
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [account.address, 0n],
      account: account.address,
      gasPrice: gasPrice + 1000000000n,
    });
    console.log(`✅ Gas estimate (write fn): ${gas}`);
  } catch (err: any) {
    console.log('❌ estimateContractGas (write fn) failed:', err.message?.split('\n').slice(0, 3).join('\n'));
  }

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
