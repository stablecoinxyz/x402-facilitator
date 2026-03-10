/**
 * Solana Payment Verification
 *
 * Verifies Solana x402 payments:
 * - Ed25519 signature verification
 * - SPL token balance checks (SBC)
 * - Deadline validation
 * - Amount validation
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { Logger } from 'pino';
import { config } from '../config';
import logger from '../lib/logger';

interface SolanaPaymentPayload {
  from: string;      // Base58 public key
  to: string;        // Base58 public key
  amount: string;    // Amount in base units (e.g., "50000000" = 0.05 SBC with 9 decimals)
  nonce: string;     // Timestamp or unique identifier
  deadline: number;  // Unix timestamp
  signature: string; // Base58 Ed25519 signature
}

interface PaymentRequirements {
  amount: string;
  maxAmountRequired?: string; // v1 compat
  payTo: string;
}

/**
 * Verify a Solana payment authorization
 */
export async function verifySolanaPayment(
  paymentPayload: SolanaPaymentPayload,
  paymentRequirements: PaymentRequirements,
  log: Logger = logger,
): Promise<{ isValid: boolean; payer: string; invalidReason: string | null }> {
  try {
    const { from, to, amount, nonce, deadline, signature } = paymentPayload;

    log.debug({ from, to, amount, amountSBC: Number(amount) / 1e9, deadline: new Date(deadline * 1000).toISOString() }, 'Solana verify details');

    // 1. Verify signature (Ed25519)
    try {
      // Reconstruct message that was signed
      const message = constructMessage({ from, to, amount, nonce, deadline });
      const messageBytes = Buffer.from(message);
      const signatureBytes = bs58.decode(signature);
      const publicKeyBytes = bs58.decode(from);

      const isValidSig = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes
      );

      if (!isValidSig) {
        log.warn({ payer: from }, 'Invalid Solana signature');
        return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_signature' };
      }

      log.debug('Signature valid (Ed25519)');
    } catch (error: any) {
      log.warn({ err: error, payer: from }, 'Signature verification failed');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_signature' };
    }

    // 2. Check deadline
    const now = Math.floor(Date.now() / 1000);
    if (now > deadline) {
      log.warn({ payer: from }, 'Payment expired');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before' };
    }

    log.debug('Deadline valid');

    // 3. Check amount
    const requiredAmount = paymentRequirements.amount ?? paymentRequirements.maxAmountRequired ?? '0';
    if (BigInt(amount) < BigInt(requiredAmount)) {
      log.warn({ payer: from, amount, required: requiredAmount }, 'Insufficient amount');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch' };
    }

    log.debug('Amount sufficient');

    // 4. Check recipient
    if (to.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      log.warn({ payer: from, to, expected: paymentRequirements.payTo }, 'Invalid recipient');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_recipient_mismatch' };
    }

    log.debug('Recipient valid');

    // 5. Check on-chain SBC token balance
    try {
      const connection = new Connection(config.solanaRpcUrl, 'confirmed');
      const fromPublicKey = new PublicKey(from);
      const mintPublicKey = new PublicKey(config.sbcTokenAddress);

      // Get associated token account
      const associatedTokenAddress = await getAssociatedTokenAddress(
        mintPublicKey,
        fromPublicKey
      );

      log.debug({ tokenAccount: associatedTokenAddress.toBase58() }, 'Checking SBC token account');

      const tokenAccountInfo = await connection.getTokenAccountBalance(associatedTokenAddress);
      const balance = BigInt(tokenAccountInfo.value.amount);

      log.debug({ balance: balance.toString(), balanceSBC: Number(balance) / 1e9 }, 'Sender SBC balance');

      if (balance < BigInt(amount)) {
        log.warn({ payer: from, balance: balance.toString(), required: amount }, 'Insufficient SBC balance');
        return { isValid: false, payer: from, invalidReason: 'insufficient_funds' };
      }

      log.debug('Balance sufficient');
    } catch (error: any) {
      log.warn({ err: error, payer: from }, 'Error checking balance');
      return { isValid: false, payer: from, invalidReason: `Balance check failed: ${error.message}` };
    }

    // All checks passed
    return { isValid: true, payer: from, invalidReason: null };
  } catch (error: any) {
    log.error({ err: error }, 'Solana verification error');
    return { isValid: false, payer: paymentPayload.from || 'unknown', invalidReason: `Verification error: ${error.message}` };
  }
}

/**
 * Construct the message that should be signed
 * This must match exactly what the client signs
 *
 * Format: "from:{from}|to:{to}|amount:{amount}|nonce:{nonce}|deadline:{deadline}"
 */
function constructMessage(data: {
  from: string;
  to: string;
  amount: string;
  nonce: string;
  deadline: number;
}): string {
  return `from:${data.from}|to:${data.to}|amount:${data.amount}|nonce:${data.nonce}|deadline:${data.deadline}`;
}
