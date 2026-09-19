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

`npm run prove:svm-devnet` automates this proof with a local, gitignored
throwaway devnet sponsor and a temporary, low-value SPL mint. It is deliberately isolated from `.env` and
production: it sets `SOLANA_SVM_NETWORK=solana-devnet` and its own devnet RPC
and feature gate in its process only. Generate the local sponsor once with
`solana-keygen new --no-bip39-passphrase --outfile .devnet-svm-sponsor.json`;
the script prints the public transaction signature but never prints the private
key.

## Devnet proof record

On 2026-09-19, the complete real-settlement flow succeeded on Solana devnet
using the isolated sponsor and a temporary SPL mint:

- Network: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`
- Transaction: [`2jhJy8yKniwTQj1AxATFyhGnENvm1btpV4P3sBCBHLxQMFGh4kW71mQLCo4GeA2g48TunbJTKTh2qZ2ejJnc8Rur`](https://explorer.solana.com/tx/2jhJy8yKniwTQj1AxATFyhGnENvm1btpV4P3sBCBHLxQMFGh4kW71mQLCo4GeA2g48TunbJTKTh2qZ2ejJnc8Rur?cluster=devnet)
- Mint: `FFAiDep7XTL5Gn2v3fQKaZ8PrYXuBfRWvrkJC5xjFwY9`
- Amount: `1000` base units (0.001 of the temporary six-decimal token)

The payer partial-signed the transaction with the official x402 SVM client;
this facilitator verified it, supplied the fee-payer signature, and the
merchant token account balance was checked after confirmation. The signature
was also independently confirmed at `finalized` commitment through Solana CLI.
