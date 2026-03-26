# Radius Chain Compatibility

**Last tested:** 2026-03-09 on Radius mainnet (eip155:723487)

## Summary

Radius is an EVM-compatible chain with a custom fee system using RUSD as the native gas token. The facilitator uses **legacy (type 0) transactions** with explicit `gasPrice` for all Radius settlements.

## Fee System

- **Native gas token:** RUSD (not ETH)
- **Turnstile:** Auto-converts SBC → RUSD when account lacks RUSD for gas (0.1 RUSD increments, 1:1 target value, inline during tx submission)
- **Gas cost:** ~0.0001 USD per SBC transfer

## Transaction Types

Both legacy and EIP-1559 transactions work on Radius. However, viem's default fee estimation breaks because it sets `maxPriorityFeePerGas: 0` and `maxFeePerGas: 0`, which Radius rejects as "gas price too low."

### On-chain proof (2026-03-09)

| Tx Type | Fee Params | Tx Hash | Result |
|---------|-----------|---------|--------|
| EIP-1559 (viem defaults) | maxFee=0, priority=0 | — | ❌ "gas price too low" |
| Legacy (explicit gasPrice) | gasPrice=1.986 gwei | `0xcab550...` | ✅ Block 1773055178169 |
| EIP-1559 (explicit fees) | maxFee=1.972, priority=0.986 gwei | `0x8684e7...` | ✅ Block 1773055179458 |

### Why we use legacy

Legacy transactions need one fee param (`gasPrice`), EIP-1559 needs two (`maxFeePerGas` + `maxPriorityFeePerGas`). Both work, but legacy is simpler and proven. The `gasPrice` is fetched from `eth_gasPrice` + 1 gwei buffer.

## eth_estimateGas is Broken

`eth_estimateGas` always fails on Radius with "Exec Failed" regardless of transaction type or fee parameters. This is a Turnstile simulation issue — the RPC's gas estimation logic doesn't correctly account for Turnstile's SBC→RUSD auto-conversion.

**Impact:** Gas estimation dry-runs (which protect against wasted gas on Base) are **skipped for Radius**. The facilitator proceeds directly to `writeContract` without pre-flight estimation.

**Tested combinations:**

| Method | gasPrice | Result |
|--------|----------|--------|
| `eth_estimateGas` (no fee params) | — | ❌ "Exec Failed" |
| `eth_estimateGas` (legacy gasPrice) | 1.986 gwei | ❌ "Exec Failed" |
| `eth_call` (read-only) | — | ✅ Works |
| `writeContract` (legacy gasPrice) | 1.986 gwei | ✅ Works |

## RPC Endpoints

| Method | Status | Notes |
|--------|--------|-------|
| `eth_chainId` | ✅ | Returns 0xb09df (723487) |
| `eth_gasPrice` | ✅ | ~0.986 gwei |
| `eth_getBalance` | ✅ | Returns RUSD balance |
| `eth_call` | ✅ | Contract reads work |
| `eth_feeHistory` | ✅ | baseFee ~0.875 gwei |
| `eth_maxPriorityFeePerGas` | ✅ | Returns 0 |
| `eth_estimateGas` | ❌ | Always "Exec Failed" |
| `eth_sendRawTransaction` (type 0) | ✅ | With explicit gasPrice |
| `eth_sendRawTransaction` (type 2) | ✅ | With explicit non-zero fees |

## Facilitator Code Path

```
settle request for eip155:723487 (or legacy eip155:723) or eip155:72344
  → isRadius = true
  → gasPrice = eth_gasPrice() + 1 gwei
  → skip gas estimation (eth_estimateGas broken)
  → writeContract permit() with gasPrice override (type 0 legacy)
  → writeContract transferFrom() with gasPrice override (type 0 legacy)
```

## Test Script

Run `npx ts-node demo/test-radius-eip1559.ts` to verify Radius compatibility. Requires `RADIUS_FACILITATOR_PRIVATE_KEY` in `.env`.

## References

- Radius fee docs: https://docs.radiustech.xyz/developer-resources/fees
- Turnstile: https://docs.radiustech.xyz/developer-resources/fees#turnstile
