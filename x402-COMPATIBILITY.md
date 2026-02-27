# x402 v2 Compatibility

**Implementation:** SBC x402 Facilitator (`https://x402.stablecoin.xyz`)

**Spec:** [coinbase/x402 — x402-specification-v2.md](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)

**Last verified:** 2026-02-27

**Result:** 36/36 checks passed ✓

Run against any endpoint:

```bash
FACILITATOR_URL=https://x402.stablecoin.xyz npm run conformance
```

---

## GET /supported

> "Returns the list of payment schemes, networks, and extensions supported by the facilitator."
> — [x402-specification-v2.md §Facilitator API](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)

| Check                                              | Spec Requirement                                             | Result |
| -------------------------------------------------- | ------------------------------------------------------------ | ------ |
| Returns 200 OK                                     | Standard HTTP semantics                                      | ✓      |
| `kinds[]` present                                  | Required top-level field                                     | ✓      |
| `extensions[]` present                             | Required top-level field                                     | ✓      |
| `signers{}` present                                | Required top-level field                                     | ✓      |
| Each kind has `x402Version: 2`                     | `SupportedKind.x402Version` (number, value: 2)               | ✓      |
| Each kind has `scheme: "exact"`                    | `SupportedKind.scheme` — only `"exact"` currently defined    | ✓      |
| Network IDs are CAIP-2                             | `SupportedKind.network` — CAIP-2 format e.g. `"eip155:8453"` | ✓      |
| Each kind has `extra.assetTransferMethod`          | `SupportedKind.extra` — scheme-specific config               | ✓      |
| Signer keys are CAIP-2 patterns                    | `signers` keyed by e.g. `"eip155:*"`, `"solana:*"`           | ✓      |
| Includes `eip155:8453` (Base mainnet)              | Network coverage                                             | ✓      |
| Includes `eip155:84532` (Base Sepolia)             | Network coverage                                             | ✓      |
| Includes `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Network coverage                                             | ✓      |

---

## POST /verify

> "Verifies a payment authorization without executing the transaction on the blockchain."
> — [x402-specification-v2.md §/verify](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)

| Check                                       | Spec Requirement                                          | Result |
| ------------------------------------------- | --------------------------------------------------------- | ------ |
| Returns 200 for valid request body          | Always 200 (errors in body, not status)                   | ✓      |
| Response has `isValid` boolean              | Required field in both success and error response         | ✓      |
| Response has `payer` field                  | Optional but present: payer wallet address                | ✓      |
| Invalid response has `invalidReason` string | `invalidReason` field when `isValid: false`               | ✓      |
| Solana: returns 200                         | Multi-chain support                                       | ✓      |
| Solana: response has `isValid` boolean      | Consistent response shape across chains                   | ✓      |
| Rejects unsupported scheme                  | Validation step: scheme must be `"exact"`                 | ✓      |
| Rejects unsupported network                 | Validation step: network must be a supported CAIP-2 ID    | ✓      |
| Rejects expired payment                     | Validation step: time window verification (`validBefore`) | ✓      |
| Returns 4xx for missing `paymentPayload`    | Client error for malformed request                        | ✓      |

---

## POST /settle

> "Executes a verified payment by broadcasting the transaction to blockchain."
> — [x402-specification-v2.md §/settle](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)

| Check                                    | Spec Requirement                                             | Result |
| ---------------------------------------- | ------------------------------------------------------------ | ------ |
| Returns 200 for valid request body       | Always 200 (errors in body, not status)                      | ✓      |
| Response has `success` boolean           | Required field in both success and error response            | ✓      |
| Response has `payer` field               | Required: payer wallet address                               | ✓      |
| Uses `transaction` field (not `txHash`)  | Spec field name: `transaction` (string, tx hash)             | ✓      |
| Uses `errorReason` field (not `error`)   | Spec field name: `errorReason` (string, failure description) | ✓      |
| Failed response has `errorReason`        | Required when `success: false`                               | ✓      |
| Solana: returns 200                      | Multi-chain support                                          | ✓      |
| Solana: response has `success` boolean   | Consistent response shape across chains                      | ✓      |
| Rejects unsupported network              | Returns `success: false` with `errorReason`                  | ✓      |
| Returns 4xx for missing `paymentPayload` | Client error for malformed request                           | ✓      |

---

## Supported Networks

| Network        | CAIP-2                                    | Mechanism                      | Status |
| -------------- | ----------------------------------------- | ------------------------------ | ------ |
| Base mainnet   | `eip155:8453`                             | ERC-2612 Permit + TransferFrom | ✓ Live |
| Base Sepolia   | `eip155:84532`                            | ERC-2612 Permit + TransferFrom | ✓ Live |
| Radius mainnet | `eip155:723`                              | ERC-2612 Permit + TransferFrom | ✓ Live |
| Radius testnet | `eip155:72344`                            | ERC-2612 Permit + TransferFrom | ✓ Live |
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Delegated SPL transfer         | ✓ Live |

---

## Notes

- **Scheme:** Only `"exact"` scheme is currently defined in x402 v2. Deferred/subscribe schemes are not part of the spec yet.
- **EVM mechanism:** SBC token uses ERC-2612 Permit (not EIP-3009 `transferWithAuthorization`). The x402 v2 spec accommodates both via `extra.assetTransferMethod`.
- **Settlement status codes:** Per spec, `/settle` always returns HTTP 200; success/failure is communicated via `success` boolean in the body.
