# x402-facilitator

SBC x402 Facilitator — verifies and settles payments using the [x402 protocol](https://github.com/coinbase/x402) (v2).

Uses ERC-2612 Permit for EVM chains (SBC token doesn't support EIP-3009) and delegated SPL transfers for Solana. The facilitator never holds customer funds.

## Supported Networks

| Network | CAIP-2 ID | Env Prefix | Mechanism |
|---------|-----------|-----------|-----------|
| Base | `eip155:8453` | `BASE_` | ERC-2612 Permit + TransferFrom |
| Base Sepolia | `eip155:84532` | `BASE_SEPOLIA_` | ERC-2612 Permit + TransferFrom |
| Radius | `eip155:723` | `RADIUS_` | ERC-2612 Permit + TransferFrom |
| Radius Testnet | `eip155:72344` | `RADIUS_TESTNET_` | ERC-2612 Permit + TransferFrom |
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `SOLANA_` | Delegated SPL token transfer |

Each network has its own env vars — mainnets and testnets can be configured simultaneously.

## Setup

```bash
npm install
cp .env.example .env  # configure facilitator keys per network
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/supported` | Capability discovery — returns `kinds`, `extensions`, `signers` |
| `POST` | `/verify` | Verify a `paymentPayload` (v2 JSON object) |
| `POST` | `/settle` | Execute on-chain settlement |
| `GET` | `/health` | Health check |

### v2 Request Format

`/verify` and `/settle` accept:

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": "https://...",
    "accepted": { "scheme": "exact", "network": "eip155:8453" },
    "payload": {
      "signature": "0x...",
      "authorization": {
        "from": "0x...",
        "to": "0x...",
        "value": "10000",
        "validAfter": "0",
        "validBefore": "1700000000",
        "nonce": "0"
      }
    },
    "extensions": {}
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "10000",
    "asset": "0x...",
    "payTo": "0x...",
    "maxTimeoutSeconds": 60,
    "extra": { "assetTransferMethod": "erc2612", "name": "Stable Coin", "version": "1" }
  }
}
```

## Configuration

All config via `.env` — see `.env.example`. Each network is independent: only networks with a `FACILITATOR_PRIVATE_KEY` and `FACILITATOR_ADDRESS` set will appear in `/supported`.

The server auto-selects the next available port if `FACILITATOR_PORT` (default 3001) is in use.

## Demo

Interactive demo using SBC tokens. Generates wallets, checks balances, approves the facilitator, then sends a v2 verify + settle request.

```bash
npm run setup -- --network <name>   # generate wallets, approve, write .env
npm run dev                          # start server (Terminal 1)
npm run demo -- --network <name>    # run demo client (Terminal 2)
```

**Networks:** `base` (default), `base-sepolia`, `radius`, `radius-testnet`

If the server landed on a different port (e.g. 3002), pass it to the demo:

```bash
FACILITATOR_PORT=3002 npm run demo -- --network radius-testnet
```

To run against a deployed facilitator instead of a local server:

```bash
FACILITATOR_URL=https://x402.stablecoin.xyz npm run demo -- --network radius-testnet
```

The demo client signs an ERC-2612 Permit off-chain (no gas), then the facilitator calls `permit()` + `transferFrom()` on-chain to move SBC from Client → Merchant. The client wallet needs SBC; the facilitator only needs ETH for gas.

## Development

```bash
npm run dev           # watch mode (auto-restart)
npm test              # run tests (67 tests)
npm run build         # compile TypeScript
npm start             # production
fly deploy            # deploy to Fly.io
```
