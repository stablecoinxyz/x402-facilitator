// Tests must never reach a real RPC. Pointing these at an unroutable address
// makes that structural instead of aspirational: anything that slips past a
// mock fails instantly and names itself, rather than hanging on a rate-limited
// public endpoint until Jest's timeout fires.
process.env.SOLANA_RPC_URL = 'http://255.255.255.255:1';
process.env.BASE_RPC_URL = 'http://255.255.255.255:1';

process.env.ENABLE_REAL_SETTLEMENT = 'false';
// Simulation is opt-in; the suites exercise the simulated path.
process.env.ALLOW_SIMULATED_SETTLEMENT = 'true';

// Dummy facilitator keys for CI — settle code checks these before reaching
// the simulated settlement path. The viem mock handles all actual crypto ops.
process.env.BASE_FACILITATOR_PRIVATE_KEY = process.env.BASE_FACILITATOR_PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000001';
process.env.BASE_FACILITATOR_ADDRESS = process.env.BASE_FACILITATOR_ADDRESS || '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
process.env.BASE_SEPOLIA_FACILITATOR_PRIVATE_KEY = process.env.BASE_SEPOLIA_FACILITATOR_PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000001';
process.env.BASE_SEPOLIA_FACILITATOR_ADDRESS = process.env.BASE_SEPOLIA_FACILITATOR_ADDRESS || '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

module.exports = {
  setupFiles: ['./jest.setup.js'],
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Isolate each test file in its own worker to prevent Solana RPC rate limit
  // state from leaking across suites and causing flaky failures.
  maxWorkers: 1,
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.spec.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/server.ts', // Exclude server entry point
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
};
