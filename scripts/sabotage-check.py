#!/usr/bin/env python3
"""
Sabotage matrix: prove the tests fail for the reason they claim.

"The test fails when the fix is missing" is the easy half. A test can also pass
on a fix that is subtly wrong, in which case it is measuring something other
than what its name says. This applies deliberately partial fixes — each one a
plausible mistake someone could actually make — and requires the relevant tests
to go red on every single one.

A mutation that is NOT caught is the finding: it means no test covers that
property, whatever the suite's green tick implies.

Known weakness, stated so nobody mistakes a pass for more than it is: a mutation
counts as caught when the test run exits non-zero, and this suite is
intermittently flaky. A flaky failure therefore reads as "caught". That makes
this gate fail-safe for CI but means a green result is weaker evidence than it
looks. Re-run a surprising pass before trusting it.

    python3 scripts/sabotage-check.py

Exits non-zero if any mutation survives. Restores every file via git, and
refuses to start unless src/ is clean so it can never eat uncommitted work.
"""
import subprocess, sys, io, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# (name, file, find, replace, jest args)
MUTATIONS = [
    (
        "EIP-3009 recipient not bound to payTo",
        "src/evm/eip3009.ts",
        "if (!isAddress(requirements?.payTo) || !sameAddress(auth.to, requirements.payTo)) return",
        "if (!isAddress(requirements?.payTo)) return",
        ["src/__tests__/eip3009.spec.ts"],
    ),
    (
        "EIP-3009 value not bound to the exact amount",
        "src/evm/eip3009.ts",
        "BigInt(auth.value) !== BigInt(requirements.amount)",
        "BigInt(auth.value) < BigInt(requirements.amount)",
        ["src/__tests__/eip3009.spec.ts"],
    ),
    (
        "EIP-3009 high-s signature accepted (Radius broadcasts it unsimulated and pays gas)",
        "src/evm/eip3009.ts",
        " > SECP256K1_HALF_N) return",
        " > SECP256K1_HALF_N && false) return",
        ["src/__tests__/eip3009.spec.ts"],
    ),
    (
        "absent assetTransferMethod no longer selects EIP-3009 (spec default)",
        "src/evm/eip3009.ts",
        "return method === undefined || method === 'eip3009';",
        "return method === 'eip3009';",
        ["src/__tests__/eip3009.spec.ts", "src/__tests__/eip3009-settle.spec.ts"],
    ),
    (
        "EIP-3009 settle re-broadcasts when the nonce was consumed while queued",
        "src/routes/settle.ts",
        "        if (used) return { used: true };\n",
        "",
        ["src/__tests__/eip3009-settle.spec.ts"],
    ),
    (
        "EIP-3009 success answered without the signed Transfer in the receipt",
        "src/routes/settle.ts",
        "      if (!outcome.transferSeen) {",
        "      if ((false as boolean)) {",
        ["src/__tests__/eip3009-settle.spec.ts"],
    ),
    (
        "Solana settle skips signature verification",
        "src/routes/settle.ts",
        "const verification = await verifySolanaPayment(paymentPayload.payload, paymentRequirements, log);",
        "const verification = await Promise.resolve({ isValid: true, payer: String(paymentPayload.payload.from), invalidReason: null as string | null });",
        ["src/__tests__/solana-settle-auth.spec.ts"],
    ),
    (
        "settlement_pending answered without the broadcast hash",
        "src/routes/settle.ts",
        "        transaction: error.broadcastHash,\n        network,\n        errorReason: 'settlement_pending',",
        "        transaction: '',\n        network,\n        errorReason: 'settlement_pending',",
        ["src/__tests__/permit2-settle.spec.ts"],
    ),
    (
        "replay keyed on the client-chosen nonce, not the signature",
        "src/routes/settle.ts",
        "const solanaSignature: string = paymentPayload.payload.signature;",
        "const solanaSignature: string = String(paymentPayload.payload.nonce);",
        ["src/__tests__/solana-settle-auth.spec.ts", "-t", "reuse a nonce"],
    ),
    (
        "a reverted transfer receipt treated as success",
        "src/routes/settle.ts",
        "      if (receipt.status === 'reverted') {\n        const err: any = new Error('Permit2 settlement reverted');",
        "      if ((false as boolean)) {\n        const err: any = new Error('Permit2 settlement reverted');",
        ["src/__tests__/permit2-settle.spec.ts", "-t", "reverted"],
    ),
    (
        "Solana ignores the settlement kill switch",
        "src/routes/settle.ts",
        "      if (solanaMode === 'disabled') {\n        log.error({ payer: solanaOwner",
        "      if ((false as boolean)) {\n        log.error({ payer: solanaOwner",
        ["src/__tests__/solana-settle-auth.spec.ts", "-t", "kill switch"],
    ),
    (
        "Solana recipient binding compares case-insensitively",
        "src/solana/verify.ts",
        "    if (to !== paymentRequirements.payTo) {",
        "    if (to.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {",
        ["src/__tests__/solana-settle-auth.spec.ts", "-t", "letter case"],
    ),
    (
        "Sui ledger record released after a broadcast whose outcome is unknown",
        "src/routes/settle.ts",
        "if (broadcastByUs) await ledgerWrite(log, () => ledger.mark(key, 'broadcast'));",
        "if (broadcastByUs) await ledgerWrite(log, () => ledger.release(key));",
        ["src/__tests__/sui-exact-route.spec.ts", "-t", "cannot resubmit"],
    ),
    (
        "Sui treats every chain success as this request's own broadcast",
        "src/routes/settle.ts",
        "const broadcastByUs = settled.transaction !== '';",
        "const broadcastByUs = true;",
        ["src/__tests__/sui-exact-route.spec.ts", "-t", "NOT broadcast by this request"],
    ),
    (
        "Sui treats no chain success as this request's own broadcast",
        "src/routes/settle.ts",
        "const broadcastByUs = settled.transaction !== '';",
        "const broadcastByUs = false;",
        ["src/__tests__/sui-exact-route.spec.ts", "-t", "THIS request broadcast"],
    ),
    (
        "Sui reports a lost-receipt success without checking the executed effects",
        "src/routes/settle.ts",
        "const effects = suiEffectsVerdict(after.balanceChanges, paymentRequirements);",
        "const effects = { kind: 'match' } as ReturnType<typeof suiEffectsVerdict>;",
        ["src/__tests__/sui-exact-route.spec.ts", "-t", "exactly the amount"],
    ),
    (
        "Sui settles for real with no durable ledger",
        "src/routes/settle.ts",
        "if (!ledger) return durabilityUnavailable();",
        "if (!ledger) return reply({ success: true, payer, transaction: digest, network });",
        ["src/__tests__/sui-exact-route.spec.ts", "-t", "no ledger configured"],
    ),
]


