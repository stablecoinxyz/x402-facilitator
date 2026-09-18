# Security assessment — 2026-09-17

Scope: application code, deployment configuration, installed production dependency graph, and x402 protocol requirements. This is a source review, not a penetration test of the deployed Fly application or its RPC and Casper-facilitator dependencies.

## Status update — `feat/permit2-exact-evm`

The findings below were reviewed against commit `f904799`; the Permit2 migration on this branch has since moved or removed the cited code. Code references are pinned to that review commit (`.../blob/f904799/...`); the original per-line anchors were dropped because they did not resolve to the described code even at `f904799`, so a reviewer should re-locate the exact lines rather than trust an anchor. Addressed here in code (not yet re-verified on chain):

- **Critical (EVM permits do not bind `payTo`)** and **High (EVM transfers the permit maximum)** — EVM Exact settlement now requires a Permit2 witness that binds `witness.to` and the exact `permitted.amount`, enforced by the canonical x402 proxy; legacy ERC-2612 EVM payloads are rejected.
- **High (Radius skips the only pre-broadcast validity check)** — partially addressed: the Permit2 EIP-712 signature is now verified locally on every chain before settlement; Radius still skips the on-chain proxy simulation.

Not addressed here and queued in [`TODO.md`](../TODO.md): durable Solana settlement (real Solana is now fail-closed and not advertised), unbounded queue/rate controls, Casper error reflection, and the production dependency advisories.

## Executive summary

As of the original review (`f904799`), neither the Solana nor the public EVM settlement path was safe for production. The EVM binding gap is addressed on `feat/permit2-exact-evm` (see the status update above; code-level, not yet re-verified on chain): an ERC-2612 permit approves a spender but does not bind a transfer recipient, and the pre-migration facilitator took the recipient from an untrusted settlement request — the Permit2 witness now binds recipient and exact amount. The Solana double-pay gap remains open, so do not use the Solana settlement path for production payments until it is resolved: Solana replay protection is process-local and is deliberately not recorded after a broadcast whose confirmation cannot be read, so the same signed authorization can result in more than one token transfer.

Useful safeguards already exist: 100 KB JSON bodies, malformed-signature rejection, bounded in-process nonce records, serialized EVM account nonces, and separate real/simulated settlement modes. These do not address the authorization-binding and durability gaps below.

## Findings

### Critical — EVM permits do not bind `payTo`; a captured permit can be spent to an attacker recipient

**Status: Resolved on `feat/permit2-exact-evm`** (code-level, not yet re-verified on chain). The description below is the reviewed `f904799` behavior; EVM Exact settlement now requires a Permit2 witness binding `witness.to` and the exact `permitted.amount`, enforced by the canonical x402 proxy.

`Permit(owner, spender, value, nonce, deadline)` has no recipient field. The service verifies only that the permit authorizes its facilitator as spender ([`src/routes/verify.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/verify.ts)), then takes the transfer recipient directly from `paymentRequirements.payTo` ([`src/routes/settle.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/settle.ts)) and transfers the full permit value to it ([`src/routes/settle.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/settle.ts)). The apparent recipient check in verify compares `payTo` with itself ([`src/routes/verify.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/verify.ts)).

Anyone who obtains a still-valid permit payload can submit it with a different `payTo`; the public facilitator has the approval needed to execute the payment. This is a funds-loss issue, not merely a malformed-request issue.

**Fix:** use an authorization primitive that signs the recipient and exact amount (the x402 Exact EVM reference uses EIP-3009 transfer authorization), or require a verifiable merchant-issued, recipient-bound settlement instruction. Do not treat an unsigned `paymentRequirements.payTo` as an authorization input.

### Critical — Solana authorization can be paid twice after an uncertain broadcast or process restart

**Status: Mitigated (feature withheld)** — real Solana settlement now fails closed with `solana_durability_unavailable` and Solana is absent from `/supported`. The durable implementation remains queued in [`TODO.md`](../TODO.md); Permit2 does not address it because Permit2 is EVM-only.

