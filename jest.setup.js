// Suppress noisy Solana RPC 429 retry logs during tests.
// Actual test failures still surface normally via Jest's test runner.

const originalConsoleError = console.error;
console.error = (...args) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('Retrying after')) return;
  originalConsoleError.apply(console, args);
};

// Solana RPC retries can eat into Jest's default 5s timeout when rate-limited.
jest.setTimeout(15000);
