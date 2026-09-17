# Security follow-up queue

## Next: settlement durability and abuse controls

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
