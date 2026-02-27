/**
 * x402 v2 Conformance Test Suite
 *
 * Tests a running x402 facilitator against the v2 protocol spec.
 * No mocking — real HTTP requests only.
 *
 * Usage:
 *   npm run conformance                                        # localhost:3001
 *   FACILITATOR_URL=https://x402.stablecoin.xyz npm run conformance
 */

const BASE_URL = process.env.FACILITATOR_URL || 'http://localhost:3001';

// ---- Test scaffolding ----

type Result = { name: string; pass: boolean; note?: string };
const results: Result[] = [];

function pass(name: string, note?: string) {
  results.push({ name, pass: true, note });
  process.stdout.write(`  ✓ ${name}${note ? ` (${note})` : ''}\n`);
}

function fail(name: string, note: string) {
  results.push({ name, pass: false, note });
  process.stdout.write(`  ✗ ${name}: ${note}\n`);
}

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { res, body: await res.json().catch(() => null) as any };
}

async function post(path: string, payload: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json().catch(() => null) as any };
}

// ---- Fixtures ----

const EVM_PAYMENT = {
  x402Version: 2,
  resource: 'https://example.com/premium',
  accepted: { scheme: 'exact', network: 'eip155:8453' },
  payload: {
    signature: '0x' + 'ab'.repeat(65),
    authorization: {
      from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      to: '0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6',
      value: '1000000000000000',
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 300),
      nonce: String(Date.now()),
    },
  },
  extensions: {},
};

const SOLANA_PAYMENT = {
  x402Version: 2,
  resource: 'https://example.com/premium',
  accepted: { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
  payload: {
    from: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
    to: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K',
    amount: '1000000',
    nonce: String(Date.now()),
    deadline: Math.floor(Date.now() / 1000) + 300,
    signature: 'a'.repeat(88),
  },
  extensions: {},
};

const EVM_REQUIREMENTS = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000000000000000',
  payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  asset: '0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798',
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' },
};

const SOLANA_REQUIREMENTS = {
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  amount: '1000000',
  payTo: '2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K',
  asset: 'DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA',
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: 'delegated-spl', name: 'SBC', version: '1' },
};

// ---- Test suites ----

