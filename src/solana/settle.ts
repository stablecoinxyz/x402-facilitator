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
import type { Logger } from 'pino';
import { config } from '../config';
import logger from '../lib/logger';

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
  paymentPayload: SolanaPaymentPayload,
  log: Logger = logger,
): Promise<{ success: boolean; payer: string; transaction: string; network: string; errorReason?: string }> {
  try {
    const { from, to, amount } = paymentPayload;

    log.debug({ from, to, amount, amountSBC: Number(amount) / 1e9 }, 'Delegated transfer (non-custodial)');

    // Create connection
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');

    // Load facilitator keypair from private key (Base58)
    if (!config.solanaFacilitatorPrivateKey) {
      throw new Error('SOLANA_FACILITATOR_PRIVATE_KEY not configured');
    }

    const secretKey = bs58.decode(config.solanaFacilitatorPrivateKey);
    const facilitatorKeypair = Keypair.fromSecretKey(secretKey);

    log.debug({ facilitator: facilitatorKeypair.publicKey.toBase58() }, 'Facilitator (delegate)');

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

    log.debug({ fromTokenAccount: fromTokenAccount.toBase58(), toTokenAccount: toTokenAccount.toBase58() }, 'Token accounts');

    // Create transfer instruction using FACILITATOR as authority (delegate)
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

    log.debug('Sending delegated transfer transaction');

    // Sign and send transaction (facilitator signs as delegate)
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [facilitatorKeypair],
      { commitment: 'confirmed' }
    );

    log.info({ txHash: signature, payer: from, to }, 'Delegated settlement complete');

    return {
      success: true,
      payer: from,
      transaction: signature,
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    };
  } catch (error: any) {
    log.error({ err: error, payer: paymentPayload.from }, 'Solana settlement error');
    return {
      success: false,
      payer: paymentPayload.from || 'unknown',
      transaction: '',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      errorReason: error.message,
    };
  }
}
