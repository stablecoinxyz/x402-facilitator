# Facilitator Operational Extensions

**Status:** Proposal
**Author:** SBC Foundation
**Version:** 1.0.0

## Overview

This document specifies optional operational extensions for x402 facilitators that improve reliability, reduce wasted gas, and help resource servers make better timing decisions.

These extensions are backward-compatible — they add optional response fields and pre-submission checks without changing request formats or existing validation logic.

## 1. Deadline-Aware Verify Response

### Motivation

After a successful `/verify`, the resource server must decide when to call `/settle`. Without knowing how much time remains on the authorization, it cannot make an informed decision.

### Specification

When `/verify` returns `isValid: true`, the facilitator MAY include a `remainingSeconds` field:

```json
{
  "isValid": true,
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "remainingSeconds": 287
}
```

**Field definition:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `remainingSeconds` | `number` | No | Seconds until the authorization expires (`validBefore - now` for EVM, `deadline - now` for Solana) |

**Client behavior:** Resource servers SHOULD use this value to choose a settlement strategy:
- If `remainingSeconds` exceeds the expected job duration plus a safety margin, settle after completion
- Otherwise, settle immediately before starting the job

## 2. Pre-Settle Deadline Check

### Motivation

Between `/verify` and `/settle`, time passes. If the authorization expires in that window, the on-chain transaction will revert and the facilitator loses gas fees.

### Specification

Before broadcasting a settlement transaction, the facilitator SHOULD check:

1. If `now > validBefore`: reject with `errorReason: "permit_expired"`
2. If `validBefore - now < SAFETY_MARGIN` (recommended: 30 seconds): reject with `errorReason: "permit_expired"`

The safety margin accounts for transaction propagation and block confirmation time.

**Extended error response fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `expiredAt` | `number` | No | Unix timestamp when the authorization expired |
| `remainingSeconds` | `number` | No | Seconds remaining when rejected within safety margin |
| `suggestRetry` | `boolean` | No | `true` if the client should re-sign with a fresh authorization |

**Example response:**

```json
{
  "success": false,
  "errorReason": "permit_expired",
  "payer": "0x857b06...",
  "transaction": "",
  "network": "eip155:8453",
  "expiredAt": 1741500000,
  "suggestRetry": true
}
```

## 3. Gas Estimation Before Settlement

### Motivation

The x402 v2 spec step 6 mentions simulating the transaction. Formalizing this as a pre-settle check prevents wasted gas on transactions guaranteed to revert.

### Specification

Before calling `writeContract` (EVM) or `sendTransaction` (Solana), the facilitator SHOULD call `estimateContractGas` (or equivalent) with the same parameters.

If estimation reverts, the facilitator SHOULD return:

```json
{
  "success": false,
  "errorReason": "gas_estimation_failed: <revert reason>",
  "payer": "0x...",
  "transaction": "",
  "network": "eip155:8453"
}
```

**Common revert reasons caught by gas estimation:**
- Permit nonce already consumed (replay)
- Invalid signature (passes off-chain check but fails on-chain)
- Insufficient token balance (changed between verify and settle)
- Contract paused or frozen

**Error code:** `gas_estimation_failed` (not in current spec — proposed addition)

## 4. Server-Side Nonce Replay Protection

### Motivation

On-chain, ERC-2612/EIP-3009 nonce protection prevents double-spend. But without server-side dedup, the facilitator submits a transaction, pays gas, and discovers the nonce is consumed only after the revert.

### Specification

The facilitator SHOULD maintain an in-memory set of recently-settled nonces, keyed by `(network, lowercase(owner), nonce)`.

Before settlement:
1. Check if the key exists in the set
2. If yes, reject with `errorReason: "nonce_already_settled"`
3. If no, proceed with settlement
4. After successful settlement, add the key to the set

**Bounded storage:** The set SHOULD use LRU eviction with a reasonable maximum (e.g., 10,000 entries) to prevent unbounded memory growth.

**Error code:** `nonce_already_settled` (not in current spec — proposed addition)

**Example response:**

```json
{
  "success": false,
  "errorReason": "nonce_already_settled",
  "payer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "transaction": "",
  "network": "eip155:8453"
}
```

## Proposed Error Codes

| Code | Context | Description |
| --- | --- | --- |
| `permit_expired` | `/settle` | Authorization expired or within safety margin of expiry |
| `gas_estimation_failed` | `/settle` | On-chain gas estimation reverted before tx submission |
| `nonce_already_settled` | `/settle` | Server-side dedup detected a previously-settled nonce |

## Backward Compatibility

- All new response fields are optional
- Existing clients that do not check these fields are unaffected
- No changes to request formats
- New error codes follow existing `snake_case` convention
- Facilitators that do not implement these extensions remain spec-compliant

## Reference Implementation

- **SBC x402 Facilitator** — https://x402.stablecoin.xyz
- 187 unit tests including security exploit coverage
- 36/36 v2 conformance checks
- 5 networks: Base, Base Sepolia, Radius, Radius Testnet, Solana
