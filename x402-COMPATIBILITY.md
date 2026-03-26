# x402 v2 Compatibility

**Implementation:** SBC x402 Facilitator (`https://x402.stablecoin.xyz`)

**Spec:** [coinbase/x402 — x402-specification-v2.md](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)

**Last verified:** 2026-03-09

**Result:** 36/36 conformance checks passed ✓ | 187 unit tests ✓

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
| Advertises v1 + v2 kinds per network               | Backward compatibility (our extension)                       | ✓      |

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
| Rejects unsupported scheme                  | `invalidReason: "unsupported_scheme"`                     | ✓      |
| Rejects unsupported network                 | `invalidReason: "invalid_network"`                        | ✓      |
| Rejects missing authorization               | `invalidReason: "invalid_payload"`                        | ✓      |
| Rejects invalid signature                   | `invalidReason: "invalid_exact_evm_payload_signature"`    | ✓      |
| Rejects expired payment (validBefore)       | `invalidReason: "invalid_exact_evm_payload_authorization_valid_before"` | ✓ |
| Rejects not-yet-valid payment (validAfter)  | `invalidReason: "invalid_exact_evm_payload_authorization_valid_after"`  | ✓ |
| Rejects insufficient amount                 | `invalidReason: "invalid_exact_evm_payload_authorization_value_mismatch"` | ✓ |
| Rejects spender mismatch                    | `invalidReason: "invalid_exact_evm_payload_recipient_mismatch"` | ✓ |
| Rejects insufficient on-chain balance       | `invalidReason: "insufficient_funds"`                     | ✓      |
| Returns 4xx for missing `paymentPayload`    | Client error for malformed request                        | ✓      |
| Includes `remainingSeconds` on success      | Our extension: seconds until permit expires               | ✓      |

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
| Pre-settle deadline check                | Rejects expired permits before wasting gas                   | ✓      |
| 30s safety margin on deadline            | Rejects permits within 30s of expiry                         | ✓      |
| Solana: returns 200                      | Multi-chain support                                          | ✓      |
| Solana: response has `success` boolean   | Consistent response shape across chains                      | ✓      |
| Rejects unsupported network              | Returns `success: false` with `errorReason`                  | ✓      |
| Returns 4xx for missing `paymentPayload` | Client error for malformed request                           | ✓      |

---

## Spec Error Codes

All `invalidReason` / `errorReason` values follow the x402 v2 spec naming convention:

| Error Code | Meaning |
| --- | --- |
| `unsupported_scheme` | Scheme is not `"exact"` |
| `invalid_network` | CAIP-2 network not supported |
| `invalid_payload` | Missing or malformed payload/authorization |
| `invalid_exact_evm_payload_signature` | ERC-2612 / Ed25519 signature verification failed |
| `invalid_exact_evm_payload_authorization_valid_before` | Permit expired (`now > validBefore`) |
| `invalid_exact_evm_payload_authorization_valid_after` | Permit not yet valid (`now < validAfter`) |
| `invalid_exact_evm_payload_authorization_value_mismatch` | Amount less than required |
| `invalid_exact_evm_payload_recipient_mismatch` | Spender or recipient doesn't match |
| `insufficient_funds` | On-chain token balance too low |

---

## v1 Backward Compatibility

The facilitator accepts both v1 (flat) and v2 (envelope) payloads:

- **Detection:** v1 payloads lack the `accepted` envelope (`!payload.accepted`)
- **Normalization:** v1 fields are wrapped into v2 format internally (`maxAmountRequired` → `amount`)
- **Response:** Same response shape for both versions
- **/supported:** Advertises both `x402Version: 1` and `x402Version: 2` kinds per network

---

## Security Validation

187 unit tests cover:

- **Amount manipulation:** zero, negative, uint256 max, non-numeric values
- **Address injection:** zero address, malformed, wrong length, case sensitivity
- **Deadline attacks:** far-future, validAfter in future, deadline=0, boundary conditions
- **Spender mismatch:** wrong facilitator address, case-insensitive comparison
- **Cross-network attacks:** EVM payload with Solana network, Solana payload with EVM network
- **Type confusion:** null, array, string, undefined, boolean payloads
- **Nonce replay protection:** server-side dedup rejects double-settle before on-chain submission
- **Signature edge cases:** empty, non-hex, oversized, undefined signatures
- **Oversized payloads:** >1MB payload handling
- **Rate limiting:** per-IP throttling on payment endpoints
- **Input size limiting:** 100kb body limit with 413 response

---

## Supported Networks

| Network        | CAIP-2                                    | Mechanism                      | Status |
| -------------- | ----------------------------------------- | ------------------------------ | ------ |
| Base mainnet   | `eip155:8453`                             | ERC-2612 Permit + TransferFrom | ✓ Live |
| Base Sepolia   | `eip155:84532`                            | ERC-2612 Permit + TransferFrom | ✓ Live |
| Radius mainnet | `eip155:723487`                            | ERC-2612 Permit + TransferFrom | ✓ Live |
| Radius testnet | `eip155:72344`                            | ERC-2612 Permit + TransferFrom | ✓ Live |
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Delegated SPL transfer         | ✓ Live |

---

## Our Extensions (Not in x402 Spec)

These are additive/non-breaking fields we include beyond the spec:

| Extension | Endpoint | Description |
| --- | --- | --- |
| `remainingSeconds` | `/verify` | Seconds until permit expires — helps resource servers decide settle timing |
| `expiredAt` | `/settle` | Unix timestamp when permit expired (on rejection) |
| `suggestRetry` | `/settle` | Hints that client should re-sign with fresh permit |
| Pre-settle deadline check | `/settle` | Rejects permits expired or within 30s of expiry before submitting on-chain |
| Gas estimation dry-run | `/settle` | Calls `estimateContractGas` before submitting permit tx to catch reverts |
| Nonce replay protection | `/settle` | Server-side dedup prevents double-settle (saves gas) |
| Rate limiting | `/verify`, `/settle` | 60 req/min per IP with `429` + `Retry-After` header |
| Input size limit | All POST | 100kb body limit with `413 payload_too_large` response |
| HTML content negotiation | `/supported` | Returns HTML view when `Accept: text/html` header present |
| v1 backward compatibility | `/verify`, `/settle` | Accepts flat v1 payloads alongside v2 envelope format |

---

## Notes

- **Scheme:** Only `"exact"` scheme is currently defined in x402 v2. Deferred/subscribe schemes are not part of the spec yet.
- **EVM mechanism:** SBC token uses ERC-2612 Permit (not EIP-3009 `transferWithAuthorization`). The x402 v2 spec accommodates both via `extra.assetTransferMethod`.
- **Settlement status codes:** Per spec, `/settle` always returns HTTP 200; success/failure is communicated via `success` boolean in the body.
- **validAfter check:** Added 2026-03-09. Spec step 4 requires checking both `validAfter` and `validBefore` time bounds.
- **Spender validation:** Added 2026-03-09. Spec step 5 requires `authorization.to` matches facilitator's own address.
