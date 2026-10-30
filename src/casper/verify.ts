/**
 * Casper Payment Verification
 *
 * Verifies Casper x402 payments:
 * - Casper address validation (account-hash / public key forms)
 * - Amount validation in motes (exact BigInt math, no float truncation)
 * - Recipient validation
 * - Deadline validation
 * - Signature and on-chain wCSPR balance checks are delegated to the Casper
 *   facilitator service (see casper/client.ts), which holds the CSPR RPC
 *   credentials and the CEP-18 read path.
 */

import type { Logger } from 'pino';
import { config } from '../config';
import logger from '../lib/logger';
import { verifyWithCasperFacilitator } from './client';
import {
  isValidCasperAddress,
  isSameCasperAddress,
  parseMotes,
  motesToCspr,
  resolveCasperNetwork,
} from './networks';

interface CasperPaymentPayload {
  from: string;      // account-hash-... or hex public key (payer)
  to: string;        // account-hash-... or hex public key (recipient)
  amount: string;    // Amount in motes (e.g. "50000000" = 0.05 wCSPR, 9 decimals)
  nonce: string;     // Unique identifier
  deadline: number | string; // Unix timestamp (seconds); required
  signature: string; // Hex-encoded signature over the payment authorization
}

interface PaymentRequirements {
  amount: string;
  maxAmountRequired?: string; // v1 compat
  payTo: string;
  asset?: string;
  network?: string;
}

/**
 * Local checks shared by /verify and /settle: network, addresses, amount,
 * recipient and validity window. /settle runs them itself because it cannot
 * rely on /verify having run (the spec has flows where it never does, and the
 * two requests are not linked even when it does). Returns the invalid reason,
 * or null when the payment passes. The Casper facilitator service remains the
 * authority on the signature and on-chain balance.
 */
export function checkCasperPayment(
  paymentPayload: Partial<CasperPaymentPayload>,
  paymentRequirements: Partial<PaymentRequirements>,
  network: string,
  log: Logger = logger,
): string | null {
  const from = paymentPayload?.from || 'unknown';
  const { to, amount, deadline } = paymentPayload ?? {};

  // 1. Network must be one we advertise
  if (!resolveCasperNetwork(network)) {
    log.warn({ network }, 'Unknown Casper network');
    return 'invalid_network';
  }

  // 2. Validate address forms before anything hits the network
  if (!isValidCasperAddress(from)) {
    log.warn({ payer: from }, 'Invalid Casper payer address');
    return 'invalid_exact_evm_payload_signature';
  }
  if (!isValidCasperAddress(to)) {
    log.warn({ payer: from, to }, 'Invalid Casper recipient address');
    return 'invalid_exact_evm_payload_recipient_mismatch';
  }

  // 3. Amount — motes are integers, sub-mote precision is an error
  let authorized: bigint;
  let required: bigint;
  try {
    authorized = parseMotes(amount);
    required = parseMotes(paymentRequirements?.amount ?? paymentRequirements?.maxAmountRequired ?? '0');
  } catch (error: any) {
    log.warn({ err: error, payer: from, amount }, 'Invalid Casper amount');
    return 'invalid_exact_evm_payload_authorization_value_mismatch';
  }
  if (authorized < required) {
    log.warn({ payer: from, amount, required: required.toString(), amountCSPR: motesToCspr(authorized) }, 'Insufficient amount');
    return 'invalid_exact_evm_payload_authorization_value_mismatch';
  }

  // 4. Recipient
  if (!isSameCasperAddress(to, paymentRequirements?.payTo)) {
    log.warn({ payer: from, to, expected: paymentRequirements?.payTo }, 'Invalid recipient');
    return 'invalid_exact_evm_payload_recipient_mismatch';
  }

  // 5. Validity window. A missing or malformed deadline is rejected, never
  // treated as "does not expire". JSON clients may send it as a digit string.
  const expiry = parseDeadline(deadline);
  if (expiry === null) {
    log.warn({ payer: from, deadline }, 'Missing or malformed Casper deadline');
    return 'invalid_exact_evm_payload_authorization_valid_before';
  }
  if (Math.floor(Date.now() / 1000) > expiry) {
    log.warn({ payer: from }, 'Payment expired');
    return 'invalid_exact_evm_payload_authorization_valid_before';
  }

  return null;
}

/** Unix-seconds deadline as a safe integer, or null when missing or malformed. */
function parseDeadline(deadline: unknown): number | null {
  const value = typeof deadline === 'string' && /^\d+$/.test(deadline) ? Number(deadline) : deadline;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Verify a Casper payment authorization.
 */
export async function verifyCasperPayment(
  paymentPayload: CasperPaymentPayload,
  paymentRequirements: PaymentRequirements,
  network: string,
  log: Logger = logger,
): Promise<{ isValid: boolean; payer: string; invalidReason: string | null }> {
  const from = paymentPayload?.from || 'unknown';

  try {
    log.debug({ from, to: paymentPayload?.to, amount: paymentPayload?.amount, network }, 'Casper verify details');

    const invalidReason = checkCasperPayment(paymentPayload, paymentRequirements, network, log);
    if (invalidReason) return { isValid: false, payer: from, invalidReason };

    // Signature + on-chain wCSPR balance are verified by the Casper facilitator
    const result = await verifyWithCasperFacilitator(
      { x402Version: 2, accepted: { scheme: 'exact', network }, payload: paymentPayload, extensions: {} },
      { ...paymentRequirements, network, asset: paymentRequirements.asset ?? casperAsset(network) },
      log,
    );

    return {
      isValid: Boolean(result.isValid),
      payer: result.payer || from,
      invalidReason: result.isValid ? null : result.invalidReason ?? 'invalid_exact_evm_payload_signature',
    };
  } catch (error: any) {
    log.error({ err: error, payer: from }, 'Casper verification error');
    return { isValid: false, payer: from, invalidReason: `Verification error: ${error.message}` };
  }
}

/** Default settlement asset (wCSPR contract) for a Casper network. */
export function casperAsset(network: string): string {
  if (network === 'casper:casper') return config.casperWcsprContract;
  if (network === 'casper:casper-test') return config.casperTestnetWcsprContract;
  return '';
}
