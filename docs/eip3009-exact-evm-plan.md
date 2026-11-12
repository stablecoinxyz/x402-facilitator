# Plan: EIP-3009 (`transferWithAuthorization`) for Exact EVM

**Status (2026-11-12 07:20 UTC, branch `feat/eip3009-exact-evm`, not committed):** steps 1–7, 9 done;
step 8 partly done. **Real mainnet payments passed (2026-11-12 ~07:29 UTC), in-process (this repo's
routes on a laptop, live facilitator key `0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6`; NOT yet through
the deployed host)**, stock client, method absent, payer `0x516930071b19C364D711fB10AFdb3D7c8e53aC4b`
(throwaway), payTo the facilitator signer:
- Base: 0.001 SBC, tx `0x8d57c34e4c037d6fe829eb8ee5960e601bf224c2a80f82b48404b33d3951f646`, block
  56390834, payer 1000000000000000 → 0, payTo +1000000000000000, replay refused.
- Radius: 0.001 SBC, tx `0xc689684cde5efe48b5e0fc71a6206028196227446c73355e06ae04f9cb252a8a`, block
  1794468562492, payer 1000 → 0, payTo 12550000 → 12551000, replay refused.
Both receipts re-read with `cast receipt`: status 1, `to` = the token, logs `AuthorizationUsed` + `Transfer`.
Remaining: the same proof through the deployed host after merge (`EIP3009_PROVE_BASE_URL`). **Step 6 passed (Eric ran it, 2026-11-12 07:16 UTC):** `npm run
prove:eip3009:fork` against an anvil fork of Base mainnet — stock client, method absent; `/verify`
valid; `/settle` success tx `0x1c3e8e3224e406f9e7c0a145ec89fe568ee92e8df2b0a78cbe5620dda2802385`
(fork block 56386695, gas used 141068); replay → `invalid_exact_evm_nonce_already_used`, empty
`transaction`; payer 100000 → 90000, payTo +10000. Fork only: no real money moved. Mutations for the recipient binding, exact
amount, spec default, in-queue nonce re-read and Transfer-event check are in
`scripts/sabotage-check.py` (each turned the tests red when applied by hand; the script itself only
runs on a clean tree, so CI runs it after commit). `/settle` decides disabled/simulated mode before
any RPC. Fundless real-target evidence: the stock `@x402/evm@2.26.0` client's payment passed this
repo's `/verify` up to the on-chain balance read on Base and Radius mainnet (`insufficient_funds`
for an empty wallet); an `eth_call` of `transferWithAuthorization` on the real Base SBC contract,
with the payer balance overridden at storage slot 51, succeeded for the stock-signed authorization
and reverted with the value changed. The same override had no effect on Radius (unproven there).
Stock seller check: `@x402/core` only tests that a kind exists for network + scheme, and
`@x402/evm`'s server ignores the kind's `extra`, so `/supported` order cannot change a seller's
signing domain. `settlement_effects_mismatch` was added to the live "Settle faults on our side"
rule (uid `cfwbuusjni8sge`) 2026-11-12 07:22 UTC; read back from the API.
Originally planned 2026-11-12 05:08 UTC on `main` @ `00bff8b`.

## Why

The x402 Exact EVM spec names EIP-3009 the recommended transfer method and the default when
`PaymentRequired.extra.assetTransferMethod` is absent. This facilitator only accepts `permit2`
(`src/routes/verify.ts:368`, `src/routes/settle.ts:745`, `src/evm/permit2.ts:57`), so a stock
client paying SBC with default settings is refused here. Brale upgraded SBC on Base mainnet to
an implementation with EIP-3009 on 2026-10-07 17:38:23 UTC. Radius's facilitator already
advertises `eip3009` for SBC on Base (8453) and Radius (723487) (live `/supported`, read
2026-11-12 05:05 UTC).

EIP-3009 is one on-chain call, needs no prior `approve(Permit2)`, and binds the recipient (`to`)
in the payer's signature, so no proxy is needed.

