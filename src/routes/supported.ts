import { Request, Response } from 'express';
import { config } from '../config';

/**
 * GET /supported - x402 Capability Discovery
 *
 * Returns list of payment kinds (network/scheme combinations) that this facilitator supports.
 * Only includes networks that are actually configured with facilitator addresses.
 *
 * Reference: x402 specification Section 7.3
 */
export function getSupportedNetworks(req: Request, res: Response) {
  const kinds: Array<{
    x402Version: number;
    scheme: string;
    network: string;
  }> = [];

  // Add Base Mainnet if configured
  if (config.baseFacilitatorAddress && config.baseFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 1,
      scheme: 'exact',
      network: 'base'
    });
  }

  // Add Base Sepolia if configured
  if (config.baseSepoliaFacilitatorAddress && config.baseSepoliaFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 1,
      scheme: 'exact',
      network: 'base-sepolia'
    });
  }

  // Add Radius Mainnet if configured
  if (config.radiusFacilitatorAddress && config.radiusFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 1,
      scheme: 'exact',
      network: 'radius'
    });
  }

  // Add Radius Testnet if configured
  if (config.radiusTestnetFacilitatorAddress && config.radiusTestnetFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 1,
      scheme: 'exact',
      network: 'radius-testnet'
    });
  }

  // Add Solana mainnet if configured
  if (config.solanaFacilitatorAddress && config.solanaFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 1,
      scheme: 'exact',
      network: 'solana-mainnet-beta'
    });
  }

  res.json({ kinds });
}
