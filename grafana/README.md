# Grafana Dashboard & Alerts

Observability setup for the x402 facilitator on Grafana Cloud (`sbclogs.grafana.net`).

## Import Dashboard

1. Go to `sbclogs.grafana.net` → **Dashboards** → **New** → **Import**
2. Click **Upload dashboard JSON file** → select `dashboard.json` from this directory
3. Click **Import**

The dashboard expects these datasources (auto-provisioned by Grafana Cloud):
- **grafanacloud-sbclogs-prom** — Prometheus (metrics from Alloy)
- **grafanacloud-sbclogs-logs** — Loki (logs from fly-log-shipper)

If your Loki datasource UID differs, edit the JSON and replace `grafanacloud-sbclogs-logs` with your actual UID. Find it at: Connections → Data sources → click Loki → the UID is in the URL.

## Dashboard Panels

| Row | Panel | Query |
|-----|-------|-------|
| Overview | Verify Rate | `sum(rate(x402_verify_total[5m]))` |
| Overview | Settle Rate | `sum(rate(x402_settle_total[5m]))` |
| Overview | Settle Success % | Success / total * 100 (gauge, red < 80, yellow < 95) |
| Overview | Verify Success % | Valid / total * 100 (gauge) |
| Rates | Verify Requests | By result (valid/invalid/error), stacked |
| Rates | Settle Requests | By result (success/failed/expired/replay/error), stacked |
| Latency | Verify Latency | p50 + p95 histogram quantiles |
| Latency | Settle Latency | p50 + p95 histogram quantiles |
| By Network | Verify by Network | Rate per CAIP-2 network ID |
| By Network | Settle by Network | Rate per CAIP-2 network ID |
| Errors | Settle Errors | Error/failed/expired/replay rates, stacked |
| Errors | Recent Errors | Loki log panel: `level="error"` |

## Alert Rules

See `alerts.yaml` for reference PromQL expressions. To create in Grafana:

1. Go to **Alerts & IRM** → **Alert rules** → **+ New alert rule**
2. Set the datasource to `grafanacloud-sbclogs-prom`
3. Paste the PromQL expression from `alerts.yaml`
4. Configure evaluation interval, `for` duration, and contact point

| Alert | Condition | Severity |
|-------|-----------|----------|
| Settle error rate high | Error+failed rate > 10% over 5min | Critical |
| Permit expired attempts | Any expired settle in 5min window | Warning |
| Health check down | No facilitator logs for 10min | Critical |

## Updating

After editing `dashboard.json`, re-import it (same process). Grafana will detect the matching UID and offer to overwrite.