## Capability table (on-chain reads, 2026-11-12 ~05:05 UTC)

| Chain / token | `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` | EIP-712 domain | Plan |
|---|---|---|---|
| Base `0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798` (SBC) | standard `0x7c7c…2267` | `"Stable Coin"`, `"1"`, 8453 | enable |
| Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC) | standard | `name()` "USD Coin", `version()` "2" (read 2026-11-12 06:46–06:58 UTC) | enable |
| Radius `0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb` (SBC, 723487) | standard | `"Stable Coin"`, `"1"`, 723487 | enable |
| Radius testnet `0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb` (SBC, 72344) | standard | `"Stable Coin"`, `"1"`, 72344 | enable |
| Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (USDC) | standard | `name()` "USDC", `version()` "2" | enable (test chain) |
| Base Sepolia `0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16` (SBC) | **reverts** | `"Stable Coin"`, `"1"` | **Permit2 only** |

Typehash present is not proof the function works. For Base SBC only, the implementation
`0x9f06bc5dfbb9a5938f4337458794fa23f6e9b1b1` bytecode contains the selectors for both
`transferWithAuthorization` overloads (v/r/s `0xe3ee160e`, `bytes` `0xcf092995`),
`receiveWithAuthorization`, `authorizationState` and `cancelAuthorization` (selector grep, not
execution). The fork test in step 6 is what proves execution.

## Design decisions

1. **New module `src/evm/eip3009.ts`** beside `permit2.ts`: strict parse, bind to requirements,
   `verifyTypedData` against the token domain, ABI. Do not revive the unreachable ERC-2612 block
   further down `settle.ts`/`verify.ts`: it reads the same `payload.authorization` field names, but
   there `to` is the spender; in EIP-3009 `to` is the recipient.
2. **Dispatch on `assetTransferMethod`, never on payload shape.** `permit2` → existing path.
   `eip3009` **or absent** → new path (spec default). Absent on a token without EIP-3009 (Base
   Sepolia SBC) → `unsupported_asset_transfer_method`.
3. **Capability is config, per token.** Add `transferMethods` to `resolveToken()` results. Domain
   name/version come from `resolveToken()`, never from the client. `accepted.extra` must equal
   `paymentRequirements.extra` (same check the Permit2 path does).
4. **Binding checks:** `authorization.to == payTo`, `value == amount` exactly, asset == token,
   `from != to` (self-payment), `validAfter <= now`, `validBefore` at least 6 s out on `/settle`
   (upstream's margin; 30 s would refuse every stock payment from a seller with
   `maxTimeoutSeconds <= 30`), nonce is 32 bytes.
5. **EOA signatures only in v1.** Accept a 65-byte signature and call the v/r/s overload (upstream
   `@x402/evm` does the same for 130-hex signatures). Reject anything else with
   `invalid_exact_evm_payload_signature`. ERC-1271 / ERC-6492 smart wallets are a later step.
6. **Settle reuses the existing EVM wrapper:** per-EOA `settlementQueue`, simulate inside the
   queue (skipped on Radius, as today), Radius `gasPrice` override, receipt-status check,
   `settlement_pending` with the hash on a lost receipt. After success, also check the receipt has
   `Transfer(from, payTo, amount)` from the token (upstream does this).
