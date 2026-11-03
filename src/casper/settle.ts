/**
 * Casper Payment Settlement
 *
 * Executes wCSPR (CEP-18, 9 decimals) transfers on Casper by forwarding the
 * x402 envelope to the Casper facilitator service, which submits and confirms
 * the deploy.
 *
 * Architecture: Payer → Merchant. The facilitator executes the transfer on the
 * payer's prior authorization and never holds customer funds, matching the
 * Base (transferFrom) and Solana (delegated SPL) mechanisms.
 */

import type { Logger } from 'pino';
import logger from '../lib/logger';
import { CasperFacilitatorError, casperReasonCode, settleWithCasperFacilitator } from './client';
import { casperAsset, checkCasperPayment } from './verify';
import { isValidCasperAddress } from './networks';

interface CasperPaymentPayload {
  from: string;   // account-hash-... or hex public key (payer)
  to: string;     // account-hash-... or hex public key (recipient)
  amount: string; // Amount in motes
  [key: string]: unknown;
}

/** Told to the caller whenever the outcome of a forwarded settlement is unknown. */
const PENDING_MESSAGE = 'the Casper facilitator may have submitted this transfer; its outcome is unknown. Do not re-authorize; confirm the outcome before retrying';

interface PaymentRequirements {
  amount?: string;
  maxAmountRequired?: string;
  payTo?: string;
  asset?: string;
  network?: string;
}

/**
 * Settle a Casper payment.
 */
export async function settleCasperPayment(
  paymentPayload: CasperPaymentPayload,
  paymentRequirements: PaymentRequirements,
  network: string,
  log: Logger = logger,
): Promise<{ success: boolean; payer: string; transaction: string; network: string; errorReason?: string; errorMessage?: string }> {
  const from = paymentPayload?.from || 'unknown';

  try {
    // /settle validates on its own: recipient, amount and validity window are
    // re-checked here rather than trusting that /verify ran.
    const invalidReason = checkCasperPayment(paymentPayload, paymentRequirements, network, log);
    if (invalidReason) {
      return { success: false, payer: from, transaction: '', network, errorReason: invalidReason };
    }

    log.debug({ from, to: paymentPayload.to, motes: paymentPayload.amount, network }, 'Casper settlement');

    const result = await settleWithCasperFacilitator(
      { x402Version: 2, accepted: { scheme: 'exact', network }, payload: paymentPayload, extensions: {} },
      { ...paymentRequirements, network, asset: paymentRequirements.asset ?? casperAsset(network) },
      log,
    );
    const payer = isValidCasperAddress(result.payer) ? result.payer : from;
    const transaction = typeof result.transaction === 'string' ? result.transaction : '';

    if (result.success) {
      if (transaction) return { success: true, payer, transaction, network };
      // A success with no hash cannot be shown to the payer as either outcome.
      log.error({ payer, network, errorReason: 'settlement_pending' }, 'Casper facilitator reported success without a transaction hash');
      return { success: false, payer, transaction: '', network, errorReason: 'settlement_pending', errorMessage: PENDING_MESSAGE };
    }

    // The service answered with a failure. Pass a spec-shaped reason through;
    // anything else is its own prose, logged and replaced.
    const errorReason = casperReasonCode(result.errorReason, 'settlement_failed');
    if (errorReason !== result.errorReason) {
      log.warn({ payer, network, detail: result.errorReason }, 'Casper facilitator failure detail withheld from the caller');
    }
    return { success: false, payer, transaction, network, errorReason };
  } catch (error: any) {
    if (error instanceof CasperFacilitatorError) {
      // The envelope was forwarded. A timeout, transport error, non-2xx or
      // unparseable answer does not tell us whether the service submitted the
      // transfer, so the answer is not terminal: a terminal failure tells the
      // payer to sign a fresh authorization, which would be a second payment.
      log.error({ err: error, payer: from, network, errorReason: 'settlement_pending' }, 'Casper settlement outcome unknown after forwarding');
      return { success: false, payer: from, transaction: '', network, errorReason: 'settlement_pending', errorMessage: PENDING_MESSAGE };
    }
    log.error({ err: error, payer: from, network }, 'Casper settlement error');
    return { success: false, payer: from, transaction: '', network, errorReason: 'unexpected_settle_error' };
  }
}
