# Fix briefs

One file per defect. Each is self-contained for an agent with no prior context.

| Brief | Status | Hook |
|---|---|---|
| [permit2-settled-retry-answers-failed](permit2-settled-retry-answers-failed.md) | OPEN — design decided (upstream parity) | Retried `/settle` after our `settlement_pending` answers failure with no hash; port upstream's pending-settlement record |