def dirty() -> str:
    return subprocess.run(["git", "status", "--porcelain", "src"],
                          capture_output=True, text=True).stdout.strip()


def restore(path: str) -> None:
    subprocess.run(["git", "checkout", "--", path], check=True)


def main() -> int:
    if dirty():
        print("src/ has uncommitted changes. Commit or stash first — this script\n"
              "restores files with `git checkout --` and would discard them.")
        return 2

    print(f"Sabotage matrix — {len(MUTATIONS)} partial fixes\n")
    survived = []

    for name, path, find, repl, jest_args in MUTATIONS:
        src = io.open(path, encoding="utf-8").read()
        if src.count(find) != 1:
            print(f"  SKIP  {name}\n        anchor matched {src.count(find)} times in {path}")
            survived.append(f"{name} (anchor stale — mutation never applied)")
            continue

        io.open(path, "w", encoding="utf-8").write(src.replace(find, repl))
        try:
            proc = subprocess.run(["npx", "jest", *jest_args, "--silent"],
                                  capture_output=True, text=True)
        finally:
            restore(path)

        if proc.returncode == 0:
            print(f"  NOT CAUGHT  {name}")
            survived.append(name)
        else:
            print(f"  caught      {name}")

    print()
    if survived:
        print("FAIL — these partial fixes went undetected:")
        for s in survived:
            print(f"  - {s}")
        print("\nEach one is a property no test actually checks.")
        return 1

    print("PASS — every partial fix was caught by a test.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
