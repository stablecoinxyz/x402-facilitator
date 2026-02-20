import { Request, Response } from 'express';
import { config } from '../config';

/**
 * GET /supported - x402 V2 Capability Discovery
 *
 * Returns list of payment kinds (network/scheme combinations) that this facilitator supports,
 * along with extensions and signers per the v2 spec.
 */
export function getSupportedNetworks(req: Request, res: Response) {
  const kinds: Array<{
    x402Version: number;
    scheme: string;
    network: string;
    extra: { assetTransferMethod: string; name: string; version: string };
  }> = [];

  // Collect configured signer addresses keyed by CAIP-2 namespace
  const signers: Record<string, string[]> = {};

  // Add Base Mainnet if configured
  if (config.baseFacilitatorAddress && config.baseFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:8453',
      extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
    });
    addSigner(signers, 'eip155:*', config.baseFacilitatorAddress);
  }

  // Add Base Sepolia if configured
  if (config.baseSepoliaFacilitatorAddress && config.baseSepoliaFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:84532',
      extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
    });
    addSigner(signers, 'eip155:*', config.baseSepoliaFacilitatorAddress);
  }

  // Add Radius Mainnet if configured
  if (config.radiusFacilitatorAddress && config.radiusFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:723',
      extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
    });
    addSigner(signers, 'eip155:*', config.radiusFacilitatorAddress);
  }

  // Add Radius Testnet if configured
  if (config.radiusTestnetFacilitatorAddress && config.radiusTestnetFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:72344',
      extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
    });
    addSigner(signers, 'eip155:*', config.radiusTestnetFacilitatorAddress);
  }

  // Add Solana mainnet if configured
  if (config.solanaFacilitatorAddress && config.solanaFacilitatorPrivateKey) {
    kinds.push({
      x402Version: 2,
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      extra: { assetTransferMethod: 'delegated-spl', name: 'SBC', version: '1' },
    });
    addSigner(signers, 'solana:*', config.solanaFacilitatorAddress);
  }

  res.json({ kinds, extensions: [], signers });
}

/** Add a signer address to a namespace, avoiding duplicates */
function addSigner(signers: Record<string, string[]>, namespace: string, address: string) {
  if (!signers[namespace]) {
    signers[namespace] = [];
  }
  if (!signers[namespace].includes(address)) {
    signers[namespace].push(address);
  }
}
