# x402-facilitator

SBC x402 Facilitator — verifies and settles payments using the [x402 protocol](https://github.com/coinbase/x402) (v2).

Uses the standard x402 Permit2 Exact EVM flow for EVM chains and the standard payer-signed x402 SVM Exact flow for Solana. SBC's ERC-2612 support is used only by the optional `eip2612GasSponsoring` extension to establish Permit2 allowance.

**[x402 v2 Compatibility →](./x402-COMPATIBILITY.md)** — unit suite green (`npm test`); the `npm run conformance` harness still builds legacy ERC-2612 EVM payloads and is pending migration to Permit2 | **[Observability →](./grafana/README.md)**

## Supported Networks

| Network | CAIP-2 ID | Env Prefix | Mechanism |
|---------|-----------|-----------|-----------|
| Base | `eip155:8453` | `BASE_` | Permit2 + canonical x402 proxy |
| Base Sepolia | `eip155:84532` | `BASE_SEPOLIA_` | Permit2 + canonical x402 proxy |
| Radius | `eip155:723487` | `RADIUS_` | Permit2 + canonical x402 proxy |
| Radius Testnet | `eip155:72344` | `RADIUS_TESTNET_` | Permit2 + canonical x402 proxy |
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `SOLANA_` | Payer-signed SVM Exact + facilitator fee sponsorship |

Each network has its own env vars — mainnets and testnets can be configured simultaneously.

## Setup

```bash
npm install
cp .env.example .env  # configure facilitator keys per network
```

## Concurrency & Settlement Safety

- **Per-EOA settlement queue** — On-chain execution is serialized per facilitator wallet to prevent nonce collisions. Critical for chains without a mempool (e.g. Radius) where concurrent nonce submissions fail immediately. Different chains settle in parallel since they use separate wallets.
- **Idempotent settle** — Real EVM Permit2 consumes an on-chain nonce. Solana Exact accepts a payer-signed immutable transaction; retries submit the same bytes and Solana deduplicates that transaction on-chain. The SVM scheme also keeps a short in-flight cache to reject duplicate settlement requests before confirmation.
- **`settlement_pending` is not a failure** — If the Permit2 settlement is broadcast and the receipt cannot be read (RPC timeout, node error), `/settle` answers `{ success: false, errorReason: "settlement_pending", transaction: "0x..." }`. The transaction may still confirm. Per the x402 v2 spec this response always carries the broadcast hash: **reconcile that hash on chain before deciding anything**. Do not treat it as did-not-happen and sign a fresh authorization — that is a second payment. Re-presenting the same payload is also not useful: the Permit2 nonce is consumed on chain, so the retry reverts.
- **Reverted tx carries its hash** — If the Permit2 settlement is mined and reverts, `/settle` answers `{ success: false, errorReason: "invalid_transaction_state", transaction: "0x..." }` with the reverted tx hash for on-chain debugging.

## Authentication

The facilitator is permissionless — no API key needed. Rate limiting is applied to payment endpoints.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/supported` | Capability discovery — returns `kinds`, `extensions`, `signers` |
| `POST` | `/verify` | Verify a `paymentPayload` (v2 JSON object) |
| `POST` | `/settle` | Execute on-chain settlement |
| `GET` | `/health` | Liveness plus the resolved settlement mode (`real`/`simulated`/`disabled`); the bundled demo refuses to settle unless it reads `simulated` |

### v2 Request Format

`/verify` and `/settle` accept:

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": "https://...",
    "accepted": {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x...",
      "payTo": "0x...",
      "extra": { "assetTransferMethod": "permit2", "name": "Stable Coin", "version": "1" }
    },
    "payload": {
      "signature": "0x...",
      "permit2Authorization": {
        "from": "0x...",
        "permitted": { "token": "0x...", "amount": "10000" },
        "spender": "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
        "nonce": "0",
        "deadline": "1700000000",
        "witness": { "to": "0x...", "validAfter": "0" }
      }
    },
    "extensions": {}
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "10000",
    "asset": "0x...",
    "payTo": "0x...",
    "maxTimeoutSeconds": 60,
    "extra": { "assetTransferMethod": "permit2", "name": "Stable Coin", "version": "1" }
  }
}
```

`payload.permit2Authorization` is the signed Permit2 witness. `spender` is the canonical x402 proxy (`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`), `permitted.token` is the asset, and `witness.to` is the merchant `payTo` — the proxy enforces `witness.to`, so the facilitator cannot redirect the payment. If the payer has not pre-approved Permit2 on-chain, add an `eip2612GasSponsoring` extension under `extensions` carrying a signed SBC ERC-2612 permit. Its `info` object holds `from`, `asset`, `spender` (the Permit2 contract `0x000000000022D473030F116dDEE9F6B43aC78BA3`), `amount`, `nonce`, `deadline`, `signature`, and `version: "1"`. The sponsored `amount` must equal the exact payment amount (an over-broad allowance is rejected) and `deadline` must be at least the Permit2 authorization `deadline`.

## Configuration

All config via `.env` — see `.env.example`. Each network is independent: only networks with a `FACILITATOR_PRIVATE_KEY` and `FACILITATOR_ADDRESS` set will appear in `/supported`.

The server auto-selects the next available port if `FACILITATOR_PORT` (default 3001) is in use.

### Settlement modes

| `ENABLE_REAL_SETTLEMENT` | `ALLOW_SIMULATED_SETTLEMENT` | `/settle` behavior |
|---|---|---|
| `true` | any | Real on-chain settlement (production) |
| not `true` | `true` | Simulated: no on-chain call, fabricated hash, response carries header `X-Settlement-Mode: simulated` (local development and the bundled demo) |
| not `true` | not `true` | Refuses: `success: false`, `errorReason: "settlement_disabled"` |

Simulation is opt-in. A deployment with neither flag set refuses to settle rather than reporting a settlement that never happened.

`ENABLE_REAL_SETTLEMENT=true` enables real EVM and standard SVM Exact settlement. Solana requires a payer-signed transaction whose `feePayer` is the configured facilitator; the facilitator never uses delegated SPL authority.

## Demo

Interactive demo using SBC tokens. Generates wallets, checks balances, grants the on-chain Permit2 approval settlement needs, then sends a v2 verify + settle request.

> **Safety:** `npm run setup` broadcasts a real ERC-20 `approve(Permit2, 100 SBC)` transaction and costs gas. It gives the facilitator no allowance, but gives Permit2 a standing 100 SBC allowance. Use `--network base-sepolia` for an investor demo unless the mainnet wallet is intentionally funded and approved. The generated configuration uses simulated settlement; the client refuses a real or unknown server unless `DEMO_ALLOW_REAL_SETTLEMENT=true` is explicitly set.
>
> The bundled demo client uses the standard Exact EVM Permit2 witness flow. The mainnet smoke script (`scripts/smoke-mainnet.ts`) and conformance harness (`src/__tests__/conformance.ts`) still need their own Permit2 migration. Radius and Radius testnet are not investor-demo targets until the canonical Permit2 and x402 proxy deployments have been bytecode-verified and a real testnet settlement has passed.

```bash
npm run setup -- --network <name>   # generate wallets, approve, write .env
npm run dev                          # starts the facilitator in simulated demo mode
npm run demo -- --network <name>     # signs, verifies, and simulates a payment
```

**Networks:** `base` (default), `base-sepolia`, `radius`, `radius-testnet`

If the server landed on a different port (e.g. 3002), pass it to the demo:

```bash
FACILITATOR_PORT=3002 npm run demo -- --network radius-testnet
```

To run against a deployed facilitator instead of a local server:

```bash
FACILITATOR_URL=https://x402.stablecoin.xyz npm run demo -- --network radius-testnet
```

For SBC, clients sign a Permit2 payment witness. They either approve Permit2 once on-chain or include the standard `eip2612GasSponsoring` extension, which lets the canonical x402 proxy submit an SBC ERC-2612 approval and settle atomically. The witness binds the merchant recipient and exact amount.

## Observability

Structured JSON logging (Pino) with request correlation via `X-Request-ID` header. Prometheus metrics on `/metrics`.

### Logs

Logs ship to Grafana Cloud Loki via [sbc-log-shipper](https://github.com/stablecoinxyz/fly-log-shipper). Locally:

```bash
npm run dev | npx pino-pretty
```

Set `LOG_LEVEL` env var to control verbosity (`debug`, `info`, `warn`, `error`). Default: `info`.

### Metrics

`/metrics` exposes Prometheus metrics, protected by `METRICS_TOKEN` env var (bearer auth). Returns 404 if unset.

| Metric | Type | Labels |
|--------|------|--------|
| `x402_verify_total` | Counter | `network`, `result` (valid/invalid/bad_request/rpc_error/unknown) |
| `x402_settle_total` | Counter | `network`, `result` (success/failed/settlement_pending/settlement_disabled/settlement_proxy_unavailable/settlement_asset_unavailable/replay/bad_request/insufficient_allowance/nonce_conflict/gas_error/invalid_signature/tx_reverted/rpc_error/receipt_timeout/unknown; `expired` is a legacy label no live path emits — see [grafana/README.md](./grafana/README.md#settle-result-labels)) |
| `x402_verify_duration_seconds` | Histogram | `network` |
| `x402_settle_duration_seconds` | Histogram | `network` |
| Default process metrics | — | CPU, memory, event loop lag |

```bash
# Local test
METRICS_TOKEN=test npm run dev
curl localhost:3001/metrics -H "Authorization: Bearer test"
```

### Grafana Cloud

- **Stack**: `sbclogs.grafana.net`
- **Loki** (logs): query with `{app="sbc-x402-facilitator"} | json`
- **Prometheus** (metrics): scraped by [sbc-grafana-alloy](https://github.com/stablecoinxyz/grafana-alloy) → remote-write to Grafana Cloud

Example LogQL queries:
```
# All settle errors on Base
{app="sbc-x402-facilitator"} | json | action="settle" | level="error" | network="eip155:8453"

# Trace a request
{app="sbc-x402-facilitator"} | json | requestId="<uuid>"
```

Example PromQL queries:
```
# Settle success rate (5m window)
sum(rate(x402_settle_total{result="success"}[5m])) / sum(rate(x402_settle_total[5m]))

# Verify latency p95
histogram_quantile(0.95, rate(x402_verify_duration_seconds_bucket[5m]))

# Settle errors by network
sum by (network) (rate(x402_settle_total{result!="success"}[5m]))
```

### Alert rules (Grafana)

See [`grafana/alerts.yaml`](./grafana/alerts.yaml) for full PromQL expressions.

These mirror the generated `grafana/alerts.yaml` snapshot (regenerated from live Grafana, not hand-edited):

| Alert | Severity | Fires when |
|-------|----------|-----------|
| Facilitator unreachable | Critical | `/metrics` unreachable for 5min |
| Settle faults on our side | Critical | 2+ facilitator-fault settle errors in 15min |
| Verify faults on our side | Critical | 3+ facilitator-fault verify errors in 15min |
| Facilitator restart loop | Warning | 4+ restarts in 30min |
| Nonce conflicts detected | Warning | Any nonce conflict in 15min |
| Settle latency p95 high | Warning | p95 settle latency > 60s over 30min |
| Client error volume elevated | Info | 20+ client-side settle rejections in 1h |
| Permit expired attempts (dashboard only) | Info | 10+ `expired`-result attempts in 1h — legacy label no live path emits |
| Settlement succeeded | Info | Any successful settle in 1h |

## Development

```bash
npm run dev           # watch mode (auto-restart)
npm test              # run the test suite
npm run build         # compile TypeScript
npm start             # production
fly deploy            # deploy to Fly.io
```
