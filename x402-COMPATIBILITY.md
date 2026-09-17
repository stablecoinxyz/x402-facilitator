# x402 v2 Compatibility

**Implementation:** SBC x402 Facilitator (`https://x402.stablecoin.xyz`)

**Spec:** [x402 Foundation Exact EVM scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)

**Last verified:** 2026-09-17

**Result:** all conformance checks passed ✓ | unit suite green ✓

Run them yourself rather than trusting a number here — counts go stale the moment
a check or a test is added, and both have been:
`npm run conformance` (against a running server) and `npm test`.

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
| EVM kinds advertise `assetTransferMethod: "permit2"` | Exact EVM Permit2 scheme                                    | ✓      |
| EVM kinds are v2-only                               | Permit2 payload is a v2 Exact EVM method                     | ✓      |

---

## POST /verify

> "Verifies a payment authorization without executing the transaction on the blockchain."
> — [x402-specification-v2.md §/verify](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)

| Check                                       | Spec Requirement                                          | Result |
| ------------------------------------------- | --------------------------------------------------------- | ------ |
| Returns 200 for a settleable request        | 200 with `isValid`; an unsponsored payload lacking Permit2 allowance instead gets `412` | ✓ |
| Response has `isValid` boolean              | Required field in both success and error response         | ✓      |
| Response has `payer` field                  | Optional but present: payer wallet address                | ✓      |
| Invalid response has `invalidReason` string | `invalidReason` field when `isValid: false`               | ✓      |
| Solana: returns 200                         | Multi-chain support                                       | ✓      |
| Solana: response has `isValid` boolean      | Consistent response shape across chains                   | ✓      |
| Rejects unsupported scheme                  | `invalidReason: "unsupported_scheme"`                     | ✓      |
| Rejects unsupported network                 | `invalidReason: "invalid_network"`                        | ✓      |
| Rejects missing authorization               | `invalidReason: "invalid_payload"`                        | ✓      |
| Rejects invalid signature                   | `invalidReason: "invalid_exact_evm_payload_signature"`    | ✓      |
| Rejects expired payment (deadline)          | `invalidReason: "invalid_exact_evm_payload_authorization_valid_before"` | ✓ |
| Rejects not-yet-valid payment (validAfter)  | `invalidReason: "invalid_exact_evm_payload_authorization_valid_after"`  | ✓ |
| Rejects amount mismatch                      | `invalidReason: "invalid_exact_evm_payload_authorization_value_mismatch"` | ✓ |
| Rejects spender / recipient mismatch         | `invalidReason: "invalid_exact_evm_payload_recipient_mismatch"` | ✓ |
| Rejects insufficient on-chain balance       | `invalidReason: "insufficient_funds"`                     | ✓      |
| Returns 4xx for missing `paymentPayload`    | Client error for malformed request                        | ✓      |
| Includes `remainingSeconds` on success      | Our extension: seconds until the Permit2 deadline          | ✓      |

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
| Pre-settle deadline check                | Rejects authorizations past `deadline` before broadcast      | ✓      |
| Solana: returns 200                      | Multi-chain support                                          | ✓      |
| Solana: response has `success` boolean   | Consistent response shape across chains                      | ✓      |
| Rejects unsupported network              | Returns `success: false` with `errorReason`                  | ✓      |
| Returns 4xx for missing `paymentPayload` | Client error for malformed request                           | ✓      |

---

## Spec Error Codes

All `invalidReason` / `errorReason` values follow the x402 v2 spec naming convention, except `PERMIT2_ALLOWANCE_REQUIRED`, a distinct HTTP 412 signal on `/verify`:

