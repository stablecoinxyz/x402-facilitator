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
import { settleWithCasperFacilitator } from './client';
import { casperAsset, checkCasperPayment } from './verify';

interface CasperPaymentPayload {
  from: string;   // account-hash-... or hex public key (payer)
  to: string;     // account-hash-... or hex public key (recipient)
  amount: string; // Amount in motes
  [key: string]: unknown;
}

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
): Promise<{ success: boolean; payer: string; transaction: string; network: string; errorReason?: string }> {
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

    return {
      success: Boolean(result.success),
      payer: result.payer || from,
      transaction: result.transaction || '',
      network: result.network || network,
      ...(result.success ? {} : { errorReason: result.errorReason || 'settlement_failed' }),
    };
  } catch (error: any) {
    log.error({ err: error, payer: from, network }, 'Casper settlement error');
    return {
      success: false,
      payer: from,
      transaction: '',
      network,
      errorReason: error?.message || 'settlement_failed',
    };
  }
}
