# Asset Loop — reproducible on-chain proof (regtest)

`regtest-reproduce.sh` stands up a local Bitcoin Core v28 regtest node + `ord`
v0.22.2 indexer, creates a **real inscription**, sells it via the production
`buildAtomicSwap()` from a seller wallet to a buyer wallet, broadcasts + confirms,
and verifies with `ord` that the inscription now belongs to the buyer. No faucet.

## Run
```bash
bash tools/regtest-reproduce.sh
```
Idempotent — re-run any time; each run inscribes a fresh inscription. First run
downloads the Bitcoin Core + ord binaries into `$BTC_ROOT` (default
`/app/groups/main/.btctest`). Requires: linux x86_64, curl, python3, and `node`
with the repo's `node_modules` installed (`npm install` in the repo root).

## Expected output (tail)
```
=== verification ===
inscription satpoint now: <swaptxid>:0:1000 -> BUYER
  out[0] 11000 -> BUYER     (dummy 1000 + inscription 10000)
  out[1] 50000 -> SELLER    (payment)
  out[2] ...   -> BUYER     (change)
  [PASS] ord: inscription owned by BUYER
  [PASS] ord: inscription in swap output[0]
  [PASS] output[0]=buyer, 11000 sats
  [PASS] seller received 50000 sats
  [PASS] single atomic tx
  [PASS] confirmed
RESULT: ALL PASS ✅
```

## What it exercises
- `settlement.js → buildAtomicSwap()` — the dummy-padded routing-correct swap.
- `settlement.js → assertOrdinalRouting()` — the sat-flow guard (would abort the
  build if the inscription sat did not land in the buyer output).
- Two-party PSBT signing (seller taproot input + buyer p2wpkh inputs), finalize,
  broadcast, confirm.
- `ord` independent verification of the inscription's new owner.

## Files
- `regtest-reproduce.sh` — the end-to-end runner.
- `regtest-swap-build.js` — thin wrapper that calls the production `buildAtomicSwap`.

See `../public/PROOF-REGTEST.md` for a recorded run and `../public/AUDIT-HANDOFF.md`
for the auditor scope.
