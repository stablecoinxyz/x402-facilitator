# Security follow-up queue

## Next: Sui support

- Read `docs/sui-facilitator-spec.md` and `docs/sui-integration-plan.md`. The
  agent payment platform is adding Sui, which requires this facilitator to
  support Sui (added 2026-10-29).

## Next: settlement durability and abuse controls

- Build the retried-Permit2-settle fix:
  `docs/fixes/permit2-settled-retry-answers-failed.md` (spec decided, not
  implemented; §9.1 needs an owner sign-off before merge).
- Persist Solana authorization state atomically before broadcast and reconcile
  uncertain broadcasts; shared state must survive restarts/replicas.
- Add bounded shared settlement queues, request/RPC deadlines, global rate
  limiting, and per-chain facilitator gas budgets.
- Verify configured EOA addresses match their private keys at startup.

## Next: hardening

- Return opaque Casper upstream errors; keep detailed cause only in redacted
  server logs.
- Upgrade Express, viem, and uuid; evaluate a supported migration from the
  audited Solana SDK dependency tree.
- Make lockfile-aware dependency audit a CI/release gate.
