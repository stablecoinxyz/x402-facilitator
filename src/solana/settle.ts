/**
 * Solana Payment Settlement
 *
 * Executes SPL token transfers on Solana mainnet
 * - Creates and sends SPL token transfer instruction
 * - Transfers SBC tokens from payer to recipient
 * - Returns transaction signature
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../config';

interface SolanaPaymentPayload {
  from: string;      // Base58 public key (payer)
  to: string;        // Base58 public key (recipient)
  amount: string;    // Amount in base units
}

/**
 * Settle a Solana payment using delegated SPL token transfer
 *
 * Architecture: Agent → Merchant (facilitator executes via delegation)
 * - Agent has pre-approved facilitator as delegate (one-time setup)
 * - Facilitator executes transfer FROM agent TO merchant
 * - Facilitator NEVER holds customer funds
 * - Same pattern as Base ERC-20 transferFrom()
 */
export async function settleSolanaPayment(
  paymentPayload: SolanaPaymentPayload
): Promise<{ success: boolean; payer: string; transaction: string; network: string; errorReason?: string }> {
  try {
    const { from, to, amount } = paymentPayload;

    console.log('   💳 DELEGATED TRANSFER (Non-Custodial)');
    console.log('   From (Agent):', from);
    console.log('   To (Merchant):', to);
    console.log('   Amount:', amount, `(${Number(amount) / 1e9} SBC)`);

    // Create connection
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');

    // Load facilitator keypair from private key (Base58)
    if (!config.solanaFacilitatorPrivateKey) {
      throw new Error('SOLANA_FACILITATOR_PRIVATE_KEY not configured');
    }

    const secretKey = bs58.decode(config.solanaFacilitatorPrivateKey);
    const facilitatorKeypair = Keypair.fromSecretKey(secretKey);

    console.log('   Facilitator (Delegate):', facilitatorKeypair.publicKey.toBase58());

    // Parse addresses
    const fromPublicKey = new PublicKey(from);
    const toPublicKey = new PublicKey(to);
    const mintPublicKey = new PublicKey(config.sbcTokenAddress);

    // Get associated token accounts
    const fromTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      fromPublicKey
    );

    const toTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      toPublicKey
    );

    console.log('   From token account:', fromTokenAccount.toBase58());
    console.log('   To token account:', toTokenAccount.toBase58());

    // Create transfer instruction using FACILITATOR as authority (delegate)
    // This works because agent has pre-approved facilitator as delegate
    const transferInstruction = createTransferInstruction(
      fromTokenAccount,                 // Source (agent's token account)
      toTokenAccount,                   // Destination (merchant's token account)
      facilitatorKeypair.publicKey,     // Authority (facilitator as delegate)
      BigInt(amount)                    // Amount
    );

    // Create transaction
    const transaction = new Transaction().add(transferInstruction);

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = facilitatorKeypair.publicKey;

    console.log('   ⏳ Sending delegated transfer transaction...');

    // Sign and send transaction (facilitator signs as delegate)
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [facilitatorKeypair],
      { commitment: 'confirmed' }
    );

    console.log('   ✅ Transaction confirmed:', signature);
    console.log('   🔗 Explorer:', `https://orb.helius.dev/tx/${signature}?cluster=mainnet-beta&tab=summary`);
    console.log('   💡 Tokens flowed: Agent → Merchant (facilitator never held funds)');
    console.log('✅ Delegated settlement complete!\n');

    return {
      success: true,
      payer: from,
      transaction: signature,
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    };
  } catch (error: any) {
    console.error('❌ Solana settlement error:', error);
    console.error('   💡 If error mentions "insufficient funds" or "owner mismatch", the agent needs to:');
    console.error('   1. Approve facilitator as delegate: npm run approve-solana-facilitator');
    console.error('   2. Ensure agent has sufficient SBC token balance');
    return {
      success: false,
      payer: paymentPayload.from || 'unknown',
      transaction: '',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      errorReason: error.message,
    };
  }
}