The signed Solana message includes a nonce, but that nonce is not consumed by the SPL Token program. Replay state is only the in-memory `NonceTracker` ([`src/protection/nonce-tracker.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/protection/nonce-tracker.ts)). After `sendRawTransaction` succeeds but confirmation errors, settlement returns `settlement_pending` ([`src/solana/settle.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/solana/settle.ts)); the caller records a nonce only for `success` ([`src/routes/settle.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/settle.ts)). A retry can therefore broadcast the same delegated transfer again. Restarting or running another instance also empties the replay record.

**Required before re-enabling:** persist an atomic authorization state machine before broadcast (`new → broadcast(hash) → confirmed/failed`), return the stored hash for every retry, and reconcile pending signatures asynchronously. Use a shared durable store across instances/restarts; never rebroadcast a known authorization.

### High — EVM settlement transfers the permit maximum, not the requested exact amount

**Status: Resolved on `feat/permit2-exact-evm`** (code-level, not yet re-verified on chain). The Permit2 witness binds the exact `permitted.amount`, enforced by the canonical x402 proxy; the reviewed `f904799` behavior below no longer applies.

The code permits `value >= paymentRequirements.amount` ([`src/routes/settle.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/settle.ts)) but passes `value`, not the required amount, to `transferFrom` ([`src/routes/settle.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/settle.ts)). A user who signed a permit with headroom can be overcharged.

**Fix:** bind an exact amount in the signed authorization. As a temporary defense, require equality and transfer only the validated requirement amount; do not silently interpret `value` as both a maximum approval and invoice total.

### High — Radius skips the only pre-broadcast validity simulation, enabling paid invalid-permit spam

**Status: Partially resolved on `feat/permit2-exact-evm`** (code-level, not yet re-verified on chain). The Permit2 EIP-712 signature is now verified locally on every chain before settlement, so an invalid signature no longer reaches a real transaction; Radius still skips the on-chain proxy simulation.

For Radius, on-chain simulation is skipped ([`src/routes/settle.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/routes/settle.ts)) and — at `f904799` — a well-formed but invalid ECDSA signature proceeded to a real `permit` transaction. Since settlement is permissionless, attackers could repeatedly consume facilitator gas with their own invalid payloads.

**Fix:** verify EIP-712 locally against the token's fixed domain before every real settlement, regardless of chain, and add economic/rate controls for gas-spending calls.

### High — queue and rate controls are process-local and unbounded

**Status: Open** — queued in [`TODO.md`](../TODO.md) (bounded shared queues, deadlines, global rate limiting); not addressed by the Permit2 migration.

The per-wallet settlement queue has no maximum length, timeout, cancellation, or admission control ([`src/lib/settlement-queue.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/lib/settlement-queue.ts)). The rate limiter is an in-memory IP map ([`src/protection/rate-limiter.ts`](https://github.com/stablecoinxyz/x402-facilitator/blob/f904799/src/protection/rate-limiter.ts)); it does not coordinate instances and, without Express proxy trust configuration, may see the reverse proxy rather than the client IP. A distributed requester can retain unbounded requests while an RPC call or receipt wait stalls.

**Fix:** use a shared rate limiter and durable queue, cap queue depth and wait time, set explicit RPC/receipt deadlines, and configure `trust proxy` only for the known Fly proxy topology. Apply stricter quotas/cost controls to `/settle`.

### Medium — Casper errors from the upstream service are reflected to callers

**Status: needs author confirmation** — the cited `src/casper/verify.ts` and `src/casper/settle.ts` are **not present in this repository** at `f904799` or on `feat/permit2-exact-evm` (`git grep -il casper` returns nothing under `src/`). Casper is a separate SBC facilitator service; whoever owns this assessment should confirm whether this finding targets that separate service (and re-point the citation) or is stale for this repo.

The Casper verification and settlement catches return `error.message` directly. The upstream response's error text is included in that message by the client. This can disclose upstream implementation, request, or provider details.

**Fix:** log the detailed error server-side with redaction; return fixed x402 error codes and opaque correlation IDs.

### Medium — production dependency graph has 17 known advisories

**Status: Open** — queued in [`TODO.md`](../TODO.md) (upgrade Express/viem/uuid, evaluate Solana SDK migration, make audit a CI gate). Counts below are as of the review scan (`f904799`, 2026-09-17).

`npm audit --omit=dev` reported 6 high and 11 moderate advisories. Direct affected packages include Express 4.21.2 (upgrade to 4.22.3), viem 2.43.5 (upgrade to 2.56.6), uuid 13.0.0 (upgrade to 13.0.1), and the Solana SDK dependency tree. The latter includes `bigint-buffer` buffer overflow, `ws` memory exhaustion, and `bn.js` DoS paths. The audit's automatic Solana fix recommendation is a major-version downgrade and must be evaluated against the maintained Solana SDK migration path, not applied blindly.

**Fix:** patch Express, viem, and uuid immediately; plan and test a supported Solana SDK migration; make audit/lockfile checks release gates.

## Protocol references

- [x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
- [x402 Exact EVM scheme](https://github.com/coinbase/x402/tree/main/typescript/packages/x402/src/schemes/exact/evm)
- [EIP-2612 Permit](https://eips.ethereum.org/EIPS/eip-2612)
- [EIP-3009 Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)

The key design distinction is intentional in these standards: EIP-2612 signs an allowance (`owner`, `spender`, `value`, `nonce`, `deadline`), whereas EIP-3009 signs a transfer that includes `from`, `to`, and `value`.

## Verification performed

Measured at the review base (`f904799`); the Permit2 migration on `feat/permit2-exact-evm` has since changed the test suite, so re-run these rather than trusting the numbers here.

- `npm run build` — passed.
- `npm test -- --runInBand` — passed: 15 suites, 373 passed, 1 skipped.
- `npm audit --omit=dev --json` — 17 production advisories, 6 high.
