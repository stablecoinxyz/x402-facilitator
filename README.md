# x402-facilitator

SBC x402 Facilitator — verifies and settles payments using the [x402 protocol](https://github.com/coinbase/x402) (v2).

Uses ERC-2612 Permit for EVM chains (SBC token doesn't support EIP-3009) and delegated SPL transfers for Solana. The facilitator never holds customer funds.

**[x402 v2 Compatibility →](./x402-COMPATIBILITY.md)** — 36/36 checks passing | **[Observability →](./grafana/README.md)**

## Supported Networks

| Network | CAIP-2 ID | Env Prefix | Mechanism |
|---------|-----------|-----------|-----------|
| Base | `eip155:8453` | `BASE_` | ERC-2612 Permit + TransferFrom |
| Base Sepolia | `eip155:84532` | `BASE_SEPOLIA_` | ERC-2612 Permit + TransferFrom |
| Radius | `eip155:723487` | `RADIUS_` | ERC-2612 Permit + TransferFrom |
| Radius Testnet | `eip155:72344` | `RADIUS_TESTNET_` | ERC-2612 Permit + TransferFrom |
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `SOLANA_` | Delegated SPL token transfer |

Each network has its own env vars — mainnets and testnets can be configured simultaneously.

## Setup

```bash
npm install
cp .env.example .env  # configure facilitator keys per network
```

## Concurrency & Settlement Safety

- **Per-EOA settlement queue** — On-chain execution is serialized per facilitator wallet to prevent nonce collisions. Critical for chains without a mempool (e.g. Radius) where concurrent nonce submissions fail immediately. Different chains settle in parallel since they use separate wallets.
- **Idempotent settle** — If a permit nonce was already settled, `/settle` returns the original `{ success: true, transaction: "0x..." }` instead of failing. Enables safe retries when HTTP responses are lost.
- **Partial tx hash on failure** — If `permit()` succeeds but `transferFrom()` fails, the permit tx hash is included in the error response for on-chain debugging.

## Authentication

The facilitator is permissionless — no API key needed. Rate limiting is applied to payment endpoints.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/supported` | Capability discovery — returns `kinds`, `extensions`, `signers` |
| `POST` | `/verify` | Verify a `paymentPayload` (v2 JSON object) |
| `POST` | `/settle` | Execute on-chain settlement |
| `GET` | `/health` | Health check |

### v2 Request Format

`/verify` and `/settle` accept:

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": "https://...",
    "accepted": { "scheme": "exact", "network": "eip155:8453" },
    "payload": {
      "signature": "0x...",
      "authorization": {
        "from": "0x...",
        "to": "0x...",
        "value": "10000",
        "validAfter": "0",
        "validBefore": "1700000000",
        "nonce": "0"
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
    "extra": { "assetTransferMethod": "erc2612", "name": "Stable Coin", "version": "1" }
  }
}
```

## Configuration

All config via `.env` — see `.env.example`. Each network is independent: only networks with a `FACILITATOR_PRIVATE_KEY` and `FACILITATOR_ADDRESS` set will appear in `/supported`.

The server auto-selects the next available port if `FACILITATOR_PORT` (default 3001) is in use.

## Demo

Interactive demo using SBC tokens. Generates wallets, checks balances, approves the facilitator, then sends a v2 verify + settle request.

```bash
npm run setup -- --network <name>   # generate wallets, approve, write .env
npm run dev                          # start server (Terminal 1)
npm run demo -- --network <name>    # run demo client (Terminal 2)
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

The demo client signs an ERC-2612 Permit off-chain (no gas), then the facilitator calls `permit()` + `transferFrom()` on-chain to move SBC from Client → Merchant. The client wallet needs SBC; the facilitator only needs ETH for gas.

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
| `x402_settle_total` | Counter | `network`, `result` (success/failed/replay/expired/bad_request/insufficient_allowance/nonce_conflict/gas_error/invalid_signature/tx_reverted/rpc_error/receipt_timeout/unknown) |
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

| Alert | Condition |
|-------|-----------|
| Settle failure rate high | Non-success rate > 10% over 5min |
| RPC errors spiking | 3+ RPC failures in 5min |
| Nonce conflicts detected | Any nonce collision |
| Permit expired attempts | Any expired permit settle |
| Signature errors spiking | 3+ invalid signatures in 5min |
| Health down | No facilitator logs for 10min |

## Development

```bash
npm run dev           # watch mode (auto-restart)
npm test              # run tests (187 tests)
npm run build         # compile TypeScript
npm start             # production
fly deploy            # deploy to Fly.io
```
