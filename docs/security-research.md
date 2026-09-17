# Security research: x402 facilitator

**Scope.** This is a protocol and dependency threat-model reference for the
security review. It uses first-party specifications and standards, rather than
claiming that this implementation is conformant with a mechanism it does not
implement. It is not a substitute for an on-chain or deployment review.

## Assets and trust boundaries

The critical assets are payer balances/authorizations, the facilitator's EVM
and Solana signing keys and gas funds, the merchant's evidence of payment, and
the integrity of the payment requirements supplied to `/verify` and `/settle`.
The client and caller of the public endpoints are untrusted. RPC responses,
configuration, and the separate Casper facilitator are external trust
boundaries. `/verify` must not make a durable payment claim; `/settle` is the
fund-moving operation and needs durable, idempotent outcome handling.

The x402 v2 lifecycle expressly distinguishes read-only verification from
settlement, which may consume a payment proof; a resource server must arrange
that verification or settlement occurs before resource execution.
([x402 v2 lifecycle](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md#l440-l459))

## Protocol requirements to test

| Area | Required security property | Primary source |
| --- | --- | --- |
| Envelope binding | Treat `scheme`, CAIP-2 `network`, atomic `amount`, `asset`, `payTo`, and timeout as security inputs. The selected `accepted` requirements must be the same offer the merchant issued, not an attacker-substituted request body. | [v2 schemas](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md#l298-l389) |
| EVM exact semantics | Verify that the signature recovers to the payer; enforce balance, amount/validity, asset and network; then simulate (or re-verify immediately before) the exact settlement call. The facilitator may broadcast but must not be able to alter amount or destination. | [exact EVM](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md#l15-l17), [EIP-3009 checks](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md#l75-l87) |
| Replay and unknown outcome | Bind replay protection to the native authorization/proof identity, make it atomic across concurrent calls and durable across replicas/restarts where the deployment promises idempotency. After a broadcast whose receipt cannot be determined, return `settlement_pending` **with the transaction hash** and require on-chain reconciliation before any new authorization. | [EVM pending handling](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md#l84-l87) |
| Supported capabilities | Advertise only explicit scheme/network pairs that the deployment is configured and authorized to settle; do not let unadvertised aliases expand the transaction-signing surface. | [supported endpoint](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md#l571-l619) |
| Solana outcome | A valid exact payment has one (and only one) matching `TransferChecked` of the required mint, to the ATA derived from `payTo` and asset, for at least the required amount. Verify confirmed on-chain effects, not only a simulation. | [SVM outcome](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#l137-l187), [post-settlement check](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#l326-l333) |
| Solana sponsor safety | Before a fee-payer signs a client transaction, resolve ALTs and ensure the sponsor is never an instruction account/program, transfer authority/source/delegate, or otherwise debited beyond fees; reject additional required signers. Cap compute/priority fees and allowlist programs that reach simulation. | [SVM sponsor baseline](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#l197-l226), [cost controls](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#l228-l268) |
| Solana duplicate race | Prevent duplicate pre-confirmation submissions of the same proof/payload from returning multiple successes; the scheme recommends an atomic short-lived payload cache. | [SVM duplicate-settlement guidance](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md#l354-l370) |

## ERC-2612 recipient/amount distinction (material)

This repository's EVM path uses ERC-2612 `permit` followed by ERC-20
`transferFrom`, while the x402 reference `exact` EVM flow defaults to
EIP-3009 and its `transferWithAuthorization` (or uses the distinct Permit2
path). ([x402 EVM methods](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md#l7-l17))

That difference matters: ERC-2612 signs an allowance tuple
`(owner, spender, value, nonce, deadline)` and the permit call sets the
allowance; it does **not** sign a merchant recipient. The subsequent
`transferFrom(from, to, amount)` supplies the destination separately.
([EIP-2612 specification](https://eips.ethereum.org/EIPS/eip-2612#specification))
Therefore the implementation must, in both `/verify` and immediately before
`/settle`, independently enforce all of the following:

- `spender` equals the controlled facilitator address for the resolved chain;
- `transferFrom.to` is exactly the trusted `paymentRequirements.payTo`;
- transfer amount is exactly the merchant's requested amount (or a documented,
  merchant-approved overpayment policy), never simply the larger permit value;
- asset, chain ID/domain, deadline, nonce and signature are all bound to the
  same settlement; and
- requirements originate from the resource server's signed/session-bound offer,
  not from an unauthenticated client-provided object.

Without that additional trusted requirement binding, a valid permit can be
turned into payment to an attacker-chosen recipient or a larger transfer: this
is a property of the ERC-2612 allowance design, not a failure that EIP-712
signature recovery alone can detect. Also, ERC-2612 is not automatically v1
`exact` compatibility: the Foundation v1 exact reference specifies EIP-3009
authorization and its own signature, amount/time, parameter-match, simulation,
and replay requirements. ([v1 exact verification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v1.md#l410-l420), [v1 replay](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v1.md#l656-l664))

## Deployment and dependency review priorities

1. Keep facilitator private keys out of logs, error responses, images, and
   `.env` history; use separate low-balance gas wallets per chain and rotation/
   revocation procedures. Treat every RPC URL/API key and the Casper service as
   a secret or privileged dependency.
2. Enforce request-size, per-identity/IP and global gas-budget limits. In-memory
   rate/replay state is bypassable by distributed deployment, restart, or IP
   rotation; use shared atomic state if those are in scope.
3. Fail closed on malformed numeric/address/signature inputs, unexpected chain
   IDs, non-whitelisted assets, RPC disagreement/timeouts, and configuration
   where the configured facilitator address does not equal the signing key.
4. Pin and continuously audit the installed JavaScript dependency graph,
   especially `viem`, `@solana/web3.js`, `@solana/spl-token`, Express, and the
   Casper client boundary. Re-run a lockfile-aware advisory scan in CI and
   investigate direct/transitive findings before upgrades.

## Suggested security regression cases

- Swap `accepted` or `paymentRequirements` after a valid signature; vary
  network, asset, payee, required amount, `validAfter`, deadline and permit
  value independently.
- Submit the same authorization concurrently, after process restart, and to two
  replicas; exercise receipt timeout, reverted transfer, and partial
  permit-success/transfer-failure paths.
- Attempt a Solana wrong-mint/wrong-ATA/multiple-transfer/ALT/additional-signer
  proof, a fee-payer authority reference, and excessive compute fee.
- Confirm that simulated mode cannot be mistaken for real settlement by the
  resource server, monitoring, or callers.
