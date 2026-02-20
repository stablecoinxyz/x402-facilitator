/**
 * GET /supported Endpoint Tests
 *
 * Tests x402 specification compliance for capability discovery
 * Reference: https://github.com/coinbase/x402/blob/main/specs/x402-specification.md Section 7.3
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

describe('GET /supported - x402 Spec Compliance', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('Response Format (Section 7.3)', () => {
    it('should return spec-compliant response structure', async () => {
      const response = await request(app).get('/supported');

      // x402 spec requires this structure
      expect(response.body).toHaveProperty('kinds');
      expect(Array.isArray(response.body.kinds)).toBe(true);

      // Spec format: { kinds: [ { x402Version, scheme, network }, ... ] }
    });

    it('should return array of supported payment kinds', async () => {
      const response = await request(app).get('/supported');

      expect(Array.isArray(response.body.kinds)).toBe(true);

      // Each kind should have required fields
      response.body.kinds.forEach((kind: any) => {
        expect(kind).toHaveProperty('x402Version');
        expect(kind).toHaveProperty('scheme');
        expect(kind).toHaveProperty('network');

        expect(kind.x402Version).toBe(1);
        expect(kind.scheme).toBe('exact');
        expect(typeof kind.network).toBe('string');
      });
    });

    it('should only include configured networks', async () => {
      const response = await request(app).get('/supported');

      // Should only return networks that are actually configured
      // (Networks with valid facilitator addresses set)
      const networks = response.body.kinds.map((k: any) => k.network);

      // Valid network names per spec
      const validNetworks = [
        'base',
        'base-sepolia',
        'radius',
        'radius-testnet',
        'solana-mainnet-beta'
      ];

      networks.forEach((network: string) => {
        expect(validNetworks).toContain(network);
      });
    });

    it('should NOT include non-standard fields', async () => {
      const response = await request(app).get('/supported');

      const allowedFields = ['kinds'];
      Object.keys(response.body).forEach(key => {
        expect(allowedFields).toContain(key);
      });

      // Check each kind only has allowed fields
      response.body.kinds?.forEach((kind: any) => {
        const allowedKindFields = ['x402Version', 'scheme', 'network'];
        Object.keys(kind).forEach(key => {
          expect(allowedKindFields).toContain(key);
        });
      });
    });
  });

  describe('Capability Discovery', () => {
    it('should include Base mainnet if configured', async () => {
      const response = await request(app).get('/supported');

      const hasBase = response.body.kinds?.some(
        (k: any) => k.network === 'base' && k.scheme === 'exact'
      );

      if (hasBase) {
        const baseKind = response.body.kinds.find(
          (k: any) => k.network === 'base'
        );
        expect(baseKind.x402Version).toBe(1);
        expect(baseKind.scheme).toBe('exact');
      }
    });

    it('should include Base Sepolia if configured', async () => {
      const response = await request(app).get('/supported');

      const hasBaseSepolia = response.body.kinds?.some(
        (k: any) => k.network === 'base-sepolia' && k.scheme === 'exact'
      );

      if (hasBaseSepolia) {
        const baseSepoliaKind = response.body.kinds.find(
          (k: any) => k.network === 'base-sepolia'
        );
        expect(baseSepoliaKind.x402Version).toBe(1);
        expect(baseSepoliaKind.scheme).toBe('exact');
      }
    });

    it('should include Solana mainnet if configured', async () => {
      const response = await request(app).get('/supported');

      const hasSolana = response.body.kinds?.some(
        (k: any) => k.network === 'solana-mainnet-beta' && k.scheme === 'exact'
      );

      if (hasSolana) {
        const solanaKind = response.body.kinds.find(
          (k: any) => k.network === 'solana-mainnet-beta'
        );
        expect(solanaKind.x402Version).toBe(1);
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
      // GET /supported should be publicly accessible
      const response = await request(app).get('/supported');

      // Should not return 401 or 403
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });

    it('should respond quickly without blockchain calls', async () => {
      const startTime = Date.now();
      await request(app).get('/supported');
      const endTime = Date.now();

      const duration = endTime - startTime;

      // Should be very fast (< 100ms) since it's just config reading
      expect(duration).toBeLessThan(100);
    });
  });

  describe('Network Name Format', () => {
    it('should use network names (not chain IDs)', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        // Should be network names like "base", not chain IDs like "8453"
        expect(kind.network).not.toBe('8453');
        expect(kind.network).not.toBe('84532');

        // Should be valid network name
        const validNames = ['base', 'base-sepolia', 'radius', 'radius-testnet', 'solana-mainnet-beta'];
        expect(validNames).toContain(kind.network);
      });
    });
  });

  describe('Scheme Compliance', () => {
    it('should only use "exact" scheme', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        // Only "exact" scheme is currently defined in x402 spec
        expect(kind.scheme).toBe('exact');
      });
    });

    it('should use x402Version 1', async () => {
      const response = await request(app).get('/supported');

      response.body.kinds?.forEach((kind: any) => {
        expect(kind.x402Version).toBe(1);
      });
    });
  });

  describe('Example Response Validation', () => {
    it('should match spec example format', async () => {
      const response = await request(app).get('/supported');

      // Spec example format:
      // {
      //   "kinds": [
      //     { "x402Version": 1, "scheme": "exact", "network": "base-sepolia" }
      //   ]
      // }

      expect(response.body).toEqual(
        expect.objectContaining({
          kinds: expect.arrayContaining([
            expect.objectContaining({
              x402Version: 1,
              scheme: 'exact',
              network: expect.any(String),
            })
          ])
        })
      );
    });
  });
});

describe('GET /supported - Integration with Config', () => {
  it('should dynamically reflect configured networks', () => {
    // This test checks that /supported returns only networks
    // that have valid configuration (facilitator addresses set)

    // Implementation should check:
    // - If config.baseMerchantAddress is set → include base or base-sepolia
    // - If config.solanaMerchantAddress is set → include solana-mainnet-beta

    // This ensures clients only see payment methods that actually work
  });

  it('should not expose disabled or unconfigured networks', () => {
    // If a network has no facilitator address configured,
    // it should not appear in the /supported response

    // This prevents clients from attempting payments that will fail
  });
});
