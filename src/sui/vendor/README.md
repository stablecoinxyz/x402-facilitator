# Vendored: x402 Sui `exact` facilitator scheme

These files are copied **byte-identical** from an unmerged upstream pull request. They are
not modified here, so that re-diffing against upstream stays mechanical (see "Re-diff" below).

| | |
|---|---|
| Source repo | https://github.com/hayes-mysten/x402 |
| Commit | `5d9e9479ac0b308d12bad6254fbd41b666d9def2` |
| Upstream path | `typescript/packages/mechanisms/sui/src/` |
| PR | x402-foundation/x402#3082 (`@x402/sui`), implementing spec PR #3081 |
| License | Apache-2.0 — full text in `LICENSE` in this directory |
| Vendored on | 2026-10-29 |

## Why vendored

`@x402/sui` is not published to npm (`npm view @x402/sui` → 404, 2026-10-29), and the
reference implementation lives only on PR #3082's branch.

## Files

| Local | Upstream |
|---|---|
| `constants.ts` | `constants.ts` |
| `types.ts` | `types.ts` |
| `utils.ts` | `utils.ts` |
| `settlement-cache.ts` | `settlement-cache.ts` |
| `exact/facilitator/index.ts` | `exact/facilitator/index.ts` |
| `exact/facilitator/scheme.ts` | `exact/facilitator/scheme.ts` |

The client and server schemes upstream are **not** vendored — the facilitator only needs the
facilitator side.

## Re-diff

Before any mainnet rollout, re-fetch and diff each file against the current PR head:

```
gh api "repos/hayes-mysten/x402/contents/typescript/packages/mechanisms/sui/src/<path>?ref=<sha>" \
  --jq .content | base64 -d | diff - src/sui/vendor/<path>
```

Exit: replace this directory with the npm `@x402/sui` package once it is published and its
facilitator matches spec #3081.
