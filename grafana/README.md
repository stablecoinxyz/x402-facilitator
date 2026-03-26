# x402 Facilitator — Observability Stack

Complete observability for the x402 facilitator: structured logs, Prometheus metrics, Grafana dashboards, and alerting.

## Architecture

```
┌─────────────────────┐
│  x402-facilitator   │
│  (Fly: sbc-x402-    │
│   facilitator)      │
│                     │
│  Pino JSON logs ────┼──→ Fly NATS ──→ fly-log-shipper ──→ Grafana Cloud Loki
│  /metrics (Prom) ───┼──→ Alloy ──────────────────────────→ Grafana Cloud Prometheus
└─────────────────────┘
                                                              ↓
                                                     Grafana Dashboard
                                                     (dashboard.json)
                                                              ↓
                                                     Alert Rules
                                                     (alerts.yaml)
```

### Components

| Component | Fly App | Repo | What it does |
|-----------|---------|------|-------------|
| **Facilitator** | `sbc-x402-facilitator` | this repo | Emits pino JSON logs + exposes `/metrics` |
| **Log Shipper** | `sbc-log-shipper` | `~/code/sbc/fly-log-shipper` | Reads Fly NATS log stream, pushes to Loki |
| **Alloy** | `sbc-grafana-alloy` | `~/code/sbc/grafana-alloy` | Scrapes `/metrics` every 30s, pushes to Prometheus |
| **Grafana Cloud** | — | `sbclogs.grafana.net` | Dashboards, alerting, log/metric storage |

## Logs (Loki)

### How it works
1. Facilitator writes structured JSON via pino (not console.log)
2. Every log line includes: `requestId`, `action`, `network`, `payer`, `success`, `errorCategory`, `txHash`
3. Fly captures stdout → internal NATS stream
4. `sbc-log-shipper` (Vector) consumes NATS → pushes to Grafana Cloud Loki
5. Loki adds labels: `app`, `region`, `host`

### Key log fields

| Field | Example | When |
|-------|---------|------|
| `requestId` | `97cc1dc6-4cdb-...` | Every request |
| `action` | `verify` / `settle` | Every request |
| `network` | `eip155:8453` | After parsing |
| `payer` | `0xfa3F54...` | After parsing |
| `success` | `true` / `false` | On completion |
| `txHash` | `0x8ddcb0...` | Successful settle |
| `errorCategory` | `rpc_error` | On error |
| `errorReason` | `rpc_connection_error` | On error |

### Useful LogQL queries

```
# All facilitator logs
{app="sbc-x402-facilitator"}

# Settle requests only
{app="sbc-x402-facilitator"} | json | action="settle"

# All errors with category
{app="sbc-x402-facilitator"} | json | level="error"

# Errors on a specific network
{app="sbc-x402-facilitator"} | json | level="error" | network="eip155:723487"

# Trace a specific request
{app="sbc-x402-facilitator"} | json | requestId="<uuid>"

# Successful settlements with tx hash
{app="sbc-x402-facilitator"} | json | action="settle" | success="true"
```

## Metrics (Prometheus)

### How it works
1. Facilitator exposes `/metrics` (prom-client), protected by `METRICS_TOKEN` bearer auth
2. `sbc-grafana-alloy` scrapes every 30s with the bearer token
3. Alloy remote-writes to Grafana Cloud Prometheus

### Metrics exported

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `x402_verify_total` | Counter | `network`, `result` | Total verify requests |
| `x402_settle_total` | Counter | `network`, `result` | Total settle requests |
| `x402_verify_duration_seconds` | Histogram | `network` | Verify latency |
| `x402_settle_duration_seconds` | Histogram | `network` | Settle latency (includes on-chain) |

### Settle result labels

| Result | Meaning | Severity |
|--------|---------|----------|
| `success` | Settlement completed on-chain | OK |
| `failed` | Known failure (gas estimation, bad payload, unknown network) | Expected |
| `expired` | Permit deadline passed or within 30s safety margin | Expected |
| `replay` | Nonce already settled (duplicate request) | Expected |
| `bad_request` | Missing paymentPayload | Client error |
| `insufficient_allowance` | permit() succeeded but transferFrom sees no allowance | Investigate |
| `nonce_conflict` | Tx nonce collision (concurrent settlements) | Investigate |
| `gas_error` | Insufficient gas or gas price too low | Investigate |
| `invalid_signature` | ECDSA signature invalid on-chain | Client error |
| `tx_reverted` | Contract call reverted (generic) | Investigate |
| `rpc_error` | RPC timeout or connection failure | Infra issue |
| `receipt_timeout` | Tx submitted but receipt never found | Infra issue |
| `unknown` | Uncategorized error (check logs for detail) | Investigate |

