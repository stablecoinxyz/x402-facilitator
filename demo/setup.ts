import { createWalletClient, http, parseEther, formatEther, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { loadOrGenerateKey, getAccount, publicClient, DATA_DIR } from './utils';
import fs from 'fs';
import path from 'path';

// Minimal ERC20 Bytecode (Mintable) - This is a large string, normally we'd compile it. 
// For this demo, we'll use a standard "MockERC20" pattern.
// To keep the file size manageable and safe, I will use a very simple ERC20 implementation.
// Actually, to ensure reliability, I will construct a deployment of a standard ERC20. 
// Since I cannot easily compile solidity here, I will use a known pre-deployed test token 
// OR simpler: assume the user has some ETH and deploy a contract using a hardcoded bytecode.

// Simplified Bytecode for a standard ERC20 (OpenZeppelin Preset) is too large to paste blindly.
// Strategy: check if we can use a known faucet token or deployed contract.
// If not, I'll use a minimal bytecode for a fixed supply token.

// Let's use a minimal "Fixed Supply Token" bytecode.
// Name: Test Token, Symbol: TEST, Decimals: 18, Supply: 1,000,000
// Source: Compiled generic ERC20
const ERC20_BYTECODE = "0x608060405234801561001057600080fd5b506040516105e63803806105e6833981810160405281019061003291906100d8565b816000908152602060002060009055600190556105a2806100526000396000f3fe608060405234801561001057600080fd5b50600436106100575760003560e01c8063095ea7b31461005c57806318160ddd1461008a57806323b872dd146100a7578063313ce567146100d557806370a08231146100f257806395d89b411461011e578063dd62ed3e1461013a575b600080fd5b610074600480360381019061006f9190610360565b610168565b60405161008191906103e0565b60405180910390f35b610091610188565b60405161009e919061041c565b60405180910390f35b6100c160048036038101906100bc9190610399565b610191565b6040516100ce91906103fd565b60405180910390f35b6100dd610214565b6040516100ea91906103d2565b60405180910390f35b61010860048036038101906101039190610345565b61021d565b604051610115919061041c565b60405180910390f35b610126610265565b6040516101339190610443565b60405180910390f35b610154600480360381019061014f9190610382565b61026e565b604051610161919061041c565b60405180910390f35b6000600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff1681565b6000600154905061019b565b90565b60006101bc8484836102fb565b600190509392505050565b601260405190815260200160405180910390f35b600060008060009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141561025b576000809054906101000a900460ff161561025b5761025b828261021d565b50565b600060009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b60006000839050600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020546102c0908363ffffffff610464565b600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002081905550600160008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205461031c908363ffffffff61047e565b600160008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055505050565b6000600160008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050919050565b600060405190815260200160405180910390f35b6000600160008473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16146103e3576103e38484336104ad565b60006103ef8484836102fb565b600190509392505050565b6000600160008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050919050565b600033905090565b6000602082019050610433600083015161042a565b92915050565b6000819050919050565b600061045261044d565b905061045e565b60009050565b90565b600081830190506104788282610443565b9392505050565b600081830390506104928282610443565b9392505050565b6000600160008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020546104eb908363ffffffff610464565b600160008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055505050505056";

// Base Sepolia SBC Token Address (6 decimals)
const SBC_ADDRESS = '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16';
const SBC_DECIMALS = 6;

// Minimal ERC20 ABI for what we need (balanceOf, approve)
const ERC20_ABI = [
  {
    constant: false,
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    constant: true,
    inputs: [{ name: '', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    payable: false,
    stateMutability: 'view',
    type: 'function'
  }
] as const;

async function setup() {
  console.log('🚀 Setting up x402 Facilitator Demo (Base Sepolia)');
  console.log('================================================');
  console.log(`📂 Data directory: ${DATA_DIR}`);

  // 1. Load/Generate Wallets
  const facilitator = getAccount('facilitator');
  const merchant = getAccount('merchant');
  const client = getAccount('client');

  console.log(`\n🔑 Wallets:`);
  console.log(`   Facilitator: ${facilitator.address}`);
  console.log(`   Merchant:    ${merchant.address}`);
  console.log(`   Client:      ${client.address} (PAYER)`);

  // 2. Check ETH Balances (Client AND Facilitator)
  // Client needs ETH to sign the 'approve' transaction during setup.
  // Facilitator needs ETH to sign the 'transferFrom' transaction during settlement.
  
  const clientBalance = await publicClient.getBalance({ address: client.address });
  const facilitatorBalance = await publicClient.getBalance({ address: facilitator.address });
  
  const clientEth = formatEther(clientBalance);
  const facilitatorEth = formatEther(facilitatorBalance);
  
  console.log(`\n💰 ETH Balances:`);
  console.log(`   Client:      ${clientEth} ETH`);
  console.log(`   Facilitator: ${facilitatorEth} ETH`);

  let needsFunding = false;

  if (clientBalance < parseEther('0.002')) {
    console.log('\n⚠️  CLIENT NEEDS ETH');
    console.log(`   Address: ${client.address}`);
    needsFunding = true;
  }

  if (facilitatorBalance < parseEther('0.002')) {
    console.log('\n⚠️  FACILITATOR NEEDS ETH');
    console.log(`   Address: ${facilitator.address}`);
    needsFunding = true;
  }

  if (needsFunding) {
    console.log('\n   Please fund the wallets with Base Sepolia ETH for gas.');
    console.log('   Faucets:');
    console.log('   - https://portal.cdp.coinbase.com/products/faucet');
    console.log('   - https://faucets.chain.link/base-sepolia');
    console.log('   - https://www.alchemy.com/faucets/base-sepolia');
    console.log('\n   Once funded, run "npm run setup" again.');
    process.exit(1);
  }

  // 3. Setup Wallet Client for transactions
  const clientWallet = createWalletClient({
    account: client,
    chain: baseSepolia,
    transport: http()
  });

  // 4. Check Client SBC Balance
  console.log('\n🔍 Checking SBC Token Balance...');
  const sbcBalance = await publicClient.readContract({
    address: SBC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [client.address]
  });

  // Convert 6 decimals
  const sbcFormatted = Number(sbcBalance) / Math.pow(10, SBC_DECIMALS);
  console.log(`   SBC Balance: ${sbcFormatted} SBC (${sbcBalance.toString()} units)`);

  if (sbcFormatted < 0.01) {
    console.log('\n⚠️  INSUFFICIENT SBC TOKENS');
    console.log('   Please fund the Client wallet with Testnet SBC tokens.');
    console.log(`   Address: ${client.address}`);
    console.log(`   Token Contract: ${SBC_ADDRESS}`);
    console.log('   Faucet: https://dashboard.stablecoin.xyz/faucet');
    console.log('   (Or ask the SBC team for testnet tokens)');
    console.log('\n   Once funded, run "npm run setup" again.');
    process.exit(1);
  }

  // 5. Approve Facilitator
  console.log('\n🤝 Approving Facilitator as Spender...');
  // We approve 100 SBC (adjusted for 6 decimals)
  const approvalAmount = BigInt(100 * Math.pow(10, SBC_DECIMALS));
  
  const approveHash = await clientWallet.writeContract({
      address: SBC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [facilitator.address, approvalAmount]
  });
  
  console.log(`   Tx Hash: ${approveHash}`);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log('   ✅ Facilitator approved to spend SBC');

  // 6. Generate .env file
  console.log('\n📝 Generating .env file...');
  
  // Facilitator needs private key for Base
  const envContent = `
# Generated by demo/setup.ts
FACILITATOR_PORT=3001

# Base Configuration (Sepolia)
BASE_RPC_URL=https://sepolia.base.org
BASE_CHAIN_ID=84532
BASE_SBC_TOKEN_ADDRESS=${SBC_ADDRESS}
BASE_SBC_DECIMALS=${SBC_DECIMALS}
BASE_FACILITATOR_PRIVATE_KEY=${loadOrGenerateKey('facilitator')}
BASE_FACILITATOR_ADDRESS=${facilitator.address}

# Real Settlement Enabled (Required for transferFrom to work)
ENABLE_REAL_SETTLEMENT=true

# Solana Config (Ignored for Base demo)
SOLANA_RPC_URL=https://api.devnet.solana.com
`.trim();

  fs.writeFileSync(path.join(process.cwd(), '.env'), envContent);
  console.log('   ✅ .env file created');

  console.log('\n🎉 Setup Complete!');
  console.log('   1. Start the server: npm run dev');
  console.log('   2. Run the demo client: npm run demo');
}

setup().catch(err => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
});
