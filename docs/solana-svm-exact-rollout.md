# Solana SVM Exact rollout

The facilitator supports the standard x402 SVM `exact` method only when an
operator enables it deliberately. It does not use the retired delegated-SPL
authorization flow for new SVM Exact requests.

## Security model

The payer creates and partially signs the full Solana transaction. It includes
the exact mint, recipient, amount, and a configured `feePayer`. The facilitator
uses the official `@x402/svm` verifier, which checks the payment outcome and
sponsor policy, then adds only the fee-payer signature. It cannot replace the
recipient or transfer amount after the payer signs.

The official scheme maintains a short in-flight settlement cache so retries of
the same signed transaction reconcile with the same broadcast rather than send
it twice. This is not the legacy local authorization ledger: the signed Solana
transaction itself is the on-chain authorization.

## Explicit rollout gate

All of these are required before SVM Exact appears in `/supported` or either
SVM route accepts a transaction payload:

1. `SOLANA_SVM_EXACT_ENABLED=true`
2. `SOLANA_SVM_NETWORK` explicitly set to `solana-devnet`, `solana-testnet`, or
   `solana` (mainnet)
3. a matching facilitator key and address
4. the normal settlement mode gate (`ENABLE_REAL_SETTLEMENT=true` for a real
   transaction)

Configured Solana keys alone do nothing. An enabled devnet configuration cannot
verify or settle a mainnet SVM transaction.

## Promotion sequence

1. Use a separate low-value devnet facilitator key and `SOLANA_RPC_URL`.
2. Set `SOLANA_SVM_NETWORK=solana-devnet` and enable the SVM gate in that
   environment only.
3. Execute a funded end-to-end payment: client partial-signs, `/verify`
   validates, `/settle` fee-payer co-signs, and the resulting signature confirms
   on devnet.
4. Record the transaction signature and review the sponsor spend limits.
5. Make mainnet an explicit, reviewed configuration change; it is never the
   default consequence of adding a key.

The legacy delegated-SPL endpoint remains fail-closed for real settlement and
is not advertised.
