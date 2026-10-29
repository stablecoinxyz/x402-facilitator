/**
 * Parse a client-supplied payment amount for the zero-value guard.
 *
 * BigInt() throws on non-numeric input ("abc", "1.5", objects). Thrown inside a
 * route, that lands in the catch-all and is metered as `unknown` — a facilitator
 * fault — for what is a malformed request. Unparseable input returns 0n so the
 * guard rejects it as `invalid_amount`. Anything BigInt() already accepted parses
 * exactly as before.
 */
export function parseAmount(value: unknown): bigint {
  try {
    return BigInt(value as any);
  } catch {
    return 0n;
  }
}
