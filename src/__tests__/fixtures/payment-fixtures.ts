/**
 * Test Fixtures for x402 Payment Testing
 *
 * Creates valid payment payloads for all supported chains
 */

/**
 * Create a valid Base payment payload
 */
export function createBasePayment(overrides?: Partial<any>) {
  const now = Math.floor(Date.now() / 1000);

  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // Well-known test address (Hardhat account #0)
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // Well-known test address (Hardhat account #1)
      amount: '10000000000000000', // 0.01 SBC
      nonce: Date.now(),
      deadline: now + 300,
      signature: '0x1234567890abcdef...',
      ...overrides,
    }
  };
}

/**
 * Create a valid Solana payment payload
 */
export function createSolanaPayment(overrides?: Partial<any>) {
  const now = Math.floor(Date.now() / 1000);

  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'solana-mainnet-beta',
    payload: {
      from: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      to: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K', // Valid Solana address
      amount: '50000000', // 0.05 SBC
      nonce: Date.now().toString(),
      deadline: now + 300,
      signature: '3yZe7d3YAKLBbZBN6nZMPjwBvPmMKzGvJxYQwR8pPxWKvBmKZ7LjYpzJ8cDaKQgBKCbxPHRYHqKx5gQmKzWVLZmX', // Valid base58 signature (placeholder)
      ...overrides,
    }
  };
}

/**
 * Create payment requirements (what the API expects)
 */
export function createPaymentRequirements(network: 'base' | 'base-sepolia' | 'solana-mainnet-beta') {
  const requirements: Record<string, any> = {
    'base': {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '10000000000000000',
      payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // Hardhat account #1
      asset: '0xFdcC3dd6671EaB0709A4C0f3F53De9a333d80798', // Properly checksummed (SBC token on Base)
      maxTimeoutSeconds: 60,
    },
    'base-sepolia': {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '10000',
      payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // Hardhat account #1
      asset: '0xF9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16', // Properly checksummed
      maxTimeoutSeconds: 60,
    },
    'solana-mainnet-beta': {
      scheme: 'exact',
      network: 'solana-mainnet-beta',
      maxAmountRequired: '50000000',
      payTo: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K', // Valid Solana address
      asset: 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA',
      maxTimeoutSeconds: 60,
    },
  };

  return requirements[network];
}

/**
 * Create Base64-encoded payment header (as client would send)
 */
export function encodePaymentHeader(paymentData: any): string {
  return Buffer.from(JSON.stringify(paymentData)).toString('base64');
}
