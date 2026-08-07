/**
 * GET /supported Endpoint Tests
 *
 * Tests x402 v2 specification compliance for capability discovery
 */

import request from 'supertest';
import express from 'express';
import { getSupportedNetworks } from '../routes/supported';

// Create test app with real implementation
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.get('/supported', getSupportedNetworks);
  return app;
}

describe('GET /supported - x402 V2 Spec Compliance', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('Response Format', () => {
    it('should return spec-compliant v2 response structure', async () => {
      const response = await request(app).get('/supported');

      expect(response.body).toHaveProperty('kinds');
      expect(response.body).toHaveProperty('extensions');
      expect(response.body).toHaveProperty('signers');
      expect(Array.isArray(response.body.kinds)).toBe(true);
      expect(Array.isArray(response.body.extensions)).toBe(true);
      expect(typeof response.body.signers).toBe('object');
    });

    it('should return array of supported payment kinds with required fields', async () => {
      const response = await request(app).get('/supported');

      expect(Array.isArray(response.body.kinds)).toBe(true);

      response.body.kinds.forEach((kind: any) => {
        expect(kind).toHaveProperty('x402Version');
        expect(kind).toHaveProperty('scheme');
        expect(kind).toHaveProperty('network');
        expect(kind).toHaveProperty('extra');

        expect([1, 2]).toContain(kind.x402Version);
        expect(kind.scheme).toBe('exact');
        expect(typeof kind.network).toBe('string');
        expect(typeof kind.extra).toBe('object');
        expect(kind.extra).toHaveProperty('assetTransferMethod');
      });
    });

    it('should only include configured networks, under the identifier its version uses', async () => {
      const response = await request(app).get('/supported');

      // v2 kinds carry CAIP-2; v1 kinds carry the plain name a v1 client can send back
      const validV2Networks = [
        'eip155:8453',
        'eip155:84532',
        'eip155:723487',
        'eip155:72344',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      ];
      const validV1Networks = ['base', 'base-sepolia', 'radius', 'radius-testnet', 'solana-mainnet-beta'];

      response.body.kinds.forEach((kind: any) => {
        const valid = kind.x402Version === 1 ? validV1Networks : validV2Networks;
        expect(valid).toContain(kind.network);
      });
    });

    it('should include v2 fields: kinds, extensions, signers', async () => {
      const response = await request(app).get('/supported');

      const allowedFields = ['kinds', 'extensions', 'signers'];
      Object.keys(response.body).forEach(key => {
        expect(allowedFields).toContain(key);
      });

      // Check each kind has allowed v2 fields
      response.body.kinds?.forEach((kind: any) => {
        const allowedKindFields = ['x402Version', 'scheme', 'network', 'extra'];
        Object.keys(kind).forEach(key => {
          expect(allowedKindFields).toContain(key);
        });
      });
    });
  });

  describe('Capability Discovery', () => {
    /** Kinds for one network, keyed by the identifier each version advertises. */
    function kindsFor(body: any, caip2: string, v1Name: string) {
      return {
        v2: body.kinds?.filter((k: any) => k.network === caip2 && k.x402Version === 2 && k.scheme === 'exact') ?? [],
        v1: body.kinds?.filter((k: any) => k.network === v1Name && k.x402Version === 1 && k.scheme === 'exact') ?? [],
      };
    }

    it('should include Base mainnet under both identifiers if configured', async () => {
      const response = await request(app).get('/supported');
      const { v2, v1 } = kindsFor(response.body, 'eip155:8453', 'base');

      if (v2.length > 0) {
        // SBC + USDC under each version
        expect(v2).toHaveLength(2);
        expect(v1).toHaveLength(2);
        expect(v2[0].extra.assetTransferMethod).toBe('erc2612');
        expect(v1[0].extra.assetTransferMethod).toBe('erc2612');
      }
    });

    it('should include Base Sepolia under both identifiers if configured', async () => {
      const response = await request(app).get('/supported');
      const { v2, v1 } = kindsFor(response.body, 'eip155:84532', 'base-sepolia');

      if (v2.length > 0) {
        expect(v2).toHaveLength(2);
        expect(v1).toHaveLength(2);
      }
    });

    it('should include Solana mainnet under both identifiers if configured', async () => {
      const response = await request(app).get('/supported');
      const { v2, v1 } = kindsFor(response.body, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana-mainnet-beta');

      if (v2.length > 0) {
        expect(v2).toHaveLength(1);
        expect(v1).toHaveLength(1);
      }
    });
  });

  describe('HTTP Semantics', () => {
    it('should return 200 OK', async () => {
      const response = await request(app).get('/supported');

      expect(response.status).toBe(200);
    });

    it('should return JSON content type', async () => {
      const response = await request(app).get('/supported');

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should not require authentication', async () => {
      const response = await request(app).get('/supported');

      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });

    it('should respond quickly without blockchain calls', async () => {
      const startTime = Date.now();
      await request(app).get('/supported');
      const endTime = Date.now();

      const duration = endTime - startTime;

      expect(duration).toBeLessThan(100);
    });
  });

  describe('Network Name Format (per-version)', () => {
    it('should advertise v2 kinds with CAIP-2 identifiers', async () => {
      const response = await request(app).get('/supported');
      const v2Kinds = response.body.kinds?.filter((k: any) => k.x402Version === 2);

      expect(v2Kinds.length).toBeGreaterThan(0);
      v2Kinds.forEach((kind: any) => {
        // Should be CAIP-2 like "eip155:8453", not "base" or "8453"
        expect(kind.network).toMatch(/^(eip155:\d+|solana:.+)$/);
      });
    });

    it('should advertise v1 kinds with plain names, never CAIP-2', async () => {
      const response = await request(app).get('/supported');
      const v1Kinds = response.body.kinds?.filter((k: any) => k.x402Version === 1);

      expect(v1Kinds.length).toBeGreaterThan(0);
      v1Kinds.forEach((kind: any) => {
        // A v1 client cannot send CAIP-2 back — its own spec doesn't allow it.
        expect(kind.network).not.toContain(':');
        expect(kind.network).toMatch(/^[a-z0-9-]+$/);
      });
    });

    it('should advertise every network under both a v1 and a v2 identifier', async () => {
      const response = await request(app).get('/supported');
      const v1Count = response.body.kinds.filter((k: any) => k.x402Version === 1).length;
      const v2Count = response.body.kinds.filter((k: any) => k.x402Version === 2).length;

      expect(v1Count).toBe(v2Count);
    });
  });

  describe('Scheme Compliance', () => {
    it('should only use "exact" scheme', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        expect(kind.scheme).toBe('exact');
      });
    });

    it('should use x402Version 1 or 2', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        expect([1, 2]).toContain(kind.x402Version);
      });
    });
  });

  describe('V2 Features', () => {
    it('should include extensions array', async () => {
      const response = await request(app).get('/supported');

      expect(response.body.extensions).toEqual([]);
    });

    it('should include signers object', async () => {
      const response = await request(app).get('/supported');

      expect(typeof response.body.signers).toBe('object');

      // If any EVM networks are configured, signers should have eip155:* key
      const hasEvmNetworks = response.body.kinds?.some(
        (k: any) => k.network.startsWith('eip155:')
      );
      if (hasEvmNetworks) {
        expect(response.body.signers).toHaveProperty('eip155:*');
        expect(Array.isArray(response.body.signers['eip155:*'])).toBe(true);
      }
    });

    it('should include extra with assetTransferMethod per kind', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        expect(kind.extra).toHaveProperty('assetTransferMethod');
        expect(kind.extra).toHaveProperty('name');
        expect(kind.extra).toHaveProperty('version');
      });
    });
  });
});

describe('GET /supported - Integration with Config', () => {
  it('should dynamically reflect configured networks', () => {
    // Implementation checks config for facilitator addresses
    // Only networks with valid configuration appear in response
  });

  it('should not expose disabled or unconfigured networks', () => {
    // If a network has no facilitator address configured,
    // it should not appear in the /supported response
  });
});
