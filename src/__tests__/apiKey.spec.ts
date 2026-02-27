/**
 * apiKeyMiddleware Tests
 *
 * Tests API key validation for mainnet /verify and /settle routes.
 */

import { Request, Response, NextFunction } from 'express';
import { apiKeyMiddleware } from '../middleware/apiKey';

describe('apiKeyMiddleware', () => {
  let res: Partial<Response>;
  let next: jest.Mock;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    next = jest.fn();
    res = {
      status: statusMock as unknown as Response['status'],
      json: jsonMock,
    };
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  function makeReq(network?: string, apiKey?: string): Request {
    return {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      body: network ? { paymentPayload: { accepted: { network } } } : {},
    } as unknown as Request;
  }

  describe('testnet networks (no API key required)', () => {
    it('passes through for Base Sepolia', () => {
      apiKeyMiddleware(makeReq('eip155:84532'), res as Response, next as NextFunction);
      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('passes through for Radius testnet', () => {
      apiKeyMiddleware(makeReq('eip155:72344'), res as Response, next as NextFunction);
      expect(next).toHaveBeenCalled();
    });

    it('passes through when no network in body', () => {
      apiKeyMiddleware(makeReq(undefined), res as Response, next as NextFunction);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('mainnet networks (API key required)', () => {
    it('returns 401 when no API key for Base mainnet', () => {
      apiKeyMiddleware(makeReq('eip155:8453'), res as Response, next as NextFunction);
      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('API key required') }));
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when no API key for Radius mainnet', () => {
      apiKeyMiddleware(makeReq('eip155:723'), res as Response, next as NextFunction);
      expect(statusMock).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when no API key for Solana mainnet', () => {
      apiKeyMiddleware(makeReq('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), res as Response, next as NextFunction);
      expect(statusMock).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 for invalid API key', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ valid: false }),
      });

      apiKeyMiddleware(makeReq('eip155:8453', 'sbc-invalid'), res as Response, next as NextFunction);

      await new Promise((r) => setTimeout(r, 50));
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() for valid API key', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ valid: true }),
      });

      apiKeyMiddleware(makeReq('eip155:8453', 'sbc-validkey'), res as Response, next as NextFunction);

      await new Promise((r) => setTimeout(r, 50));
      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('returns 503 when dashboard is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      apiKeyMiddleware(makeReq('eip155:8453', 'sbc-somekey'), res as Response, next as NextFunction);

      await new Promise((r) => setTimeout(r, 50));
      // Fails closed — 403 (invalid) since validation failed
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