| Error Code | Meaning |
| --- | --- |
| `unsupported_scheme` | Scheme is not `"exact"` |
| `invalid_network` | CAIP-2 network not supported |
| `invalid_payload` | Missing or malformed payload; `accepted` does not mirror `paymentRequirements`; or a malformed `eip2612GasSponsoring` sponsorship |
| `invalid_exact_evm_payload_signature` | Permit2 witness or optional ERC-2612 sponsorship signature verification failed |
| `invalid_exact_evm_payload_authorization_valid_before` | Authorization expired (`now > deadline`) |
| `invalid_exact_evm_payload_authorization_valid_after` | Authorization not yet valid (`now < witness.validAfter`) |
| `invalid_exact_evm_payload_authorization_value_mismatch` | `permitted.amount` is not exactly the requested amount |
| `invalid_exact_evm_payload_recipient_mismatch` | `spender` is not the canonical x402 proxy, or `witness.to` / `permitted.token` does not match the requested `payTo` / `asset` |
| `unsupported_asset_transfer_method` | `extra.assetTransferMethod` is not `"permit2"` (legacy ERC-2612 EVM authorizations are rejected) |
| `unsupported_asset` | Asset is not a configured token, or the address is not a contract on chain |
| `invalid_self_payment` | Payer (`from`) and recipient (`witness.to`) are the same address |
| `insufficient_funds` | On-chain token balance too low |
| `PERMIT2_ALLOWANCE_REQUIRED` | `/verify` only, returned with HTTP **412**: the payer must approve Permit2 on-chain (or include an `eip2612GasSponsoring` extension) before settlement |
| `settlement_pending` | Settlement broadcast, confirmation unreadable. **Non-terminal** — the caller reconciles on chain rather than re-signing. Always carries the broadcast hash in `transaction`, as the spec requires |
| `invalid_transaction_state` | Transaction mined and reverted. Carries the hash |

---

## v1 Backward Compatibility

The facilitator retains v1 normalization for Solana. EVM Exact payments are v2
Permit2 only; legacy ERC-2612 EVM authorizations are rejected because their
allowance signature does not bind the merchant recipient.

- **Detection:** v1 payloads lack the `accepted` envelope (`!payload.accepted`)
- **Normalization:** v1 fields are wrapped into v2 format internally (`maxAmountRequired` → `amount`)
- **Response:** Same response shape for both versions
- **/supported:** Advertises Permit2 EVM kinds only as `x402Version: 2`.

---

## Security Validation

The automated test suite covers:

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
| Base mainnet   | `eip155:8453`                             | Permit2 + canonical x402 proxy | ✓ Live |
| Base Sepolia   | `eip155:84532`                            | Permit2 + canonical x402 proxy | ✓ Live |
| Radius mainnet | `eip155:723487`                            | Permit2 + canonical x402 proxy | ✓ Live |
| Radius testnet | `eip155:72344`                            | Permit2 + canonical x402 proxy | ✓ Live |
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Delegated SPL transfer         | ✓ Live |

---

## Our Extensions (Not in x402 Spec)

These are additive/non-breaking fields we include beyond the spec:

| Extension | Endpoint | Description |
| --- | --- | --- |
| `remainingSeconds` | `/verify` | Seconds until the Permit2 `deadline` — helps resource servers decide settle timing |
| Pre-settle deadline check | `/settle` | Rejects authorizations past `deadline` before broadcast |
| Proxy simulation | `/settle` | Simulates the canonical Permit2 proxy call immediately before broadcast (skipped on Radius) |
| Nonce replay protection | `/settle` | Server-side dedup on Solana and simulated EVM; live EVM Permit2 relies on the on-chain Permit2 nonce |
| Rate limiting | `/verify`, `/settle` | 60 req/min per IP with `429` + `Retry-After` header |
| Input size limit | All POST | 100kb body limit with `413 payload_too_large` response |
| HTML content negotiation | `/supported` | Returns HTML view when `Accept: text/html` header present |
| EIP-2612 gas sponsorship | EVM | Standard `eip2612GasSponsoring` extension supplies a Permit2 allowance atomically; advertised in `/supported` `extensions` for EVM configurations |

---

## Notes

- **Scheme:** Only `"exact"` scheme is currently defined in x402 v2. Deferred/subscribe schemes are not part of the spec yet.
- **EVM mechanism:** Exact EVM uses Permit2 and the canonical x402 proxy. SBC's ERC-2612 permit is used only by the standard optional gas-sponsorship extension, so the payment witness binds recipient and amount.
- **Settlement status codes:** Per spec, `/settle` always returns HTTP 200; success/failure is communicated via `success` boolean in the body.
- **Time bounds:** The Permit2 path rejects an authorization when `now < witness.validAfter` or `now > deadline`, before any on-chain work.
- **Spender validation:** The signed Permit2 `spender` must be the canonical x402 proxy (`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`), not the facilitator. The proxy, not the facilitator, moves the funds, and it enforces `witness.to`, so the facilitator cannot alter the recipient or amount after the payer signs.