### Verify result labels

| Result | Meaning |
|--------|---------|
| `valid` | Signature and all checks passed |
| `invalid` | Signature invalid, expired, wrong amount, etc. |
| `bad_request` | Missing paymentPayload |
| `rpc_error` | RPC connection failure during verification |
| `rpc_reverted` | On-chain call reverted during verification |
| `unknown` | Uncategorized error |

## Dashboard

### Import
1. Go to `sbclogs.grafana.net` → **Dashboards** → **New** → **Import**
2. Upload `dashboard.json` from this directory
3. Click **Import** (or overwrite if UID matches)

### Datasources required
- `grafanacloud-sbclogs-prom` — Prometheus (from Alloy)
- `grafanacloud-sbclogs-logs` — Loki (from fly-log-shipper)

If your datasource UIDs differ, find them at: Connections → Data sources → click the datasource → UID is in the URL. Then find/replace in `dashboard.json`.

### Panels

| Row | Panel | Shows |
|-----|-------|-------|
| Overview | Verify Rate | Current req/s |
| Overview | Settle Rate | Current req/s |
| Overview | Settle Success % | Success rate over selected time range |
| Overview | Verify Success % | Valid rate over selected time range |
| Rates | Verify Requests | Stacked by result over time |
| Rates | Settle Requests | Stacked by result over time |
| Latency | Verify Latency | p50 + p95 |
| Latency | Settle Latency | p50 + p95 |
| By Network | Verify by Network | Rate per CAIP-2 network |
| By Network | Settle by Network | Rate per CAIP-2 network |
| Errors | Settle Errors | All non-success results, stacked |
| Errors | Recent Errors | Loki log panel showing `level="error"` |

### Updating
Re-import `dashboard.json` — Grafana detects matching UID and offers to overwrite.

## Alert Rules

See `alerts.yaml` for PromQL expressions. To create in Grafana:

1. **Alerts & IRM** → **Alert rules** → **+ New alert rule**
2. Set datasource to `grafanacloud-sbclogs-prom`
3. Paste the PromQL from `alerts.yaml`
4. Set evaluation interval, `for` duration, and contact point

| Alert | Fires when | Severity |
|-------|-----------|----------|
| Settle failure rate high | Non-success rate > 10% for 5min | Critical |
| RPC errors spiking | 3+ RPC failures in 5min | Critical |
| Nonce conflicts detected | Any nonce collision | Warning |
| Permit expired attempts | Any expired permit settle | Warning |
| Signature errors spiking | 3+ invalid signatures in 5min | Warning |
| Health check down | No facilitator logs for 10min | Critical |

## Setup from Scratch

If setting up observability for a new facilitator:

### 1. Facilitator (already built in)
- Pino logger at `src/lib/logger.ts`
- Metrics at `src/lib/metrics.ts`
- Request ID middleware at `src/middleware/requestId.ts`
- Set `METRICS_TOKEN` env var on Fly to protect `/metrics`
- Set `LOG_LEVEL` env var (default: `info`)

### 2. Log Shipper
```bash
cd ~/code/sbc/fly-log-shipper
cp .env.example .env
# Fill in: APP_NAME, FLY_REGION, FLY_ORG, FLY_ACCESS_TOKEN, LOKI_HOST, LOKI_USERNAME, LOKI_PASSWORD
bash setup.sh
```

### 3. Alloy (Prometheus scraper)
```bash
cd ~/code/sbc/grafana-alloy
# Add a new prometheus.scrape block in config.alloy for the new service
# Set FACILITATOR_METRICS_TOKEN secret
fly deploy
```

### 4. Grafana
1. Import `dashboard.json`
2. Create alert rules from `alerts.yaml`

## Env Vars (on facilitator)

| Var | Default | Description |
|-----|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `METRICS_TOKEN` | — | Bearer token for `/metrics`. Unset = endpoint returns 404 |
