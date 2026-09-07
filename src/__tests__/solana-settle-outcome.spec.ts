/**
 * Solana settlement outcomes after the transfer is broadcast
 *
 * Same class as stablecoinxyz/x402-facilitator#6, on the Solana path. Once the
 * delegated transfer is broadcast the tokens may already have moved, so a
 * confirmation that fails is not a terminal "no" and the answer must carry the
 * signature. Also covers a transaction that lands and fails on chain, which
 * confirmTransaction reports in value.err rather than by throwing.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';

const BLOCKHASH = bs58.encode(Buffer.alloc(32, 1));
const TX_SIGNATURE = 'ZzL7pFakeSignatureForTestOnly11111111111111111111111111111111';

const mockGetLatestBlockhash = jest.fn();
const mockSendRawTransaction = jest.fn();
const mockConfirmTransaction = jest.fn();

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getLatestBlockhash: (...a: any[]) => mockGetLatestBlockhash(...a),
      sendRawTransaction: (...a: any[]) => mockSendRawTransaction(...a),
      confirmTransaction: (...a: any[]) => mockConfirmTransaction(...a),
    })),
  };
});

// A real keypair so Keypair.fromSecretKey and transaction.sign work unmocked.
// Set before the module import below, and restored in afterAll so a later suite
// in the same worker does not inherit them.
const facilitatorKeypair = nacl.sign.keyPair();
const originalPrivateKey = process.env.SOLANA_FACILITATOR_PRIVATE_KEY;
const originalAddress = process.env.SOLANA_FACILITATOR_ADDRESS;
process.env.SOLANA_FACILITATOR_PRIVATE_KEY = bs58.encode(facilitatorKeypair.secretKey);
process.env.SOLANA_FACILITATOR_ADDRESS = bs58.encode(facilitatorKeypair.publicKey);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { settleSolanaPayment } = require('../solana/settle');

// Real Ed25519 public keys: associated-token-account derivation rejects an
// owner that is not a point on the curve.
const payerKey = bs58.encode(nacl.sign.keyPair().publicKey);
const merchantKey = bs58.encode(nacl.sign.keyPair().publicKey);

const payment = {
  from: payerKey,
  to: merchantKey,
  amount: '50000000',
  nonce: 'n-1',
  deadline: Math.floor(Date.now() / 1000) + 300,
  signature: 'sig',
};

describe('Solana settlement outcomes', () => {
  afterAll(() => {
    process.env.SOLANA_FACILITATOR_PRIVATE_KEY = originalPrivateKey;
    process.env.SOLANA_FACILITATOR_ADDRESS = originalAddress;
  });

  beforeEach(() => {
    mockGetLatestBlockhash.mockReset().mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 });
    mockSendRawTransaction.mockReset().mockResolvedValue(TX_SIGNATURE);
    mockConfirmTransaction.mockReset();
  });

  it('answers settlement_pending WITH the signature when confirmation fails after broadcast', async () => {
    mockConfirmTransaction.mockRejectedValue(new Error('block height exceeded'));

    const result = await settleSolanaPayment(payment);

    expect(mockSendRawTransaction).toHaveBeenCalledTimes(1);   // broadcast happened
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('settlement_pending');
    expect(result.transaction).toBe(TX_SIGNATURE);
  });

  it('reports a transaction that failed on chain as failed, with its signature', async () => {
    mockConfirmTransaction.mockResolvedValue({ value: { err: { InstructionError: [0, 'InvalidAccountData'] } } });

    const result = await settleSolanaPayment(payment);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('invalid_transaction_state');
    expect(result.transaction).toBe(TX_SIGNATURE);
  });

  it('settles when the transaction confirms cleanly', async () => {
    mockConfirmTransaction.mockResolvedValue({ value: { err: null } });

    const result = await settleSolanaPayment(payment);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe(TX_SIGNATURE);
  });

  it('never puts the RPC endpoint into the response', async () => {
    // RPC client errors embed the endpoint URL, which carries an API key on most
    // providers. The full error belongs in the log, not in the payer's response.
    mockGetLatestBlockhash.mockRejectedValue(
      new Error('request to https://mainnet.helius-rpc.com/?api-key=SECRETKEY123 failed')
    );

    const result = await settleSolanaPayment(payment);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRETKEY123');
    expect(JSON.stringify(result)).not.toContain('helius');
  });
});
