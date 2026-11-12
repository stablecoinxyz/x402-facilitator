import { privateKeyToAccount } from 'viem/accounts';
import { parseEip3009, selectsEip3009, verifyEip3009Signature, transferWithAuthorizationArgs, transferWithAuthorizationTypes, Eip3009Authorization } from '../evm/eip3009';
import { resolveToken } from '../config';

// Anvil default key #0 — test-only, holds nothing on any real chain.
const payerAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const payer = payerAccount.address;
const merchant = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BASE = 8453;
const sbc = resolveToken(BASE, '0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798')!;
const NOW = 1_800_000_000n;

function auth(overrides: Partial<Eip3009Authorization> = {}): Eip3009Authorization {
  return { from: payer, to: merchant, value: '100', validAfter: '0', validBefore: String(NOW + 300n), nonce: `0x${'ab'.repeat(32)}`, ...overrides };
}
function requirements(extra: any = { assetTransferMethod: 'eip3009', name: 'Stable Coin', version: '1' }) {
  return { amount: '100', asset: sbc.address, payTo: merchant, extra };
}
async function sign(a: Eip3009Authorization, domain = { name: sbc.name, version: sbc.version, chainId: BASE, verifyingContract: sbc.address as `0x${string}` }) {
  return payerAccount.signTypedData({ domain, types: transferWithAuthorizationTypes, primaryType: 'TransferWithAuthorization', message: { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` } });
}
const sig = `0x${'1'.repeat(130)}`;

describe('EIP-3009 method selection', () => {
  it('absent assetTransferMethod selects eip3009 (spec default)', () => {
    expect(selectsEip3009({ extra: { name: 'Stable Coin', version: '1' } })).toBe(true);
    expect(selectsEip3009({})).toBe(true);
  });
  it('explicit eip3009 selects it; permit2 does not', () => {
    expect(selectsEip3009({ extra: { assetTransferMethod: 'eip3009' } })).toBe(true);
    expect(selectsEip3009({ extra: { assetTransferMethod: 'permit2' } })).toBe(false);
  });
  it('rejects a permit2 requirement', () => {
    expect(parseEip3009({ signature: sig, authorization: auth() }, requirements({ assetTransferMethod: 'permit2' }), NOW, 0n)).toMatchObject({ ok: false, reason: 'unsupported_asset_transfer_method' });
  });
});

describe('EIP-3009 payload binding', () => {
  const parse = (a: any, req = requirements(), min = 0n, signature: any = sig) => parseEip3009({ signature, authorization: a }, req, NOW, min);
  it('accepts an exact, recipient-bound authorization', () => expect(parse(auth()).ok).toBe(true));
  it('accepts it with no extra at all (spec default)', () => expect(parse(auth(), requirements(undefined)).ok).toBe(true));
  it('rejects a recipient other than payTo', () => expect(parse(auth({ to: payer }))).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_recipient_mismatch' }));
  it('rejects a value above the amount', () => expect(parse(auth({ value: '101' }))).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_authorization_value_mismatch' }));
  it('rejects a value below the amount', () => expect(parse(auth({ value: '99' }))).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_authorization_value_mismatch' }));
  it('rejects self-payment', () => {
    const req = { ...requirements(), payTo: payer };
    expect(parse(auth({ to: payer }), req)).toMatchObject({ ok: false, reason: 'invalid_self_payment' });
  });
  it('rejects not-yet-valid', () => expect(parse(auth({ validAfter: String(NOW + 1n) }))).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_after' }));
  it('rejects expired', () => expect(parse(auth({ validBefore: String(NOW - 1n) }))).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_before' }));
  it('rejects one that expires inside the settle margin', () => expect(parse(auth({ validBefore: String(NOW + 29n) }), requirements(), 30n)).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_before' }));
  it('rejects a short nonce', () => expect(parse(auth({ nonce: '0x01' }))).toMatchObject({ ok: false, reason: 'invalid_payload' }));
  it('rejects a non-EOA (non-65-byte) signature', () => expect(parse(auth(), requirements(), 0n, `0x${'1'.repeat(132)}`)).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_signature' }));
  it('rejects a missing authorization', () => expect(parse(undefined)).toMatchObject({ ok: false, reason: 'invalid_payload' }));
  it('rejects non-string requirement metadata', () => expect(parse(auth(), requirements({ name: 1 }))).toMatchObject({ ok: false, reason: 'invalid_payload' }));
});

describe('EIP-3009 signature', () => {
  it('refuses the high-s twin of a valid signature, which ecrecover accepts but the tokens revert on', async () => {
    const a = auth();
    const low = await sign(a);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (N - BigInt(`0x${low.slice(66, 130)}`)).toString(16).padStart(64, '0');
    const v = parseInt(low.slice(130), 16) === 27 ? '1c' : '1b';
    const high = `${low.slice(0, 66)}${highS}${v}`;
    // The gap being closed: off-chain recovery alone accepts the twin.
    expect(await verifyEip3009Signature(a, high, sbc, BASE)).toBe(true);
    expect(parseEip3009({ signature: low, authorization: a }, requirements(), NOW, 0n).ok).toBe(true);
    expect(parseEip3009({ signature: high, authorization: a }, requirements(), NOW, 0n)).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_signature' });
  });
  it('verifies against the configured token domain', async () => {
    const a = auth();
    expect(await verifyEip3009Signature(a, await sign(a), sbc, BASE)).toBe(true);
  });
  it('rejects a signature over a different recipient', async () => {
    const signed = await sign(auth({ to: payer }));
    expect(await verifyEip3009Signature(auth(), signed, sbc, BASE)).toBe(false);
  });
  it('rejects a signature made for another chain', async () => {
    const a = auth();
    const signed = await sign(a, { name: sbc.name, version: sbc.version, chainId: 84532, verifyingContract: sbc.address as `0x${string}` });
    expect(await verifyEip3009Signature(a, signed, sbc, BASE)).toBe(false);
  });
  it('rejects a signature made with a client-chosen domain name', async () => {
    const a = auth();
    const signed = await sign(a, { name: 'Not Stable Coin', version: sbc.version, chainId: BASE, verifyingContract: sbc.address as `0x${string}` });
    expect(await verifyEip3009Signature(a, signed, sbc, BASE)).toBe(false);
  });
  it('splits into v (27/28), r, s for the v/r/s overload', async () => {
    const a = auth();
    const args = transferWithAuthorizationArgs(a, await sign(a));
    expect([27, 28]).toContain(args[6]);
    expect(args[7]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(args[8]).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('EIP-3009 token capability', () => {
  it('Base Sepolia SBC is Permit2-only', () => expect(resolveToken(84532, '0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16')?.eip3009).toBe(false));
  it('Base SBC, Base USDC and Radius SBC support EIP-3009', () => {
    expect(sbc.eip3009).toBe(true);
    expect(resolveToken(BASE, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')?.eip3009).toBe(true);
    expect(resolveToken(723487, '0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb')?.eip3009).toBe(true);
  });
});