7. **An already-used authorization: never answered `success`.** Before broadcasting, read
   `authorizationState(from, nonce)`. If used, answer `success: false`,
   `errorReason: "invalid_exact_evm_nonce_already_used"` (upstream's code), `transaction: ""`,
   metered as a client failure (not `tx_reverted`, which pages). The check runs twice: before
   anything else on chain, and again inside the per-signer queue right before broadcast, so a
   concurrent duplicate waits for the first and then finds the nonce used. A revert of our own
   broadcast is answered `invalid_transaction_state` with its hash, as on Permit2. This follows
   Eric's 2026-10-29 ~06:22 UTC decision for Permit2 ("match the upstream reference behavior",
   `docs/fixes/permit2-settled-retry-answers-failed.md` v3): after settlement the
   `transferWithAuthorization` calldata is public, anyone can rebuild the identical payment header,
   and a stock merchant branches only on `success` (`x402HTTPResourceServer.ts:871`), so answering
   `success` for a used authorization sells a second delivery. Upstream `@x402/evm@2.26.0`
   `settleEIP3009` answers success only on a hit in its pending-settlement store (a retry after its
   own `settlement_pending`); otherwise it re-verifies and fails on the used nonce.
   **Lost-receipt retry (a retry after our own `settlement_pending`) stays unhandled in v1,** the
   same as Permit2 today: that pending record was designed (the Permit2 brief, Option A, keyed on
   the full message + chain + signature and bound to our own transaction's calldata) and parked on
   2026-11-02 for low volume. When it is built, build it once for both methods.
8. **`/supported`:** one extra kind per enabled token with `assetTransferMethod: "eip3009"`,
   alongside the existing `permit2` kind (Radius's facilitator publishes the same two-kind shape).

**Decision (settled by precedent, not new):** item 7 applies the 2026-10-29 Permit2 decision to
EIP-3009. An earlier draft of this plan (2026-11-12 05:08 UTC) recommended answering `success`
from a chain lookup; that is the brief's Option C, rejected for the replay reason above.

## Build options

- **A. Hand-rolled, like `permit2.ts` (recommended).** Fits the existing wrapper and repo rules.
- **B. Upstream `@x402/evm` facilitator scheme.** Its v2 `settleEIP3009`
  (`dist/esm/exact/facilitator/index.mjs:286`) does answer `settlement_pending` with the hash, but
  puts the truncated raw error text in `errorMessage` (repo rule: raw RPC text never reaches a
  response), keys its pending store on the signature alone (the false-success hole the Permit2
  brief v4 documents), and needs its own signer wiring around our queue. The v1 class
  (`chunk-FMP2UM2G.mjs` ~398–484) also drops the hash on a receipt failure. Use upstream as reference and as the
  **client** in acceptance tests, not as the settler.

## Steps

1. Docs first: fix stale repo `CLAUDE.md` (says settlement is ERC-2612 `permit()` +
   `transferFrom()` and "SBC token uses ERC-2612 Permit, NOT EIP-3009"; live code is Permit2 via
   proxy) and the README line "SBC token doesn't support EIP-3009". Add the EIP-3009 rules.
2. Config: `transferMethods` per token from the capability table.
3. `src/evm/eip3009.ts` + unit tests (parse, binding, signature, spec default).
4. `/verify` path: parse → bind → signature → `authorizationState` → balance → `eth_call`
   simulate (not on Radius).
5. `/settle` path: items 6–7 above. `/supported` kinds.
6. **Fork test** (`anvil --fork-url` Base mainnet): real SBC implementation, signed authorization
   settles through local routes; balances move exactly; re-present returns the same hash; a
   front-run (submit directly, then `/settle`) returns that hash; forged signature, wrong `to`,
   wrong value, expired, wrong domain all refused with nothing on chain.
7. Mutation check: delete the `to == payTo` binding and the `authorizationState` pre-check; the
   tests in 3/6 must go red.
8. Stock-client proof through the **deployed host**: `@x402/evm` client, default settings (no
   `assetTransferMethod`), Base Sepolia USDC → Radius testnet SBC → small real Base mainnet SBC
   payment → Radius mainnet SBC. Record tx hashes and before/after balances. Base mainnet SBC has
   no `AuthorizationUsed` log since the upgrade (per a 2026-11-12 scan to block 56328615), so this
   would be the first.
9. Pin `@x402/evm` exact (also `@x402/core`/`@x402/svm`, currently `^2.26.0`).

## Not verified

- Radius tokens: typehash and domain only; no selector or execution check.
- Smart-wallet signatures (out of scope v1).
- Upstream v2 facilitator settle error handling (only v1 class read).
