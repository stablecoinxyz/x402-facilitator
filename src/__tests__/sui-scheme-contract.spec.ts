/**
 * The vendored scheme's behaviour that `routes/settle.ts` relies on to tell
 * "this request broadcast the bytes" from "nothing left the process".
 *
 * The route reads that from `transaction` on a `transaction_failed` answer:
 * failures before submit carry `""`, every failure from the submit path carries
 * the digest. A chain success after a `""` failure is someone else's broadcast
 * (`duplicate_settlement`); after a digest-carrying failure it is this request's
 * own payment (`success`). If an upstream re-diff changes either shape, these
 * tests go red before the route starts mislabeling payments.
 */
import { ExactSuiScheme } from '../sui/vendor/exact/facilitator/scheme';
import { SUI_TESTNET_CAIP2 } from '../sui/vendor/constants';
import type { SettlementGuard } from '../sui/vendor/types';
import {
  buildTestTransaction,
  digestOf,
  exactBalanceChanges,
  failureRecord,
  mockClient,
  signPayload,
  successRecord,
  testPayload,
  testRequirements,
} from './sui-helpers';

const PASS_THROUGH: SettlementGuard = { claim: () => true, release: () => undefined };

describe('Sui scheme contract relied on by the settle route', () => {
  let mock: ReturnType<typeof mockClient>;
  let scheme: ExactSuiScheme;
  let payload: Awaited<ReturnType<typeof testPayload>>;
  let digest: string;

  beforeEach(async () => {
    mock = mockClient();
    scheme = new ExactSuiScheme({ clients: { [SUI_TESTNET_CAIP2]: mock.client }, settlementGuard: PASS_THROUGH });
    payload = testPayload(await signPayload(await buildTestTransaction()));
    digest = await digestOf((payload.payload as { transaction: string }).transaction);
  });

  describe('failures before submit carry an empty transaction', () => {
    it('epoch read fails', async () => {
      mock.core.getCurrentSystemState.mockRejectedValue(new Error('unavailable'));
      const result = await scheme.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: '' });
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });

    it('claim store throws', async () => {
      const throwing = new ExactSuiScheme({
        clients: { [SUI_TESTNET_CAIP2]: mock.client },
        settlementGuard: { claim: () => { throw new Error('store down'); }, release: () => undefined },
      });
      const result = await throwing.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: '' });
      expect(mock.core.executeTransaction).not.toHaveBeenCalled();
    });
  });

  describe('failures after submit carry the digest', () => {
    it('submit throws and the transaction cannot be found (lost receipt)', async () => {
      mock.core.executeTransaction.mockRejectedValue(new Error('socket hang up'));
      const result = await scheme.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: digest });
    });

    it('finality wait throws and the transaction cannot be found', async () => {
      mock.core.executeTransaction.mockResolvedValue({ $kind: 'Transaction', Transaction: successRecord(exactBalanceChanges(), digest) });
      mock.core.waitForTransaction.mockRejectedValue(new Error('deadline exceeded'));
      const result = await scheme.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: digest });
    });

    it('execution commits a failed transaction', async () => {
      mock.core.executeTransaction.mockResolvedValue({ $kind: 'FailedTransaction', FailedTransaction: failureRecord('abort', digest) });
      const result = await scheme.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: digest });
    });

    it('balance changes stay unavailable', async () => {
      const bare = { ...successRecord([], digest), balanceChanges: undefined };
      mock.core.executeTransaction.mockResolvedValue({ $kind: 'Transaction', Transaction: bare });
      mock.core.waitForTransaction.mockResolvedValue({ $kind: 'Transaction', Transaction: bare });
      const result = await scheme.settle(payload, testRequirements());
      expect(result).toMatchObject({ success: false, errorReason: 'transaction_failed', transaction: digest });
    });
  });
});
