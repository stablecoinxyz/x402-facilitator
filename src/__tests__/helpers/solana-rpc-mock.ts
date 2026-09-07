/**
 * A Solana Connection that never touches the network.
 *
 * Four suites drive Solana code paths, and every one of them was making real
 * calls to api.mainnet-beta.solana.com. jest.setup.js already records the
 * consequence — "Solana RPC retries can eat into Jest's default 5s timeout when
 * rate-limited" — and raised the timeout to 15s to cope. Under back-to-back runs
 * the calls blow through that too, which turns the suite red at random and puts
 * a coin-flip in front of the deploy job.
 *
 * Mocking costs those suites nothing: their Solana assertions check the response
 * shape (status 200, isValid and payer present), never a value that depends on
 * what mainnet says. Suites that need to control RPC behavior for a specific
 * test still declare their own jest.mock, which takes precedence over this.
 *
 * Usage, at the top of a spec file:
 *   jest.mock('@solana/web3.js', () => require('./helpers/solana-rpc-mock'));
 */

const actual = jest.requireActual('@solana/web3.js');

/** Comfortably above any amount the fixtures ask for. */
const AMPLE_BALANCE = '1000000000000';

module.exports = {
  ...actual,
  Connection: jest.fn().mockImplementation(() => ({
    getTokenAccountBalance: jest.fn().mockResolvedValue({
      value: { amount: AMPLE_BALANCE, decimals: 9, uiAmountString: '1000' },
    }),
    getAccountInfo: jest.fn().mockResolvedValue(null),
    getLatestBlockhash: jest.fn().mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: jest.fn().mockResolvedValue('MockedSolanaTransactionSignature'),
    confirmTransaction: jest.fn().mockResolvedValue({ value: { err: null } }),
  })),
};
