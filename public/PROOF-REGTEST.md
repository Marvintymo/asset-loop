# Asset Loop — On-chain Proof (regtest)

The routing-verified atomic swap (`buildAtomicSwap` + `assertOrdinalRouting`) was
executed end-to-end on a **local Bitcoin Core v28.0 regtest** node with the
**`ord` v0.22.2** indexer — a private chain we control, no faucet dependency.
Regtest uses identical consensus, PSBT, and sat-flow rules to mainnet.

## ✅ PROOF A — REAL ord-indexed inscription (closes finding #1)

A genuine inscription was created with `ord wallet inscribe`
(`a9d52a…896i0`, on a taproot UTXO, sat offset 0), then sold via `buildAtomicSwap`
from the **ord (seller) wallet** to a separate **buyer** wallet.

Swap tx `b712fde1…957a`:
```
in[0] 1000   (buyer dummy)
in[1] 10000  <== INSCRIPTION (seller, taproot)
in[2] 100000 (buyer payment)
out[0] 11000 -> BUYER    ← inscription lands here
out[1] 50000 -> SELLER   ← payment
out[2] 49386 -> BUYER    ← change
```

**Verified by `ord` (the authoritative indexer), not just by us:**
`GET /inscription/a9d52a…896i0` → current satpoint `b712fde1…957a:0:1000`,
current address = the **buyer's** address. (Offset 1000 = the inscribed sat sits
1000 sats into output[0], because the buyer's 1000-sat dummy precedes it — exactly
what the dummy-padding is designed to do.)

Acceptance criteria — ALL PASS:
- [PASS] ord: inscription now owned by BUYER
- [PASS] ord: inscription located in swap tx output[0]
- [PASS] output[0] = buyer, 11000 sats (dummy + inscription)
- [PASS] seller received 50,000 sats
- [PASS] single atomic tx
- [PASS] confirmed

This is the belt-and-braces proof: a **real inscription**, moved by the production
`buildAtomicSwap`, verified by `ord` to now belong to the buyer.

---

## PROOF B — earlier plain-UTXO run (pipeline sanity)

An earlier run on Bitcoin Core v27 regtest used a plain UTXO as the inscription
stand-in to prove the build→sign→broadcast→confirm pipeline and sat-flow routing.

## Setup
- Bitcoin Core v27.0, `-regtest`, two separate wallets: **seller** and **buyer**.
- Coins mined directly (coinbase), no faucet.
- UTXOs:
  - seller inscription UTXO: 10,000 sats (locked to prevent coin-selection reuse)
  - buyer dummy UTXO: 1,000 sats
  - buyer payment UTXO: 100,000 sats
- Price: 50,000 sats. Fee: 614 sats. Change to buyer: 49,386 sats.

## The swap transaction
```
INPUTS:
  in[0] 1000   sats   (buyer dummy)
  in[1] 10000  sats   <== INSCRIPTION INPUT (seller)
  in[2] 100000 sats   (buyer payment)
OUTPUTS:
  out[0] 11000 sats -> BUYER          (dummy + inscription value)
  out[1] 50000 sats -> SELLER-payout  (payment)
  out[2] 49386 sats -> BUYER          (change)
```

## Sat-flow (the finding-#1 check)
The inscribed sat is the first sat of the inscription input (in[1]). With the
buyer dummy at in[0], its global position is **1000**, which falls inside
**out[0]** (covers global sats [0, 11000)) → routed to the **BUYER**. ✔

## Acceptance criteria — ALL PASS
- [PASS] inscription input was spent by this tx
- [PASS] inscribed sat routed to BUYER output[0]
- [PASS] seller received 50,000 sats payment
- [PASS] single atomic tx (asset + payment together)
- Confirmed: 1 confirmation

## What this proves — and does not
**Proves:** `buildAtomicSwap` produces a valid tx; two independent wallets each
sign their own inputs; it broadcasts, confirms, and the inscribed sat provably
lands with the buyer — on real Bitcoin consensus.

**Does NOT yet prove / still required before mainnet:**
1. A real **ord-indexed inscription** (regtest used a plain UTXO as the inscription
   stand-in; sat-flow is identical, but an `ord`-verified run is the belt-and-braces
   check — non-zero sat offsets especially).
2. Independent **security audit** of `settlement.js`.
3. Findings #3–#7 (dust floors, BIP-322 taproot, indexer trust, SQL, nonce hygiene).

Regtest txids are local to the node and not on any public explorer; this document
is the evidence record. Reproducible via the steps above.
