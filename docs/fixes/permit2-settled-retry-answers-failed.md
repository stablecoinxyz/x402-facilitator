# FIX — A retried /settle for a Permit2 payment we already broadcast answers "failed" with no transaction hash

**Status:** OPEN — design decided 2026-10-29 (upstream x402 reference behavior, hardened where upstream is unsafe; §4 Option A). One owner sign-off open (§9.1). Not implemented.
**Type:** correctness (payment outcome reported to the resource server)
**Impact class:** capital-safety — a resource server told "failed" for a payment that landed may ask the payer to sign and pay again; a wrongly matched retry told "success" makes a merchant deliver for a payment that never happened
**Priority:** high — upstream's stock resource-server middleware retries `/settle` once after a `settlement_pending` answer; against this facilitator that retry is answered wrongly
**Owner:** unassigned
**Created:** 2026-10-29 · **Last touched:** 2026-10-29

> **Update log (APPEND ONLY — never rewrite an earlier entry).**
> **2026-10-29 (v1):** Brief written from the 2026-10-28 11:30–11:37 UTC Base Sepolia events. Proposed recovering any already-settled payment from chain (token `Transfer` log search + calldata decode); feasibility shown by hand with `cast`. An earlier triage of these events called them "client replays, not our fault" — that was wrong; on-chain evidence in §1.
> **2026-10-29 (v2):** Revised after an adversarial review. Corrected the third payment's recipient (`0x248E5E958B66E5b471003BFBafD008ad4F4d8f45`) and Base Sepolia block time (~0.2 s; 2 s is mainnet). Found that v1's match omitted signed fields (`deadline`, `validAfter`) — a false-success hole. Raised the owner decision: answer a matched retry with success (a replayed public payload can then buy a second delivery) or with a failure carrying the hash.
> **2026-10-29 (v3):** Researched upstream (`x402-foundation/x402` `main` @ `e4a08681`, 2026-10-29). The spec text is silent; issues #277 and #452 asking for "already settled" are open; the reference code answers success only for a retry that follows a `settlement_pending` answer, and fails a retry that follows a confirmed success. **Owner decision (Eric, 2026-10-29 ~06:22 UTC): match the upstream reference behavior.** The design is now §4 Option A (a pending-settlement record keyed by the payload signature, as upstream does). v1/v2's chain-lookup design is kept as Option C, not chosen, because it answers success more broadly than upstream does.
> **2026-10-29 (v3, addendum ~06:38 UTC):** Added the history in §4: this reverses a deliberate 2026-09-07 decision (issue #6 / PR #7) not to keep a pending record, and changes a test that pins that behavior.
> **2026-10-29 (v4):** Revised after a second adversarial review (re-verified before editing). **v3 had a false-success hole: keying the record on the signature alone lets anyone copy the signature from our public pending transaction, build a different message whose `from` is whatever address that signature recovers to, pass the off-chain signature check, and hit the record** — demonstrated with the repo's viem 2.43.5 (`verifyTypedData(otherMessage, recoveredFrom, sameSignature) = true`). Upstream has the same hole (it reads the store before verifying anything). v4 binds a hit to the exact message and to our own transaction's calldata (§4 steps 1, 3). Also: the store is read BEFORE the deadline check (v3's order broke the fix for permits that expire during the wait); store-before-bitmap is now a stated MUST; the reconcile wait has its own short timeout; replacement receipts are rejected; upstream's actual answers are stated where v3 overclaimed parity; trigger (1) is narrowed (the stock client gives up at 90 s, our receipt wait is 180 s); metric labels named; residuals added. Corrections: the merchant success branch is `x402HTTPResourceServer.ts:871`, not `:847-858`; of the three 2026-10-28 transactions the first called `settleWithPermit` (`0xfa340378`), the other two `settle` (`0x13cd3b53`) — re-checked with `cast tx … input`.

---

## 0. Pick-up in 60 seconds

This repo is an x402 payment facilitator: a resource server (merchant) sends it a payer's signed Permit2 authorization, and `/settle` submits it on chain through the x402 Permit2 proxy. When a settle broadcasts but the receipt cannot be read, this facilitator answers `settlement_pending` with the hash — and keeps no record. Upstream's resource-server middleware then retries `/settle` once with the identical payload; this facilitator re-verifies it from scratch and answers wrongly (a failure with no hash if the transaction has mined, or a second broadcast that reverts if it has not). The fix ports upstream's pending-settlement record, with two hardenings upstream lacks: a hit must match the exact signed message, and must be proven against our own transaction's calldata before it can answer success. A used-nonce payload with no record gets a correctly classified client failure (`permit2_invalid_nonce`) instead of today's `tx_reverted`, which pages the "Settle faults on our side" alert. First move: read §4 in full — the step ORDER is the fix.

```bash
cd /Users/e/code/sbc/x402-facilitator
git log --oneline -5 && git status --short
grep -n "settlementPending = true\|error?.settlementPending\|permit2Mode === 'simulated'\|const txHash = await settlementQueue.enqueue" src/routes/settle.ts
cd ~/code/goodmeta/x402-sweep && git fetch -q origin && git log -1 --format='%h %ad' --date=short origin/main
```

**Definition of done:** against the real Base Sepolia facilitator: (1) a Permit2 settle forced into `settlement_pending` by a fast receipt-RPC error, then retried with the identical payload after mining, returns `success: true` with the original hash and no second broadcast; (2) a forged retry — the same signature on a different message — returns a failure and never the original hash; (3) a retry of an already-confirmed payment with no record returns `success: false`, `errorReason: "permit2_invalid_nonce"`, metered as a client failure.

---

## 1. Problem

Two triggers, one defect: this facilitator answers a retry of its own broadcast payment as if it were new.

| Trigger | Evidence | Today's answer |
|---|---|---|
| **(1) Upstream middleware's automatic retry after our `settlement_pending`** | Code path, not observed in logs. We answer pending at `src/routes/settle.ts:1012-1023` (Permit2 sets the flags at `:508`). Upstream `x402ResourceServer.settlePayment` retries immediately, exactly once, only when the facilitator RESPONDS with `settlement_pending` + a hash (`typescript/packages/core/src/server/x402ResourceServer.ts:1652-1673`). The stock HTTP client aborts at `DEFAULT_TIMEOUT_MS = 90_000` (`core/src/http/httpFacilitatorClient.ts:17`), and a timeout is not retried. Our receipt wait uses viem's default 180 s, so a pending answer caused by a slow receipt never reaches a stock client; **trigger (1) fires only when the receipt wait fails fast** (an RPC error). | Retry before mining: simulation passes, a second transaction is broadcast and reverts on chain → `invalid_transaction_state` + the second hash (gas lost; payment landed). Retry after mining: `InvalidNonce()` in simulation → `{"success":false,"transaction":"","errorReason":"tx_reverted: …"}`. |
| **(2) Any retry after a confirmed success** | N=3, Base Sepolia (`eip155:84532`), 2026-10-28, error logs at 11:30:47, 11:32:15, 11:36:52 UTC (Grafana Loki, `{app="sbc-x402-facilitator"}`): `Settlement error: tx_reverted` with `… reverted with the following signature: 0x756688fe`. Paged "Settle faults on our side" at 11:37 UTC. | `tx_reverted`, empty `transaction`, counted as our fault |

`0x756688fe` is Permit2's `InvalidNonce()` (`cast sig "InvalidNonce()"`).

**On-chain evidence for trigger (2)** (checked 2026-10-29 with `cast` against `https://sepolia.base.org`): payer `0xaf0e2700DFBa81D0484d8c00216508CC746f7574` ("x402 demo agent" in `~/code/sbc/sbc-balance-monitor/wallets.json:28`) has Permit2 `nonceBitmap(payer, 0)` = `7`. Nonces 0, 1, 2 were each used by a successful transaction from our signer `0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6` (the single `eip155:*` signer on live `https://x402.stablecoin.xyz/supported`) to proxy `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`, seconds before each retry:

- `0x1cdc70dc0b10c128701cf92cfbb10220498a4877aad12bdb6c0402f6b5729ac2` — `settleWithPermit` (`0xfa340378`), block 51325820, mined 11:30:32 → `0x1111111111111111111111111111111111111111`
- `0x940633739e3d7eccb2da377334e431467ad14866d38a8160100bfc57fccbdc59` — `settle` (`0x13cd3b53`), block 51326301, mined 11:32:09 → `0x1111111111111111111111111111111111111111`
- `0x5e765b5210e20b11ae7e3d5f6156e74b73039ddc5b077b71aa596167d681d5b0` — `settle` (`0x13cd3b53`), block 51327697, mined 11:36:48 → `0x248E5E958B66E5b471003BFBafD008ad4F4d8f45`

These were retries after a success, not after `settlement_pending`. Under upstream behavior they also get a failure with no hash; this fix changes only their error code and metric (§4 step 4). Origin of that traffic is unknown (a test harness: 1-base-unit SBC payments, sequential nonces).

**How it was found:** triage of the 2026-10-28 11:37 UTC alert; an adversarial review pulled the on-chain history; upstream research (2026-10-29) showed trigger (1).

## 2. Root-cause hypothesis

**Confirmed by reading the code** (trigger (1) not yet reproduced live — §3.1).

`src/routes/settle.ts:499-518` — the live Permit2 path broadcasts and waits inside the per-EOA queue, recording nothing:

```ts
    const txHash = await settlementQueue.enqueue(account.address, async () => {
      // Keep preflight and broadcast in one serialization boundary: otherwise
      // concurrent duplicates can all preflight before Permit2 consumes its nonce.
      if (!isRadius) await publicClient.simulateContract({ account: account.address, address: X402_PERMIT2_PROXY, abi: proxyAbi, functionName, args });
      ...
      const hash = await wallet.writeContract({ address: X402_PERMIT2_PROXY, abi: proxyAbi, functionName, args, ...gasOverrides });
      let receipt;
      try { receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }); }
      catch (error: any) { error.broadcastHash = hash; error.settlementPending = true; throw error; }
```

The `settlement_pending` answer (`src/routes/settle.ts:1012-1023`) returns the hash but stores nothing. The only settled-record read on the Permit2 path is in simulated mode (`src/routes/settle.ts:462`). So a retry re-verifies (including the deadline, `src/evm/permit2.ts:67`), simulates, and either broadcasts again or hits `InvalidNonce()` and lands in `categorizeSettleError` (`src/routes/settle.ts:1085`) as `tx_reverted`.

Sub-mechanisms behind a retry of a payment we broadcast, and what this fix answers:

- **(a) Retry after our `settlement_pending`, same process, within the TTL, same exact message** → reconcile against the stored transaction → `success: true` + hash, or pending again, or its revert.
- **(b) Same as (a) but after a restart, on another machine, or after the TTL** → no record. If our transaction has mined: `permit2_invalid_nonce`, no hash. If not yet mined: a second broadcast that reverts on chain → `invalid_transaction_state` + the second hash. Upstream's in-memory default has the same limit; closed only by a shared store (§4 Option B).
- **(c) Retry after a confirmed success** (the observed case) → `permit2_invalid_nonce`, no hash. Upstream's chosen behavior: a byte-identical payload cannot be told from a replay of public calldata.
- **(d) Nonce used by a different message, an unrelated Permit2 app, or the payer's `invalidateUnorderedNonces`** → `permit2_invalid_nonce`. Genuinely failed.
- **(e) A forged retry** — our pending transaction's signature reused on a different message whose `from` is the address that signature recovers to — must miss (§4 step 1) and fail.

**Does this class follow us if we refactor around it?** Yes, for any path whose retry handling lives only in memory. The upstream interface is designed for a shared store; this repo has none (`fly.toml` has no volume; no database client in `package.json`).

## 3. Diagnose first (read-only, cheap — do this BEFORE §4)

1. **Reproduce trigger (1) against the real facilitator, pre-fix.** On Base Sepolia, make the receipt wait fail FAST after `writeContract` returns (a local facilitator whose receipt RPC returns an error, or a test hook that throws from `waitForTransactionReceipt`) — a slow receipt will not do, because the stock client aborts at 90 s. Confirm the answer is `settlement_pending` + hash. Then send the identical `/settle` twice: once immediately (expected pre-fix: a second broadcast that reverts → `invalid_transaction_state` + a different hash) and once after the first transaction mines (expected pre-fix: `success: false`, `transaction: ""`). If either retry succeeds, stop — the premise is wrong; update §0.
2. **Confirm the upstream port target is current.** `cd ~/code/goodmeta/x402-sweep && git fetch origin && git log origin/main -- typescript/packages/mechanisms/evm/src/exact/facilitator/permit2.ts typescript/packages/mechanisms/evm/src/shared/settleReceipt.ts typescript/packages/core/src/facilitator/pendingSettlementStore.ts typescript/packages/core/src/server/x402ResourceServer.ts | head`. If these changed after `e4a08681`, re-read them before porting.
3. **Which merchants call us with upstream middleware ≥ 2.24.0** (the release line that contains the auto-retry, PR #3214, merged 2026-08-25 as `82ba36f2`)? Not answerable from this repo; ask the owner. It sizes trigger (1), not the fix.
4. **How many machines serve production?** `fly machines list -a sbc-x402-facilitator`. `fly.toml`: `min_machines_running = 1`, `auto_start_machines = true`. More than one machine for sustained periods makes sub-mechanism (b) common and Option B due.

## 4. Fix options

- **Option A (chosen — upstream parity, hardened): a pending-settlement record bound to the exact signed message.** Port upstream's design; diverge only where upstream is unsafe or this repo's rules require it, and list every divergence (end of this option).

  **The order of operations in the live Permit2 path is part of the fix. It MUST be:**
  `parsePermit2` structural checks → off-chain signature checks → **store read (step 3)** → on a miss only: deadline/validAfter checks → **nonce bitmap read (step 4)** → simulate → broadcast.

  1. **Store and key.** Add a `PendingSettlementStore` interface (`get`, `set`, `delete`), mirroring upstream `core/src/facilitator/pendingSettlementStore.ts`, with an in-memory implementation and `PENDING_SETTLEMENT_TTL_MS = 5 * 60 * 1000` (upstream's default). Route code depends only on the interface (Option B swaps the implementation). Suggested home: `src/protection/pending-settlement-store.ts`. Do not reuse `nonceTracker` (`markSettled` is a no-op on an existing key — see History). **Key** = hash of: chain ID, the EIP-712 digest of the full Permit2 witness message (`from`, token, amount, nonce, deadline, spender, `witness.to`, `witness.validAfter`), the signature bytes, and — for `settleWithPermit` — the sponsor tuple. **Never the signature alone** (sub-mechanism (e)). The value stores the broadcast hash.
  2. **Record on pending, inside the queue.** At the receipt-wait failure (`src/routes/settle.ts:508`), `await store.set(key, hash)` INSIDE the `settlementQueue.enqueue` callback, before the error is rethrown — otherwise a queued duplicate can run between the queue releasing and the record existing, and broadcast again. If the `set` throws, answer a non-retryable failure that still carries the hash (a retry with no record would broadcast again).
  3. **Reconcile on a hit — before the time-window checks, inside the queue.** Inside `settlementQueue.enqueue`, before anything else: `get(key)`. On a hit:
     - `delete(key)` first (upstream does this so a concurrent duplicate misses).
     - **Bind the hit to our own transaction:** `getTransaction(storedHash)` and require `to == X402_PERMIT2_PROXY`, `from ==` our signer for this network, and calldata that decodes (with `proxyAbi`) to exactly this request's permit, owner, witness, signature and, for `settleWithPermit`, sponsor tuple. On any mismatch, treat it as a miss.
     - Wait for that hash's receipt with an explicit short timeout `PENDING_RECONCILE_TIMEOUT_MS` (starting value 20 s — well under the stock client's 90 s, because the condition that caused the pending answer is often the same one that slows this wait) and with replacement handling off (`checkReplacement: false`), requiring `receipt.transactionHash == storedHash` (viem otherwise resolves a *replacement* transaction's receipt, which may be a different payment from our EOA).
     - Answer: mined success → `success: true` + hash (metric `replay`); mined revert → `invalid_transaction_state` + hash (metric `tx_reverted`); still unconfirmed → `settlement_pending` + hash, `set` it again (metric `settlement_pending`). **Never broadcast on a hit.**
     - The time-window checks are skipped on a verified hit only: the transaction is already broadcast, so the permit's deadline no longer decides anything (v3 checked the deadline first, which failed every retry whose permit expired during the wait).
  4. **On a miss: deadline checks, then the nonce bitmap — never before the store read.** Read Permit2 `nonceBitmap(owner, nonce >> 8)` and test bit `nonce & 255` (math per Permit2 `SignatureTransfer.sol:142-156`). If used: `{ success: false, transaction: "", errorReason: "permit2_invalid_nonce" }`, metric `failed`. A direct read, never a substring match on viem's `error.message` (it embeds call arguments; a payTo or signature containing `756688fe` would misfire). It also stops Radius, which skips simulation (`src/routes/settle.ts:502`), from broadcasting a doomed transaction. **Reading the bitmap before the store would fail every reconcilable retry, because a mined pending transaction has already set the bit.**
  5. **Clearing.** The hit path deletes before reconciling. The miss path needs no delete in this single-process design (it only runs when there is no record); keep the call only if Option B's shared store makes it reachable.

  **Divergences from upstream, all deliberate:**
  - Key: upstream keys on `permit2Payload.signature` alone (`exact/facilitator/permit2.ts:359-382`) — unsafe, sub-mechanism (e).
  - Upstream reads the store before ANY verification and trusts the stored hash; this fix verifies structure and signature first and binds the hit to our transaction's calldata.
  - Upstream's hit wait has no separate timeout and allows replacement receipts.
  - Answer codes: upstream answers a reverted hit with `invalid_exact_evm_transaction_failed` and a failed `set` with `ErrTransactionFailed` (`permit2.ts:377-379`); this fix keeps this repo's existing codes (`invalid_transaction_state`).
  - Used nonce: upstream has no bitmap read. A used-nonce payload passes its verify (`simulate: config?.simulateInSettle ?? false`, `permit2.ts:384-386`), reverts in `writeContract`'s gas estimate, and goes to `mapSettleError` (`shared/permit2.ts:192`), which looks for the substring `InvalidNonce`. Upstream's proxy ABI declares no `InvalidNonce` error, so viem prints only the raw selector and that match most likely never fires; upstream's real answer is then most likely `invalid_exact_evm_transaction_failed: …` (inferred from the ABI and viem source, not observed). `permit2_invalid_nonce` is upstream's *named constant* (`exact/facilitator/errors.ts:54`), chosen here deliberately.

  **History — this reverses a deliberate 2026-09-07 decision; read it first.** Issue #6 (fixed by PR #7, 2026-09-07) built the `settlement_pending` answer and **deliberately rejected a pending record**, for two reasons recorded in the vault note `Projects/SBC-x402-Facilitator-Retry-Safety.md`: (1) a record "strands a dropped transaction as permanently pending", and (2) `nonceTracker.markSettled` early-returns on an existing key, so a later promotion is a no-op. The consequence was pinned by a test, `src/__tests__/settle-receipt-lost.spec.ts:143` (*"PINS KNOWN BEHAVIOR: re-presenting the same payload is answered permit_signature_invalid"*, written for the ERC-2612 path that existed then). Upstream's later design answers both: entries expire (`PENDING_SETTLEMENT_TTL_MS`), so a dropped transaction is forgotten after 5 minutes and a later retry broadcasts normally because its nonce is still unused; and `set` overwrites. The pinned test must be rewritten to assert the new behavior, not deleted.

  **Touches:** `src/routes/settle.ts`; new store file; `src/__tests__/settle-receipt-lost.spec.ts`; `src/evm/permit2.ts` (ABI for `nonceBitmap`; a digest helper for the key); `scripts/sabotage-check.py`; `grafana/README.md` (the `replay` row becomes "live EVM Permit2: retry reconciled against our pending transaction"; the `failed` row gains `permit2_invalid_nonce`; note that `tx_reverted` and `settlement_pending` feed the critical "Settle faults on our side" alert, `grafana/README.md:201`, and `failed` the info "Client error volume elevated" alert, `:206`). **Cost estimate:** one to two days including tests — basis: three upstream functions to port plus the key digest, the calldata binding and one contract read; the unknown is §3.1's harness.

- **Option B (later): a shared, durable pending store.** Same interface, backed by a store shared across machines and restarts, written BEFORE broadcast (`signature → sending`, then `→ hash`). Closes sub-mechanism (b), including the second broadcast while unmined. Needs new infrastructure; same work as the durable ledger `docs/security-assessment-2026-09-17.md:38` requires before real Solana settlement is re-enabled — build once for both. Owner agreed (2026-10-29) to ship Option A first and do this as a separate project.

- **Option C (not chosen): recover any already-settled payment from chain** (v1/v2 design: token `Transfer` log search, decode proxy calldata, match every signed field). Durable without a store, but it answers success for retries after a confirmed success (sub-mechanism (c)), which upstream deliberately does not: a byte-identical payload is public calldata after settlement, so a stock merchant (which branches only on `success`, `x402HTTPResourceServer.ts:871`) would deliver again to anyone who replays it before `deadline`. Revisit only if upstream adopts "already settled" semantics (#277, #452). Its research notes — 200-block `eth_getLogs` cap on public Base Sepolia, 0.2 s vs 2 s block times — are in the v2 history of this file.

**Out of scope:** answering retries after a confirmed success with success (Option C); `payment-identifier` extension support (the spec's real answer to general idempotency; separate brief); `/verify` not checking the nonce bitmap; the `settleWithPermit` raw `v` encoding (`src/routes/settle.ts:497`); the first-attempt receipt wait (viem default 180 s) outliving the stock client's 90 s timeout, which makes a slow receipt invisible to the client — worth its own brief; the first-attempt receipt wait also accepts replacement receipts (`src/routes/settle.ts:507`) — fix alongside, same one-line change.

## 5. Validate (mandatory before anyone writes "done")

- [ ] **Repo gate:** `npx tsc --noEmit && npm test && python3 scripts/sabotage-check.py` — all green.
- [ ] **Regression guard (trigger 1):** first `/settle` broadcasts and the receipt wait throws → `settlement_pending` + hash; second identical `/settle`, with the mocked receipt now successful and the mocked bitmap bit SET → `success: true`, same hash, `writeContract` called exactly once in total. Must fail on pre-fix code. The set bit is what makes this test also fail if the bitmap is read before the store.
- [ ] **Regression guard (forgery, sub-mechanism (e)):** after a pending answer, a `/settle` carrying the same signature on a different message (different `witness.to`/amount/nonce, `from` = the address the signature recovers to for that message, built as in v4's review harness) must NOT return the stored hash and must not call `writeContract`. Must fail against a signature-only key.
- [ ] **Regression guard (trigger 2):** a used-nonce payload with no record → `permit2_invalid_nonce`, metered `failed`, no `simulateContract`/`writeContract`. Must fail on pre-fix code (today: `tx_reverted`).
- [ ] **Edge tests:** hit with a reverted receipt → `invalid_transaction_state` + hash; hit still unconfirmed past `PENDING_RECONCILE_TIMEOUT_MS` → `settlement_pending` + hash, record re-set; hit whose stored transaction's calldata does not match → treated as a miss; hit whose receipt is a replacement (different `transactionHash`) → not a success; retry after the permit `deadline` with a record → reconciles (v3 regression); a payload failing signature verification never reads the store; `set` throwing (requires an injected failing store — the in-memory `Map` cannot fail) → non-retryable failure carrying the hash. Concurrency: two retries on a hit, with the mocked first reconcile ending in success and the bitmap bit set → exactly one answers `success`, the other `permit2_invalid_nonce`.
- [ ] **Sabotage entries** in `scripts/sabotage-check.py`, each must turn a test red: broadcast on a store hit; key on the signature alone; read the bitmap before the store; drop the calldata binding; accept a replacement receipt. (Not "skip delete before reconciling": with the reconcile serialized in the queue, no test can observe that — assert call order instead if it matters.)
- [ ] **Real-target verification (required).** On Base Sepolia with the deployed facilitator: (i) force `settlement_pending` with a fast receipt-RPC error (§3.1), retry the identical payload after mining, and confirm with `cast receipt <hash>` that the returned hash is the original and with `cast logs` (Transfer from the payer over the window) that only one transfer happened; (ii) send a forged same-signature retry and confirm it fails without the hash; (iii) retry an already-confirmed payment and confirm `permit2_invalid_nonce` and no new transaction from our signer.
- [ ] **Measured criterion — report "not applicable" if nothing exercised it.** Over 14 days after deploy, count `/settle` retries that follow a `settlement_pending` answer (Loki). If zero, the real-target check is the evidence. If non-zero: none answered with an empty `transaction` or a second broadcast. Also: zero "Settle faults on our side" pages caused by `InvalidNonce` (pre-fix baseline: one page, 2026-10-28 11:37 UTC).
- [ ] **Deploy safety:** merging to `main` deploys to Fly (`.github/workflows/fly-deploy.yml`, job `Deploy`) and restarts the machine, which empties the in-memory store — a retry in flight across the deploy falls into sub-mechanism (b). Merge when `x402_settle_total` is idle. Smoke after: `curl https://x402.stablecoin.xyz/health` and one real Base Sepolia settle.

Until the real-target check passes and the measured criterion is reported, status stays **IMPLEMENTED (validation pending)**, never DONE.

## 6. What this does NOT fix

- **Sub-mechanism (b):** a retry after a restart, on another machine, or after 5 minutes. If our transaction has mined: `permit2_invalid_nonce`, no hash, although the payment landed. If not yet mined: a second broadcast that reverts on chain (gas lost) → `invalid_transaction_state` + the second hash. Same limit as upstream's in-memory default; closed only by Option B.
- **Sub-mechanism (c):** a retry after a confirmed success gets a failure with no hash — by design, matching upstream. The merchant must keep the first answer (or use `payment-identifier`).
- **Replay inside the pending window.** The pending transaction's calldata is public. Anyone who rebuilds the identical payload and sends it to the same merchant within the TTL, before the merchant's own retry, gets `success: true` — a second delivery — and the merchant's own retry then misses. This is the objection used against Option C, bounded to the pending window (≤ 5 minutes) instead of the permit deadline. Upstream has it too.
- **Queue blocking.** A hit waits inside the per-EOA settlement queue for up to `PENDING_RECONCILE_TIMEOUT_MS`. One signer serves every EVM network (live `/supported`), so that wait delays every EVM settle, Base mainnet included.
- **Solana** (no Permit2 nonce; real settlement withheld) and the legacy ERC-2612 path (unreachable — the Permit2 block at `src/routes/settle.ts:437-519` always returns or throws first).

**Decision gate for Option B:** build the shared store when real Solana settlement is to be re-enabled, or when production runs more than one machine for sustained periods (§3.4).

## 7. Constraints the executing agent must respect

- "Once a transfer is broadcast, no answer is terminal and no answer omits the hash" (repo `CLAUDE.md`). Every answer on a hit carries the stored hash. Sub-mechanisms (b) and (c) answer `permit2_invalid_nonce` with an empty `transaction` although an earlier request of ours broadcast — that conflicts with the plain wording of this rule and needs the owner's sign-off (§9.1) recorded in `CLAUDE.md` before merge.
- "`/settle` validates every payment independently on every network" (repo `CLAUDE.md`) — structural and signature checks run before the store read; a hit is trusted only after the calldata binding in step 3.
- "Raw RPC client errors never reach a response body" and "Settlement never fails open" (repo `CLAUDE.md`). A failed bitmap read or `getTransaction` is our fault (`rpc_connection_error`), never a guessed answer.
- Never match a revert selector or error name against viem's full `error.message`.
- Rules files: `~/.claude/scoped-rules/verify-integration-on-real-target.md`, `~/.claude/scoped-rules/live-smoke-before-deploy.md`, `~/.claude/scoped-rules/full-onchain-identifiers.md`, `~/code/sbc/security-triage/docs/COMMON-LESSONS.md` (read before a security-relevant change; add the lesson — "an idempotency key must bind the whole signed message, never the signature alone" — there).
- Forbidden: broadcasting on a store hit; keying the store on the signature alone; printing RPC URLs whole (they carry keys).

## 8. References

This repo (verified 2026-10-29 on `880c4b2`):
- `src/routes/settle.ts:499-518` — live Permit2 simulate → broadcast → receipt inside `settlementQueue.enqueue`; `:508` sets `settlementPending`; `:502` Radius skips simulation; `:507` receipt wait (viem defaults)
- `src/routes/settle.ts:1012-1023` — `settlement_pending` answer (hash, no record); `:1026-1037` mined-revert answer; `:1085` `categorizeSettleError`
- `src/routes/settle.ts:462` — simulated-mode settled-record read (the only one on the Permit2 path)
- `src/evm/permit2.ts:4,6,83` — `PERMIT2_ADDRESS`, `X402_PERMIT2_PROXY`, `proxyAbi`; `:67` deadline rejection; `:75-77` off-chain `verifyTypedData` against `auth.from`
- `src/protection/nonce-tracker.ts` — existing in-memory record (Solana and simulated EVM); `markSettled` is a no-op on an existing key
- `src/__tests__/settle-receipt-lost.spec.ts:143` — test pinning the 2026-09-07 behavior this fix changes
- `grafana/README.md:139` (`replay` row), `:201` and `:206` (which labels feed which alert)
- Vault `Projects/SBC-x402-Facilitator-Retry-Safety.md` — issue #6 / PR #7 history, including why a pending record was rejected on 2026-09-07

Upstream `x402-foundation/x402` `main` @ `e4a08681` (local clone `~/code/goodmeta/x402-sweep`, remote `origin`):
- `typescript/packages/core/src/facilitator/pendingSettlementStore.ts` — interface; `:7` `PENDING_SETTLEMENT_TTL_MS = 5 * 60 * 1000`; in-memory default
- `typescript/packages/mechanisms/evm/src/exact/facilitator/permit2.ts:359-382` — store read before verify, key = `permit2Payload.signature`, delete before reconcile; `:384-386` verify without simulation
- `typescript/packages/mechanisms/evm/src/shared/settleReceipt.ts:40` `waitAndReturnSettleResponse`, `:132` `withPendingSettlementStore`
- `typescript/packages/core/src/server/x402ResourceServer.ts:1652-1673` — single immediate retry on a `settlement_pending` result
- `typescript/packages/core/src/http/httpFacilitatorClient.ts:17` — `DEFAULT_TIMEOUT_MS = 90_000`
- `typescript/packages/core/src/http/x402HTTPResourceServer.ts:871` — merchant branches only on `success`
- `typescript/packages/mechanisms/evm/src/exact/facilitator/errors.ts:54` — `permit2_invalid_nonce`; `shared/permit2.ts:192` — substring mapping
- `specs/x402-specification-v2.md` §5.3.2, §9, §10.1; `specs/extensions/payment_identifier.md`
- Issues #277, #452 (open); #2294 (closed 2026-09-21; `CarsonRoscoe` comment); PR #3214 merged 2026-08-25 (`82ba36f2`, in `npm-@x402/core@v2.24.0`)

## 9. Open questions

1. **Owner sign-off needed before merge:** sub-mechanisms (b) and (c) answer with an empty `transaction` although an earlier request of ours broadcast the payment. That matches upstream but contradicts the plain wording of this repo's rule "no answer omits the hash". Approve it as a recorded exception in `CLAUDE.md`, or reword the rule.
2. **`PENDING_RECONCILE_TIMEOUT_MS` value.** 20 s is a starting point (under the stock client's 90 s, while holding the shared queue as briefly as practical). Tune after §3.1.
3. **Which merchants use upstream middleware ≥ 2.24.0 against this facilitator?** Sizes trigger (1).
4. **Who ran the 2026-10-28 traffic** from the demo-agent wallet is unknown; not needed for the fix.
5. **Should this facilitator support the `payment-identifier` extension** for general idempotency? Separate brief if yes.
