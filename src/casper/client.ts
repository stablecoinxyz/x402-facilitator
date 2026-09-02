/**
 * Casper Facilitator HTTP Client
 *
 * Casper settlement is executed by the Casper x402 facilitator service, which
 * exposes the same `/verify`, `/settle` and `/supported` surface this server
 * does. We forward the x402 envelope verbatim so payload shapes stay canonical.
 */

import type { Logger } from 'pino';
import { config } from '../config';
import logger from '../lib/logger';

export interface CasperVerifyResponse {
  isValid: boolean;
  payer: string;
  invalidReason: string | null;
}

export interface CasperSettleResponse {
  success: boolean;
  payer: string;
  transaction: string;
  network: string;
  errorReason?: string;
}

/** Error raised when the Casper facilitator is unreachable or returns non-2xx. */
export class CasperFacilitatorError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'CasperFacilitatorError';
    this.status = status;
  }
}

function endpoint(pathname: string): string {
  return `${config.casperFacilitatorUrl.replace(/\/+$/, '')}${pathname}`;
}

async function post<T>(pathname: string, body: unknown, log: Logger): Promise<T> {
  const url = endpoint(pathname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.casperFacilitatorTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new CasperFacilitatorError(
        `Casper facilitator returned non-JSON response from ${pathname}`,
        response.status,
      );
    }

    if (!response.ok) {
      const reason = parsed?.invalidReason || parsed?.errorReason || parsed?.error || response.statusText;
      throw new CasperFacilitatorError(
        `Casper facilitator ${pathname} failed: ${reason}`,
        response.status,
      );
    }

    log.debug({ url, status: response.status }, 'Casper facilitator response');
    return parsed as T;
  } catch (error: any) {
    if (error instanceof CasperFacilitatorError) throw error;
    if (error?.name === 'AbortError') {
      throw new CasperFacilitatorError(
        `Casper facilitator ${pathname} timed out after ${config.casperFacilitatorTimeoutMs}ms`,
      );
    }
    throw new CasperFacilitatorError(`Casper facilitator ${pathname} unreachable: ${error?.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** POST /verify on the Casper facilitator. */
export async function verifyWithCasperFacilitator(
  paymentPayload: unknown,
  paymentRequirements: unknown,
  log: Logger = logger,
): Promise<CasperVerifyResponse> {
  return post<CasperVerifyResponse>('/verify', { paymentPayload, paymentRequirements }, log);
}

/** POST /settle on the Casper facilitator. */
export async function settleWithCasperFacilitator(
  paymentPayload: unknown,
  paymentRequirements: unknown,
  log: Logger = logger,
): Promise<CasperSettleResponse> {
  return post<CasperSettleResponse>('/settle', { paymentPayload, paymentRequirements }, log);
}
