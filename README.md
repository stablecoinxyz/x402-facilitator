# x402-facilitator

SBC x402 Facilitator — verifies and settles payments using the [x402 protocol](https://github.com/coinbase/x402) (v2).

## Supported Networks

| Network | Env Prefix | Mechanism |
|---------|-----------|-----------|
| Base | `BASE_` | ERC-2612 Permit + TransferFrom |
| Base Sepolia | `BASE_SEPOLIA_` | ERC-2612 Permit + TransferFrom |
| Radius | `RADIUS_` | ERC-2612 Permit + TransferFrom |
| Radius Testnet | `RADIUS_TESTNET_` | ERC-2612 Permit + TransferFrom |
| Solana | `SOLANA_` | Delegated SPL token transfer |

Each network has its own env vars — mainnets and testnets can be configured simultaneously.

## Setup

```bash
npm install
cp .env.example .env  # configure facilitator keys per network
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/supported` | Capability discovery (lists configured networks) |
| `POST` | `/verify` | Verify a payment header |
| `POST` | `/settle` | Execute on-chain settlement |
| `GET` | `/health` | Health check |

## Configuration

All config via `.env` — see `.env.example`. Each network is independent: only networks with a `FACILITATOR_PRIVATE_KEY` and `FACILITATOR_ADDRESS` set will appear in `/supported`.

## Demo

Interactive demo using SBC tokens. Generates wallets, checks balances, approves the facilitator, then sends a verify + settle request.

```bash
npm run setup -- --network <name>   # generate wallets, approve, write .env
npm run dev                          # start server (Terminal 1)
npm run demo -- --network <name>    # run demo client (Terminal 2)
```

**Networks:** `base` (default), `base-sepolia`, `radius`, `radius-testnet`

The demo client signs an ERC-2612 Permit off-chain, then the facilitator calls `permit()` + `transferFrom()` on-chain to move SBC from Client to Merchant.

## Development

```bash
npm run dev           # watch mode
npm test              # run tests
npm run build         # compile
npm start             # production
fly deploy            # deploy to Fly.io
```
