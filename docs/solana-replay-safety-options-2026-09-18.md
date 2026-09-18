# Solana replay-safety options

**Purpose.** Decide how to re-enable real Solana payments without reintroducing
the duplicate-transfer bug that PR #12 contained. This compares primary-source
patterns; it does not authorize a product change.

## Bottom line

The best fit is **not** to make the old `delegated-spl` message flow durable.
Move to the current x402 SVM `exact` flow: the payer signs one complete,
immutable transfer transaction (including the facilitator as fee payer), and
the facilitator verifies it, adds only its fee-payer signature, and broadcasts
those exact bytes. A retry is a rebroadcast of the same transaction, not a new
delegated transfer. The x402 SVM specification calls this a client-driven flow
and explicitly says Solana deduplicates submissions of the same transaction
on-chain. [x402 SVM Exact §Protocol Flow](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#protocol-flow),
[§Duplicate Settlement Mitigation](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#duplicate-settlement-mitigation).

This is materially safer and more standard than the current design, in which
the facilitator constructs a fresh transfer from a reusable off-chain signed
message. The SPL delegate is authorized up to an allowance; it does not consume
the application's message nonce. [Solana spend permissions](https://solana.com/docs/payments/advanced-payments/spend-permissions).

The x402 specification recommends a short in-flight cache keyed by the exact
serialized transaction (about 120 seconds) to prevent duplicate *HTTP success*
responses while that one transaction is pending. For a single active
facilitator this is enough for its stated on-chain duplicate-transfer property;
for replicas, make that short-lived in-flight key shared or route the same key
consistently. It is not an authorization ledger and does not invent a second
payment transaction. [x402 SVM Exact §Duplicate Settlement Mitigation](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#duplicate-settlement-mitigation).

## Options compared

| Pattern | Stops duplicate token movement after crash/retry/replica? | Main cost | x402 fit |
| --- | --- | --- | --- |
| Shared durable off-chain authorization/attempt ledger | **Yes**, if it atomically seals the full authorization before broadcast, stores the exact signed transaction/signature, and all retries only return or rebroadcast it. | Database/worker/retention/operational ownership. A ledger that simply records a nonce after confirmation is not sufficient. | Works around the legacy delegated-SPL method, but it is application-specific—not the current canonical SVM Exact payload. |
| Payer-signed transaction + facilitator fee-payer co-signature | **Yes for token movement:** the payer signature freezes fee payer, lifetime, accounts, instruction order and data; rebroadcast uses identical bytes and is deduplicated by Solana. | Client wallet must construct and partially sign a transaction; facilitator must implement strict transaction inspection and sponsor-cost policy. | **Recommended.** This is the current x402 SVM Exact protocol flow. |
| Durable nonce account | **Only as part of one frozen payer-signed transaction.** Advancing it makes that transaction single-use, but it does **not** consume an arbitrary delegated-SPL application message or stop the facilitator from constructing a new transfer. | Nonce account funding/authority/lifecycle; longer-lived signatures increase the need for careful authority handling. | Optional transaction-lifetime mechanism; not the replay fix for the legacy flow. |
| Custom on-chain program + consumed PDA authorization state | **Yes**, if the program atomically creates/marks a PDA derived from an authorization hash before its token transfer; retries hit the consumed state. | New program, audit, upgrade governance, client integration, and monitoring. | Can satisfy outcome-based Exact semantics, but is not the standard x402 SVM client transaction path and needs custom allowlisting/verification. |

### 1. Shared durable ledger

This is the smallest way to make the *existing* delegated design safe. The
atomic record needs an authorization digest that covers payer, source token
account, mint, merchant destination ATA, amount, deadline, and signature—not a
caller-chosen nonce alone. It must be claimed before the first broadcast and
must retain the exact transaction signature/bytes through reconciliation. A
second instance must see the same claimed record.

It prevents the historical failure mode, but it puts a business-critical
anti-replay guarantee in service infrastructure. It also retains a bespoke
authorization format while x402's current SVM Exact scheme asks the client to
submit a partially signed payment transaction instead.

### 2. Payer-signed transaction / relayer

This changes the trust boundary in the useful direction. The client first
builds the transfer to the required recipient, with the facilitator designated
as fee payer, then signs it. The facilitator may inspect it and add its own
signature, but cannot change recipient, amount, token program, blockhash, or
fees without invalidating the payer signature. Solana documents that every
signature covers exactly those serialized message fields, and that the sponsor
must be chosen before the payer signs. [Solana partial signing](https://solana.com/docs/core/transactions/partial-signing#freeze-the-message-before-signing).

Implementation requirements:

1. Adopt the x402 SVM Exact `PaymentPayload` transaction format rather than
   `delegated-spl` fields.
2. Verify the payer signature(s), fixed facilitator fee payer, exact one
   `TransferChecked` outcome, supported mint/ATA, instruction/program/signer
   allowlist, address lookup tables, and bounded compute/priority fee before
   co-signing. These are core sponsor rules in the x402 SVM specification.
   [x402 SVM Exact §Sponsor Acceptance Policy](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#2-sponsor-acceptance-policy).
3. Store/coalesce the exact serialized transaction only while in flight; on
   uncertainty rebroadcast the same bytes or return the same signature. Never
   rebuild with a fresh blockhash because that requires a fresh payer
   signature. [Solana partial signing](https://solana.com/docs/core/transactions/partial-signing#manage-transaction-lifetime).
4. Confirm the actual on-chain transfer before reporting settlement success;
   simulation is not proof of execution. [x402 SVM Exact §Post-Settlement Verification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#34-post-settlement-verification-totou-defense).

The normal recent-blockhash lifetime bounds this operation to roughly 60–90
seconds; that is appropriate for an HTTP payment. The specification says
resource servers with longer work should use the upfront payment flow.
[x402 SVM Exact §Protocol Flow](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#protocol-flow).

### 3. Durable nonce accounts

A durable nonce replaces the recent blockhash. Its first instruction advances
the nonce, making transactions signed with that nonce unique; the nonce
authority must sign that advance. [Solana durable nonces](https://solana.com/developers/cookbook/transactions/durable-nonces).

That helps only when the payer has signed **one frozen transaction** containing
the nonce advance. It neither binds nor consumes this repository's old
`from|to|amount|nonce|deadline` message, so inserting a durable nonce into a
facilitator-created delegated transfer would still allow a retry to create a
fresh transfer with a fresh nonce. It is therefore an optional lifetime tool,
not a replacement for either option 1 or option 2.

### 4. On-chain consumed authorization PDA

A custom program can validate an Ed25519 authorization, derive a PDA from its
hash, fail if that account already exists/was consumed, and atomically mark it
while performing the token transfer. That moves the replay invariant on-chain,
like EVM Permit2 nonce consumption.

It is the strongest solution for a deliberately deferred-payment product, but
is disproportionate for this lightly used facilitator: it creates a program
security and governance surface. Current x402 SVM Exact is outcome-based and
allows a smart-wallet/CPI verification path, but that path requires explicit
simulation, allowlisting, and post-settlement verification rather than treating
an arbitrary program as standard. [x402 SVM Exact §1 Exact Payment Outcome](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#1-exact-payment-outcome-definition-normative),
[§3 Reference Verification Implementation](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#3-reference-verification-implementation-two-path).

## Recommended decision

Keep real Solana disabled until option 2 is implemented and testnet-tested.
Do **not** build a PostgreSQL ledger merely to preserve the legacy flow unless
we consciously need deferred delegated payments. If that business requirement
exists, option 1 is the pragmatic near-term path; option 4 is the durable
protocol investment. A durable nonce alone is not an adequate fix.

## Verification tests for re-enablement

- Submit the exact same serialized transaction concurrently, after a simulated
  process crash, and through two replicas; assert one on-chain transfer and one
  resource grant.
- Lose RPC confirmation after broadcast; assert retry returns/rebroadcasts the
  same signature and never creates a new message.
- Mutate recipient, amount, fee payer, compute price, blockhash, an account, or
  instruction after payer signing; assert signature validation fails.
- Expire the transaction lifetime; assert the facilitator never rebuilds it
  without a newly payer-signed payload.
