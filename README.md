# x402-facilitator

SBC x402 Facilitator - Verify and Settle Payments.

This implementation supports **v1** of the x402 protocol.

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file based on your configuration requirements (check source code for needed variables).

## Usage

### Quick Demo

We have provided a self-contained demo client that simulates a payment flow.

1.  **Start the server** in one terminal:
    ```bash
    npm run dev
    ```

2.  **Run the demo client** in another terminal:
    ```bash
    npm run demo
    ```

    The demo client generates a fresh random wallet, signs a valid payment payload, and sends it to the facilitator.
    *Note: The verification will likely fail with "Insufficient SBC balance" because the random wallet is empty. This proves the facilitator correctly checked the signature (passed) and the balance (failed).*

### Development

Run the server in development mode (with watch):
```bash
npm run dev
```

### Production

Build the project:
```bash
npm run build
```

Start the production server:
```bash
npm start
```

### Testing

Run tests:
```bash
npm test
```
