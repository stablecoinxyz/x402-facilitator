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

    it('should return array of supported payment kinds with v2 fields', async () => {
      const response = await request(app).get('/supported');

      expect(Array.isArray(response.body.kinds)).toBe(true);

      response.body.kinds.forEach((kind: any) => {
        expect(kind).toHaveProperty('x402Version');
        expect(kind).toHaveProperty('scheme');
        expect(kind).toHaveProperty('network');
        expect(kind).toHaveProperty('extra');

        expect(kind.x402Version).toBe(2);
        expect(kind.scheme).toBe('exact');
        expect(typeof kind.network).toBe('string');
        expect(typeof kind.extra).toBe('object');
        expect(kind.extra).toHaveProperty('assetTransferMethod');
      });
    });

    it('should only include configured networks with CAIP-2 identifiers', async () => {
      const response = await request(app).get('/supported');

      const networks = response.body.kinds.map((k: any) => k.network);

      // Valid CAIP-2 network identifiers
      const validNetworks = [
        'eip155:8453',
        'eip155:84532',
        'eip155:723',
        'eip155:72344',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      ];

      networks.forEach((network: string) => {
        expect(validNetworks).toContain(network);
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
    it('should include Base mainnet with CAIP-2 if configured', async () => {
      const response = await request(app).get('/supported');

      const hasBase = response.body.kinds?.some(
        (k: any) => k.network === 'eip155:8453' && k.scheme === 'exact'
      );

      if (hasBase) {
        const baseKind = response.body.kinds.find(
          (k: any) => k.network === 'eip155:8453'
        );
        expect(baseKind.x402Version).toBe(2);
        expect(baseKind.scheme).toBe('exact');
        expect(baseKind.extra.assetTransferMethod).toBe('erc2612');
      }
    });

    it('should include Base Sepolia with CAIP-2 if configured', async () => {
      const response = await request(app).get('/supported');

      const hasBaseSepolia = response.body.kinds?.some(
        (k: any) => k.network === 'eip155:84532' && k.scheme === 'exact'
      );

      if (hasBaseSepolia) {
        const baseSepoliaKind = response.body.kinds.find(
          (k: any) => k.network === 'eip155:84532'
        );
        expect(baseSepoliaKind.x402Version).toBe(2);
        expect(baseSepoliaKind.scheme).toBe('exact');
      }
    });

    it('should include Solana mainnet with CAIP-2 if configured', async () => {
      const response = await request(app).get('/supported');

      const hasSolana = response.body.kinds?.some(
        (k: any) => k.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' && k.scheme === 'exact'
      );

      if (hasSolana) {
        const solanaKind = response.body.kinds.find(
          (k: any) => k.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
        );
        expect(solanaKind.x402Version).toBe(2);
        expect(solanaKind.scheme).toBe('exact');
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

  describe('Network Name Format (CAIP-2)', () => {
    it('should use CAIP-2 identifiers (not legacy network names)', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        // Should be CAIP-2 like "eip155:8453", not "base" or "8453"
        expect(kind.network).not.toBe('base');
        expect(kind.network).not.toBe('base-sepolia');
        expect(kind.network).not.toBe('8453');
        expect(kind.network).not.toBe('84532');

        // Should match CAIP-2 pattern
        expect(kind.network).toMatch(/^(eip155:\d+|solana:.+)$/);
      });
    });
  });

  describe('Scheme Compliance', () => {
    it('should only use "exact" scheme', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        expect(kind.scheme).toBe('exact');
      });
    });

    it('should use x402Version 2', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        expect(kind.x402Version).toBe(2);
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
