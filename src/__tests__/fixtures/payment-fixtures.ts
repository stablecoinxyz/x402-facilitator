/**
 * Test Fixtures for x402 V2 Payment Testing
 *
 * Creates valid v2 payment payloads for all supported chains
 * Uses ERC-2612 Permit format for EVM chains, mapped to v2 authorization object
 */

// Well-known test addresses (Hardhat accounts)
const TEST_PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';      // account #0
const TEST_MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';    // account #1
const TEST_FACILITATOR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // account #2

/**
 * Create a valid Base payment payload (x402 v2, ERC-2612 authorization)
 */
export function createBasePayment(overrides?: Partial<any>) {
  const now = Math.floor(Date.now() / 1000);
  const deadline = overrides?.deadline ?? now + 300;
  const value = overrides?.amount ?? '10000000000000000'; // 0.01 SBC
  const recipient = overrides?.to ?? TEST_MERCHANT;

  return {
    x402Version: 2,
    resource: 'http://localhost:3001/api/resource',
    accepted: {
      scheme: 'exact',
      network: 'eip155:8453',
    },
    payload: {
      signature: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1b',
      authorization: {
        from: TEST_PAYER,
        to: TEST_FACILITATOR,
        value,
        validAfter: '0',
        validBefore: deadline.toString(),
        nonce: (overrides?.nonce ?? Date.now()).toString(),
      },
    },
    extensions: {},
    // Keep for test assertions that reference payTo
    _recipient: recipient,
  };
}

/**
 * Create a valid Solana payment payload (x402 v2)
 */
export function createSolanaPayment(overrides?: Partial<any>) {
  const now = Math.floor(Date.now() / 1000);

  return {
    x402Version: 2,
    resource: 'http://localhost:3001/api/resource',
    accepted: {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    },
    payload: {
      from: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      to: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K',
      amount: '50000000', // 0.05 SBC
      nonce: Date.now().toString(),
      deadline: now + 300,
      signature: '3yZe7d3YAKLBbZBN6nZMPjwBvPmMKzGvJxYQwR8pPxWKvBmKZ7LjYpzJ8cDaKQgBKCbxPHRYHqKx5gQmKzWVLZmX',
      ...overrides,
    },
    extensions: {},
  };
}

/**
 * Create payment requirements (v2 format with `amount` instead of `maxAmountRequired`)
 */
export function createPaymentRequirements(network: 'eip155:8453' | 'eip155:84532' | 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') {
  const requirements: Record<string, any> = {
    'eip155:8453': {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000000000000000',
      payTo: TEST_MERCHANT,
      asset: '0xFdcC3dd6671EaB0709A4C0f3F53De9a333d80798',
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
    },
    'eip155:84532': {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      payTo: TEST_MERCHANT,
      asset: '0xF9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16',
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
    },
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '50000000',
      payTo: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K',
      asset: 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA',
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: 'delegated-spl', name: 'SBC', version: '1' },
    },
  };

  return requirements[network];
}
