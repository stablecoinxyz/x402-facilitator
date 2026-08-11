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
  deadline: number;  // Unix timestamp
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
    const { to, amount, deadline } = paymentPayload;

    log.debug({ from, to, amount, network }, 'Casper verify details');

    // 1. Network must be one we advertise
    const networkConfig = resolveCasperNetwork(network);
    if (!networkConfig) {
      log.warn({ network }, 'Unknown Casper network');
      return { isValid: false, payer: from, invalidReason: 'invalid_network' };
    }

    // 2. Validate address forms before anything hits the network
    if (!isValidCasperAddress(from)) {
      log.warn({ payer: from }, 'Invalid Casper payer address');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_signature' };
    }
    if (!isValidCasperAddress(to)) {
      log.warn({ payer: from, to }, 'Invalid Casper recipient address');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_recipient_mismatch' };
    }

    // 3. Check amount — motes are integers, sub-mote precision is an error
    let authorized: bigint;
    let required: bigint;
    try {
      authorized = parseMotes(amount);
      required = parseMotes(paymentRequirements.amount ?? paymentRequirements.maxAmountRequired ?? '0');
    } catch (error: any) {
      log.warn({ err: error, payer: from, amount }, 'Invalid Casper amount');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch' };
    }

    if (authorized < required) {
      log.warn(
        { payer: from, amount, required: required.toString(), amountCSPR: motesToCspr(authorized) },
        'Insufficient amount',
      );
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch' };
    }

    log.debug('Amount sufficient');

    // 4. Check recipient
    if (!isSameCasperAddress(to, paymentRequirements.payTo)) {
      log.warn({ payer: from, to, expected: paymentRequirements.payTo }, 'Invalid recipient');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_recipient_mismatch' };
    }

    log.debug('Recipient valid');

    // 5. Check deadline
    const now = Math.floor(Date.now() / 1000);
    if (typeof deadline === 'number' && now > deadline) {
      log.warn({ payer: from }, 'Payment expired');
      return { isValid: false, payer: from, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before' };
    }

    log.debug('Deadline valid');

    // 6. Signature + on-chain wCSPR balance are verified by the Casper facilitator
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
  return network === 'casper:casper-test'
    ? config.casperTestnetWcsprContract
    : config.casperWcsprContract;
}
