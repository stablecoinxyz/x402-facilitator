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

**Our log lines are nested twice, so every query needs two `json` stages.**
Fly wraps each app stdout line in its own envelope and puts the app's text in
`.message`. Our pino JSON is that text. So the first `| json` parses Fly's
envelope, `| line_format "{{.message}}"` promotes the inner pino line to be the
line, and the second `| json` parses that. A single `| json` only ever sees
Fly's fields (`event`, `fly`, `host`, `log`, `message`, `timestamp`) — it will
NOT see `action`, `msg`, `payer`, `txHash`, and filters on them silently match
nothing.

Prefix, used by every query below:

```
{app="sbc-x402-facilitator"} | json | line_format "{{.message}}" | json
```

```
# All facilitator logs (raw, both envelopes)
{app="sbc-x402-facilitator"}

# Settle requests only
{app="sbc-x402-facilitator"} | json | line_format "{{.message}}" | json | action="settle"

# All errors with category
{app="sbc-x402-facilitator"} | json | line_format "{{.message}}" | json | level="50"

# Errors on a specific network
{app="sbc-x402-facilitator"} | json | line_format "{{.message}}" | json | level="50" | network="eip155:723487"

# Trace a specific request
{app="sbc-x402-facilitator"} | json | line_format "{{.message}}" | json | requestId="<uuid>"

# Successful settlements with tx hash
{app="sbc-x402-facilitator"} | json | line_format "{{.message}}" | json | msg="Settlement complete"

# Count lines per app — sanity check that shipping works at all
sum by (app) (count_over_time({app=~".+"}[6h]))
```

Note `level` is pino's numeric level, not a word: `30`=info, `40`=warn,
`50`=error. `level="error"` matches nothing.

### If a query returns nothing

Check the pipeline is delivering before assuming it is broken:

```
sum by (app) (count_over_time({app=~".+"}[6h]))
```

If `sbc-x402-facilitator` appears with a healthy count, logs are arriving and
the query is at fault — almost always a missing second `json` stage. The
`sbc-log-shipper` app also runs a `blackhole` sink alongside the Loki one; it is
part of the upstream image and prints a periodic "Collected events" counter.
That is normal and does not mean logs are being discarded.

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
| `failed` | Known bad input (malformed or non-Permit2 payload, unsupported network) | Expected |
| `settlement_pending` | Broadcast succeeded but the receipt could not be read. Carries the tx hash — reconcile on chain. Pages (money may have moved) | Investigate |
| `settlement_disabled` | Neither `ENABLE_REAL_SETTLEMENT` nor `ALLOW_SIMULATED_SETTLEMENT` is set — a misconfigured deploy refusing every settle. Pages | Investigate |
| `settlement_proxy_unavailable` | The canonical x402 Permit2 proxy has no deployed bytecode on the target chain — a misconfigured chain refusing every Permit2 settle before broadcast. Pages | Investigate |
| `expired` | Legacy label. No live path emits it — an expired EVM Permit2 authorization is rejected and counted under `failed` (`invalid_exact_evm_payload_authorization_valid_before`). Only the removed ERC-2612 EVM settle path set this label | Legacy |
| `replay` | Nonce already settled (duplicate request). Emitted on Solana and simulated EVM only; live EVM Permit2 relies on the on-chain Permit2 nonce | Expected |
| `bad_request` | Missing paymentPayload | Client error |
| `insufficient_allowance` | Token allowance insufficient at transfer time | Investigate |
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

`alerts.yaml` is a **snapshot regenerated from the live Grafana rules** (curl command in its header) — the live rules are the source of truth, so change them in Grafana and re-export rather than hand-editing the file. The table below mirrors that snapshot.

| Alert | Severity | Fires when |
|-------|----------|-----------|
| Facilitator unreachable | Critical | `/metrics` unreachable (`up < 1`) for 5min |
| Settle faults on our side | Critical | 2+ facilitator-fault settle results (`rpc_error`/`receipt_timeout`/`settlement_pending`/`nonce_conflict`/`gas_error`/`insufficient_allowance`/`tx_reverted`/`unknown`/`settlement_disabled`/`settlement_proxy_unavailable`) in 15min |
| Verify faults on our side | Critical | 3+ facilitator-fault verify results (`rpc_error`/`rpc_reverted`/`unknown`) in 15min |
| Facilitator restart loop | Warning | 4+ process restarts in 30min |
| Nonce conflicts detected | Warning | Any `nonce_conflict` settle in 15min |
| Settle latency p95 high | Warning | p95 settle latency > 60s over 30min |
| Client error volume elevated | Info | 20+ client-side settle rejections (`bad_request`/`expired`/`invalid_signature`/`failed`) in 1h |
| Permit expired attempts (dashboard only) | Info | 10+ `expired`-result attempts in 1h — legacy label no live path emits |
| Settlement succeeded | Info | Any successful settle in 1h |

To reconstruct a rule in Grafana from the snapshot: **Alerts & IRM** → **Alert rules** → **+ New alert rule**, datasource `grafanacloud-sbclogs-prom`, paste the PromQL and set the `for` duration and contact point from `alerts.yaml`.

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
2. Recreate the alert rules from the `alerts.yaml` snapshot (the live Grafana rules are the source; re-export after changing them)

## Env Vars (on facilitator)

| Var | Default | Description |
|-----|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `METRICS_TOKEN` | — | Bearer token for `/metrics`. Unset = endpoint returns 404 |
