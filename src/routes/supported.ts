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

  // Add Base if configured
  // Determine if it's mainnet or sepolia based on chain ID
  if (config.baseFacilitatorAddress && config.baseFacilitatorPrivateKey) {
    const networkName = config.baseChainId === 8453 ? 'base' : 'base-sepolia';
    kinds.push({
      x402Version: 1,
      scheme: 'exact',
      network: networkName
    });
  }

  // Add Radius if configured
  // Determine if it's mainnet or testnet based on chain ID
  if (config.radiusFacilitatorAddress && config.radiusFacilitatorPrivateKey) {
    const networkName = config.radiusChainId === 723 ? 'radius' : 'radius-testnet';
    kinds.push({
      x402Version: 1,
      scheme: 'exact',
      network: networkName
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