async function testSupported() {
  console.log('\nGET /supported');
  const { res, body } = await get('/supported');

  // HTTP
  res.status === 200 ? pass('returns 200 OK') : fail('returns 200 OK', `got ${res.status}`);
  res.headers.get('content-type')?.includes('application/json')
    ? pass('Content-Type is application/json')
    : fail('Content-Type is application/json', res.headers.get('content-type') ?? 'none');

  // Top-level fields
  Array.isArray(body?.kinds) ? pass('has kinds[]') : fail('has kinds[]', JSON.stringify(body));
  Array.isArray(body?.extensions) ? pass('has extensions[]') : fail('has extensions[]', 'missing');
  body?.signers && typeof body.signers === 'object' ? pass('has signers{}') : fail('has signers{}', 'missing');

  // kinds entries
  const kinds: any[] = body?.kinds ?? [];
  kinds.length > 0 ? pass('kinds[] is non-empty') : fail('kinds[] is non-empty', 'empty array');

  const allV2 = kinds.every((k: any) => k.x402Version === 2);
  allV2 ? pass('all kinds have x402Version: 2') : fail('all kinds have x402Version: 2', 'some missing');

  const allExact = kinds.every((k: any) => k.scheme === 'exact');
  allExact ? pass('all kinds use scheme: "exact"') : fail('all kinds use scheme: "exact"', 'some differ');

  const allCaip2 = kinds.every((k: any) => /^(eip155:|solana:)/.test(k.network));
  allCaip2 ? pass('all kinds use CAIP-2 network IDs') : fail('all kinds use CAIP-2 network IDs', 'bare chain IDs found');

  const allHaveMethod = kinds.every((k: any) => k.extra?.assetTransferMethod);
  allHaveMethod ? pass('all kinds have extra.assetTransferMethod') : fail('all kinds have extra.assetTransferMethod', 'missing');

  // signers keyed by CAIP-2
  const signerKeys = Object.keys(body?.signers ?? {});
  const allSignersCaip2 = signerKeys.every(k => /^(eip155:|solana:)/.test(k));
  allSignersCaip2 ? pass('signers keyed by CAIP-2') : fail('signers keyed by CAIP-2', `got: ${signerKeys.join(', ')}`);

  // Networks present
  const networks = kinds.map((k: any) => k.network);
  networks.includes('eip155:8453') ? pass('supports Base mainnet (eip155:8453)') : fail('supports Base mainnet (eip155:8453)', 'not in kinds');
  networks.includes('eip155:84532') ? pass('supports Base Sepolia (eip155:84532)') : fail('supports Base Sepolia (eip155:84532)', 'not in kinds');
  networks.includes('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    ? pass('supports Solana mainnet')
    : fail('supports Solana mainnet', 'not in kinds');
}

async function testVerify() {
  console.log('\nPOST /verify');

  // --- Response shape (invalid sig — still returns 200 with isValid: false) ---
  const { res, body } = await post('/verify', {
    paymentPayload: EVM_PAYMENT,
    paymentRequirements: EVM_REQUIREMENTS,
  });

  res.status === 200 ? pass('returns 200 for valid request body') : fail('returns 200 for valid request body', `got ${res.status}`);
  typeof body?.isValid === 'boolean' ? pass('response has isValid boolean') : fail('response has isValid boolean', JSON.stringify(body));
  'payer' in (body ?? {}) ? pass('response has payer field') : fail('response has payer field', 'missing');

  if (body?.isValid === false) {
    typeof body?.invalidReason === 'string'
      ? pass('invalid response has invalidReason string')
      : fail('invalid response has invalidReason string', JSON.stringify(body?.invalidReason));
  }

  // --- Solana ---
  const { res: solRes, body: solBody } = await post('/verify', {
    paymentPayload: SOLANA_PAYMENT,
    paymentRequirements: SOLANA_REQUIREMENTS,
  });
  solRes.status === 200 ? pass('Solana: returns 200') : fail('Solana: returns 200', `got ${solRes.status}`);
  typeof solBody?.isValid === 'boolean' ? pass('Solana: response has isValid boolean') : fail('Solana: response has isValid boolean', JSON.stringify(solBody));

  // --- Validation rejections ---
  const { body: badScheme } = await post('/verify', {
    paymentPayload: { ...EVM_PAYMENT, accepted: { scheme: 'subscribe', network: 'eip155:8453' } },
    paymentRequirements: EVM_REQUIREMENTS,
  });
  badScheme?.isValid === false ? pass('rejects unsupported scheme') : fail('rejects unsupported scheme', JSON.stringify(badScheme));

  const { body: badNet } = await post('/verify', {
    paymentPayload: { ...EVM_PAYMENT, accepted: { scheme: 'exact', network: 'eip155:999999' } },
    paymentRequirements: { ...EVM_REQUIREMENTS, network: 'eip155:999999' },
  });
  badNet?.isValid === false ? pass('rejects unsupported network') : fail('rejects unsupported network', JSON.stringify(badNet));

  const expiredPayment = {
    ...EVM_PAYMENT,
    payload: {
      ...EVM_PAYMENT.payload,
      authorization: { ...EVM_PAYMENT.payload.authorization, validBefore: '1' },
    },
  };
  const { body: expired } = await post('/verify', {
    paymentPayload: expiredPayment,
    paymentRequirements: EVM_REQUIREMENTS,
  });
  expired?.isValid === false ? pass('rejects expired payment') : fail('rejects expired payment', JSON.stringify(expired));

  // --- Missing fields ---
  const { res: missingRes } = await post('/verify', {});
  missingRes.status >= 400
    ? pass('returns 4xx for missing paymentPayload')
    : fail('returns 4xx for missing paymentPayload', `got ${missingRes.status}`);
}

async function testSettle() {
  console.log('\nPOST /settle');

  const { res, body } = await post('/settle', {
    paymentPayload: EVM_PAYMENT,
    paymentRequirements: EVM_REQUIREMENTS,
  });

  res.status === 200 ? pass('returns 200 for valid request body') : fail('returns 200 for valid request body', `got ${res.status}`);
  typeof body?.success === 'boolean' ? pass('response has success boolean') : fail('response has success boolean', JSON.stringify(body));
  'payer' in (body ?? {}) ? pass('response has payer field') : fail('response has payer field', 'missing');

  // Spec field names
  !('txHash' in (body ?? {})) ? pass('no non-spec "txHash" field (uses "transaction")') : fail('no non-spec "txHash" field', 'txHash present');
  !('error' in (body ?? {})) ? pass('no non-spec "error" field (uses "errorReason")') : fail('no non-spec "error" field', 'error present');

  if (body?.success === false) {
    'errorReason' in body
      ? pass('failed response has errorReason field')
      : fail('failed response has errorReason field', JSON.stringify(body));
  }

  if (body?.success === true) {
    typeof body?.transaction === 'string' ? pass('success has transaction (tx hash)') : fail('success has transaction', 'missing/wrong type');
    /^(eip155:|solana:)/.test(body?.network)
      ? pass('success has CAIP-2 network field')
      : fail('success has CAIP-2 network field', `got: ${body?.network}`);
  }

  // Solana shape
  const { res: solRes, body: solBody } = await post('/settle', {
    paymentPayload: SOLANA_PAYMENT,
    paymentRequirements: SOLANA_REQUIREMENTS,
  });
  solRes.status === 200 ? pass('Solana: returns 200') : fail('Solana: returns 200', `got ${solRes.status}`);
  typeof solBody?.success === 'boolean' ? pass('Solana: response has success boolean') : fail('Solana: response has success boolean', JSON.stringify(solBody));

  // Unsupported network
  const { body: badNet } = await post('/settle', {
    paymentPayload: { ...EVM_PAYMENT, accepted: { scheme: 'exact', network: 'eip155:999999' } },
    paymentRequirements: { ...EVM_REQUIREMENTS, network: 'eip155:999999' },
  });
  badNet?.success === false ? pass('rejects unsupported network') : fail('rejects unsupported network', JSON.stringify(badNet));

  // Missing fields
  const { res: missingRes } = await post('/settle', {});
  missingRes.status >= 400
    ? pass('returns 4xx for missing paymentPayload')
    : fail('returns 4xx for missing paymentPayload', `got ${missingRes.status}`);
}

async function testHealth() {
  console.log('\nGET /health');
  const { res, body } = await get('/health');
  res.status === 200 ? pass('returns 200 OK') : fail('returns 200 OK', `got ${res.status}`);
  (body?.ok === true || body?.status === 'ok')
    ? pass('body indicates healthy')
    : fail('body indicates healthy', JSON.stringify(body));
}

// ---- Main ----

async function main() {
  console.log(`x402 v2 Conformance Test`);
  console.log(`Target: ${BASE_URL}`);
  console.log('='.repeat(50));

  try {
    await testHealth();
    await testSupported();
    await testVerify();
    await testSettle();
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exit(1);
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`);

  if (failed > 0) {
    console.log('\nFailed:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.note}`));
    process.exit(1);
  } else {
    console.log('All checks passed ✓');
  }
}

main();
