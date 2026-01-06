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
import { config } from '../config';

interface SolanaPaymentPayload {
  from: string;      // Base58 public key
  to: string;        // Base58 public key
  amount: string;    // Amount in base units (e.g., "50000000" = 0.05 SBC with 9 decimals)
  nonce: string;     // Timestamp or unique identifier
  deadline: number;  // Unix timestamp
  signature: string; // Base58 Ed25519 signature
}

interface PaymentRequirements {
  maxAmountRequired: string;
  payTo: string;
}

/**
 * Verify a Solana payment authorization
 */
export async function verifySolanaPayment(
  paymentPayload: SolanaPaymentPayload,
  paymentRequirements: PaymentRequirements
): Promise<{ isValid: boolean; payer: string; invalidReason: string | null }> {
  try {
    const { from, to, amount, nonce, deadline, signature } = paymentPayload;

    console.log('   From (Solana):', from);
    console.log('   To (Solana):', to);
    console.log('   Amount:', amount, `(${Number(amount) / 1e9} SBC)`);
    console.log('   Deadline:', new Date(deadline * 1000).toISOString());

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
        console.log('   ❌ Invalid Solana signature');
        return { isValid: false, payer: from, invalidReason: 'Invalid signature' };
      }

      console.log('   ✅ Signature valid (Ed25519)');
    } catch (error: any) {
      console.log('   ❌ Signature verification failed:', error.message);
      return { isValid: false, payer: from, invalidReason: 'Signature verification failed' };
    }

    // 2. Check deadline
    const now = Math.floor(Date.now() / 1000);
    if (now > deadline) {
      console.log('   ❌ Payment expired');
      return { isValid: false, payer: from, invalidReason: 'Payment expired' };
    }

    console.log('   ✅ Deadline valid');

    // 3. Check amount
    if (BigInt(amount) < BigInt(paymentRequirements.maxAmountRequired)) {
      console.log('   ❌ Insufficient amount');
      return { isValid: false, payer: from, invalidReason: 'Insufficient amount' };
    }

    console.log('   ✅ Amount sufficient');

    // 4. Check recipient
    if (to.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      console.log('   ❌ Invalid recipient');
      return { isValid: false, payer: from, invalidReason: 'Invalid recipient' };
    }

    console.log('   ✅ Recipient valid');

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

      console.log('   Checking SBC token account:', associatedTokenAddress.toBase58());

      const tokenAccountInfo = await connection.getTokenAccountBalance(associatedTokenAddress);
      const balance = BigInt(tokenAccountInfo.value.amount);

      console.log('   Sender SBC balance:', balance.toString(), `(${Number(balance) / 1e9} SBC)`);

      if (balance < BigInt(amount)) {
        console.log('   ❌ Insufficient SBC balance');
        return { isValid: false, payer: from, invalidReason: 'Insufficient SBC balance' };
      }

      console.log('   ✅ Balance sufficient');
    } catch (error: any) {
      console.log('   ❌ Error checking balance:', error.message);
      return { isValid: false, payer: from, invalidReason: `Balance check failed: ${error.message}` };
    }

    // All checks passed
    return { isValid: true, payer: from, invalidReason: null };
  } catch (error: any) {
    console.error('❌ Solana verification error:', error);
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
