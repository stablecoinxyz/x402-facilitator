import { parsePermit2, PERMIT2_ADDRESS, X402_PERMIT2_PROXY, permit2WitnessTypes, verifyPermit2Signature } from '../evm/permit2';
import { privateKeyToAccount } from 'viem/accounts';

const payer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const merchant = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const token = '0xFdcC3dd6671EaB0709A4C0f3F53De9a333d80798';
const signature = `0x${'1'.repeat(130)}`;
function requirements(overrides: any = {}) { return { amount: '100', asset: token, payTo: merchant, extra: { assetTransferMethod: 'permit2' }, ...overrides }; }
function payload(overrides: any = {}) { return { signature, permit2Authorization: { permitted: { token, amount: '100' }, from: payer, spender: X402_PERMIT2_PROXY, nonce: '7', deadline: String(Math.floor(Date.now() / 1000) + 300), witness: { to: merchant, validAfter: '0' }, ...overrides }, extensions: {} }; }

describe('official x402 Permit2 payload binding', () => {
  it('ignores unknown optional requirement metadata (forward-compatible)', () => {
    const req = requirements({ extra: { assetTransferMethod: 'permit2', unrecognizedExecutionFlag: 'true' } });
    expect(parsePermit2(payload(), req).ok).toBe(true);
  });
  it('rejects a non-permit2 asset transfer method', () => {
    const req = requirements({ extra: { assetTransferMethod: 'erc3009' } });
    expect(parsePermit2(payload(), req)).toMatchObject({ ok: false, reason: 'unsupported_asset_transfer_method' });
  });
  it('rejects missing extra as an unsupported asset transfer method', () => {
    const req = requirements({ extra: undefined });
    expect(parsePermit2(payload(), req)).toMatchObject({ ok: false, reason: 'unsupported_asset_transfer_method' });
  });
  it('rejects sponsorship allowance larger than the exact payment', () => {
    const p = payload();
    const extension = { eip2612GasSponsoring: { info: { from: payer, asset: token, spender: PERMIT2_ADDRESS, amount: '101', nonce: '1', deadline: p.permit2Authorization.deadline, signature, version: '1' } } };
    expect(parsePermit2(p, requirements(), extension)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
  it.each([{ name: 1 }, { version: 1 }])('rejects non-string requirement metadata: %o', (extra) => {
    expect(parsePermit2(payload(), requirements({ extra: { assetTransferMethod: 'permit2', ...extra } }))).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
  it('accepts an exact, recipient-bound Permit2 witness', () => expect(parsePermit2(payload(), requirements()).ok).toBe(true));
  it('rejects an attacker-supplied merchant recipient', () => expect(parsePermit2(payload({ witness: { to: payer, validAfter: '0' } }), requirements()).ok).toBe(false));
  it('rejects a permit maximum larger than the exact invoice', () => expect(parsePermit2(payload({ permitted: { token, amount: '101' } }), requirements()).ok).toBe(false));
  it('rejects a spender other than the canonical x402 proxy', () => expect(parsePermit2(payload({ spender: payer }), requirements()).ok).toBe(false));
  it('requires the sponsorship permit to authorize canonical Permit2', () => {
    const p = payload(); const ext = { eip2612GasSponsoring: { info: { from: payer, asset: token, spender: payer, amount: '100', nonce: '0', deadline: p.permit2Authorization.deadline, signature, version: '1' } } };
    expect(parsePermit2(p, requirements(), ext).ok).toBe(false);
  });
  it('accepts a correctly scoped EIP-2612 sponsorship payload', () => {
    const p = payload(); const ext = { eip2612GasSponsoring: { info: { from: payer, asset: token, spender: PERMIT2_ADDRESS, amount: '100', nonce: '0', deadline: p.permit2Authorization.deadline, signature, version: '1' } } };
    expect(parsePermit2(p, requirements(), ext).ok).toBe(true);
  });
  it('verifies a real Permit2 witness typed-data signature', async () => {
    const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
    const auth: any = { permitted: { token: token.toLowerCase(), amount: '100' }, from: account.address, spender: X402_PERMIT2_PROXY, nonce: '7', deadline: String(Math.floor(Date.now() / 1000) + 300), witness: { to: merchant, validAfter: '0' } };
    const realSignature = await account.signTypedData({ domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2_ADDRESS }, types: permit2WitnessTypes, primaryType: 'PermitWitnessTransferFrom', message: auth });
    await expect(verifyPermit2Signature(auth, realSignature, 8453)).resolves.toBe(true);
  });
});
