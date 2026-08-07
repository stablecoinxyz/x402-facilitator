/**
 * x402 v1 Backwards Compatibility Tests
 *
 * v1 identifies networks by plain name ("base"); v2 uses CAIP-2 ("eip155:8453").
 * The facilitator resolves chains from CAIP-2 only, so a spec-conformant v1
 * payload was being rejected as invalid_network. These tests pin the translation.
 *
 * Regression: production logs 2026-08-06 showed 35/35 v1 verify requests
 * (network "base" / "base-sepolia") rejected with "Unknown payment network".
 */

import request from 'supertest';
import express from 'express';
import { toCaip2Network, toV1Network, config, SOLANA_MAINNET_CAIP2 } from '../config';
import { verifyPayment } from '../routes/verify';
import { settlePayment } from '../routes/settle';

describe('Network identifier normalization', () => {
  describe('toCaip2Network', () => {
    it('should translate spec-defined v1 EVM names to CAIP-2', () => {
      expect(toCaip2Network('base')).toBe(`eip155:${config.baseChainId}`);
      expect(toCaip2Network('base-sepolia')).toBe(`eip155:${config.baseSepoliaChainId}`);
    });

    it('should translate Radius v1 names to CAIP-2', () => {
      expect(toCaip2Network('radius')).toBe(`eip155:${config.radiusChainId}`);
      expect(toCaip2Network('radius-testnet')).toBe(`eip155:${config.radiusTestnetChainId}`);
    });

    it('should translate Solana v1 names and aliases to CAIP-2', () => {
      expect(toCaip2Network('solana-mainnet-beta')).toBe(SOLANA_MAINNET_CAIP2);
      expect(toCaip2Network('solana')).toBe(SOLANA_MAINNET_CAIP2);
      expect(toCaip2Network('solana-mainnet')).toBe(SOLANA_MAINNET_CAIP2);
    });

    it('should be case-insensitive', () => {
      expect(toCaip2Network('Base')).toBe(`eip155:${config.baseChainId}`);
      expect(toCaip2Network('BASE-SEPOLIA')).toBe(`eip155:${config.baseSepoliaChainId}`);
    });

    it('should pass CAIP-2 identifiers through untouched', () => {
      expect(toCaip2Network('eip155:8453')).toBe('eip155:8453');
      expect(toCaip2Network('eip155:84532')).toBe('eip155:84532');
      expect(toCaip2Network(SOLANA_MAINNET_CAIP2)).toBe(SOLANA_MAINNET_CAIP2);
    });

    it('should return unknown names as-is so errors show what the client sent', () => {
      expect(toCaip2Network('ethereum')).toBe('ethereum');
      expect(toCaip2Network('avalanche')).toBe('avalanche');
    });

    it('should coerce missing or non-string values to "unknown"', () => {
      expect(toCaip2Network(undefined)).toBe('unknown');
      expect(toCaip2Network(null)).toBe('unknown');
      expect(toCaip2Network('')).toBe('unknown');
      expect(toCaip2Network(8453)).toBe('unknown');
    });
  });

  describe('toV1Network', () => {
    it('should reverse-map CAIP-2 to the canonical v1 name', () => {
      expect(toV1Network(`eip155:${config.baseChainId}`)).toBe('base');
      expect(toV1Network(`eip155:${config.baseSepoliaChainId}`)).toBe('base-sepolia');
      expect(toV1Network(SOLANA_MAINNET_CAIP2)).toBe('solana-mainnet-beta');
    });

    it('should return null for networks with no v1 name', () => {
      expect(toV1Network('eip155:1')).toBeNull();
      expect(toV1Network('unknown')).toBeNull();
    });

    it('should round-trip every canonical v1 name', () => {
      ['base', 'base-sepolia', 'radius', 'radius-testnet', 'solana-mainnet-beta'].forEach(name => {
        expect(toV1Network(toCaip2Network(name))).toBe(name);
      });
    });
  });
});

describe('v1 payloads reach network resolution', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.post('/verify', verifyPayment);
    app.post('/settle', settlePayment);
  });

  /** A spec-conformant x402 v1 payload: flat shape, plain network name. */
  function v1Request(network: string) {
    const deadline = Math.floor(Date.now() / 1000) + 300;
    return {
      paymentPayload: {
        x402Version: 1,
        signature: '0x' + '11'.repeat(65),
        authorization: {
          from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          value: '10000',
          validAfter: '0',
          validBefore: deadline.toString(),
          nonce: Date.now().toString(),
        },
      },
      paymentRequirements: {
        scheme: 'exact',
        network,
        maxAmountRequired: '10000',
        payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
    };
  }

  it('should not reject a v1 "base" verify request as invalid_network', async () => {
    const response = await request(app).post('/verify').send(v1Request('base'));

    expect(response.body.invalidReason).not.toBe('invalid_network');
    expect(response.body.network ?? `eip155:${config.baseChainId}`).not.toBe('base');
  });

  it('should not reject a v1 "base-sepolia" verify request as invalid_network', async () => {
    const response = await request(app).post('/verify').send(v1Request('base-sepolia'));

    expect(response.body.invalidReason).not.toBe('invalid_network');
  });

  it('should not reject a v1 "base" settle request as invalid_network', async () => {
    const response = await request(app).post('/settle').send(v1Request('base'));

    expect(response.body.errorReason).not.toBe('invalid_network');
  });

  it('should echo the resolved CAIP-2 network back on settle', async () => {
    const response = await request(app).post('/settle').send(v1Request('base'));

    expect(response.body.network).toBe(`eip155:${config.baseChainId}`);
  });

  it('should still reject a genuinely unsupported network', async () => {
    const response = await request(app).post('/settle').send(v1Request('ethereum'));

    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe('invalid_network');
    // Error echoes what the client sent, not a masked 'unknown'
    expect(response.body.network).toBe('ethereum');
  });
});
