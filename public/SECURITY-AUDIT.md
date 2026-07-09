# Asset Loop — Security Audit Package

**Status:** pre-mainnet. Settlement runs on **signet** only. Mainnet is hard-blocked
in code (`settlement.js → resolveNetwork()`) and must not be enabled until the
findings below are resolved and independently reviewed.

**Audience:** an external reviewer with Bitcoin custody / PSBT / Ordinals expertise.

---

## 1. What the system does

Asset Loop is a consignment-loop marketplace. A user consigns a Counterparty (XCP)
or Ordinals (BTC) asset; a pool of AI buyer-agents (built-in + external wallet-
connected + API-key) negotiates in a continuous English auction and re-lists to
higher bidders. Settlement (the fund-moving step) is a two-party atomic PSBT swap.

**Trust model — the non-negotiable invariant:** the platform NEVER holds a private
key and NEVER custodies funds. Every participant (human or AI agent) connects their
own self-custody wallet. The server only (a) constructs unsigned / partially-signed
PSBTs and (b) relays fully-signed transactions to a public indexer for broadcast.

## 2. Architecture / attack surface

| Component | File | Notes for review |
|---|---|---|
| App server (Express) | `server.js` | All external calls server-side; browser uses relative fetch only. |
| Settlement engine | `settlement.js` | PSBT construction, UTXO selection, broadcast. **Primary review target.** |
| Wallet auth | `server.js` (`/api/auth/*`) | Nonce challenge + signature verify (EVM eip191 via ethers; BTC bip137 via bitcoinjs-message; taproot BIP-322 = pending). |
| Bidding | `server.js` (`/api/bid`) | Standing max-bids; auth by wallet session or API key. Simulation, no funds. |
| Metadata lookup | `server.js` (`/api/lookup`) | Read-only mainnet reads (ordinals.com, api.counterparty.io). |
| DB | Dashboard API | Server-side only; no SQL in browser. String values escaped via `sqlVal()` — **review for injection** (see §4.5). |

## 3. Settlement flow under review

Canonical seller-offer / buyer-completion swap:

1. **Seller offer** (`buildSellerOffer`): input[0] = inscription UTXO, signed
   `SIGHASH_SINGLE | ANYONECANPAY`; output[0] = payment to seller. Self-contained.
2. **Buyer completion** (`buildBuyerCompletion`): adds buyer payment inputs,
   output[1] = inscription → buyer, output[2] = change. Buyer signs `SIGHASH_ALL`.
3. **Broadcast** (`finalizeAndBroadcast`): finalize all inputs, extract, POST to indexer.

## 4. Findings (self-identified — verify + extend)

### 🟠 FINDING #1 — CRITICAL — inscription sat routing — **ADDRESSED, verify**
*Original:* under Ordinals FIFO sat theory, the sats of input[0] carrying the
inscription flowed into output[0] = the seller payment, so the buyer paid but did
NOT receive the inscription (or it could be burned to fee).
*Fix shipped (`settlement.js`):*
- `ordinalRoutedOutput()` computes, by FIFO sat-flow, exactly which output the
  inscription lands in (or -1 = burned). `assertOrdinalRouting()` throws unless it
  lands in the intended buyer output. **This guard now wraps every build path** —
  the legacy `buildBuyerCompletion` correctly REFUSES (it misrouted), and callers
  must use the new routing-verified builder.
- `buildAtomicSwap()` assembles the dummy-padded layout: inputs [buyer dummy,
  seller inscription, buyer payment]; outputs [inscription→buyer (dummy+insc value),
  payment→seller, change]. The dummy shifts the inscription sat into output[0]
  (buyer). Verified by the guard before the PSBT is returned.
- Assembled as ONE full unsigned tx so input indices are fixed before signing.
*On-chain proof (regtest) — with a REAL inscription:* executed end-to-end on a
local Bitcoin Core v28 regtest chain + `ord` v0.22.2, two independent wallets — see
`PROOF-REGTEST.md`. A genuine `ord`-inscribed inscription (`a9d52a…896i0`) was sold
via `buildAtomicSwap` from the ord (seller) wallet to a buyer wallet. **`ord` itself
confirms the inscription's new owner is the buyer** (satpoint now in swap tx
output[0]); seller paid; single atomic tx. All acceptance criteria PASSED. Regtest =
mainnet consensus/PSBT/sat rules, so this proves the routing on real Bitcoin
semantics with a real inscription.

*Still to verify by the auditor:*
1. Confirm behaviour for NON-ZERO inscription sat offsets (proof used offset 0, the
   common case) and multi-inscription UTXOs.
2. Confirm the inscription offset is 0 (first sat); handle non-zero offsets.
3. The legacy pre-signed "listing" offer (`buildSellerOffer`) uses SIGHASH_SINGLE|
   ANYONECANPAY and is index-fragile — recommend replacing with an audited swap
   library (e.g. OpenOrdex-derived) rather than the hand-rolled listing path.

### 🟠 FINDING #2 — fee & value conservation (fixed, please verify)
An earlier draft double-counted `inscriptionValue` in the buyer's required balance
and in change, inflating the miner fee by the inscription value. Corrected so the
buyer covers only `price + fee` and the inscription output is funded by input[0].
Re-derive and confirm: `fee_actual == estFee`. Confirm `estFee` vbyte model matches
real witness sizes for the address types accepted.

### 🟠 FINDING #3 — no dust / output-value floors on price or inscription value
`priceSats`, `inscriptionValue` are taken from inputs with minimal bounds. Add dust
thresholds, sane min/max, and reject economically-irrational swaps.

### 🟡 FINDING #4 — taproot (BIP-322) signatures are not verified
`verifySignature()` returns `verified:false, method:'bip322-pending'` for `bc1p`
addresses; the session is still created (labelled unverified). Decide whether
unverified taproot sessions may bid, and implement real BIP-322 verification.

### 🟡 FINDING #5 — indexer trust
UTXO set, fee rate, and broadcast all depend on `mempool.space`. A compromised or
stale indexer could feed spent/incorrect UTXOs. Consider multi-source confirmation
and/or the user's own node; validate UTXO existence + confirmations before signing.

### 🟡 FINDING #6 — SQL string interpolation
DB writes build SQL by string concatenation with a custom `sqlVal()` escaper.
Prefer parameterized queries; audit `sqlVal()` for every type path (numbers, null,
JSON blobs, user-supplied strings incl. wallet labels / personas).

### 🟢 FINDING #7 — nonce/session hygiene (looks OK, confirm)
Challenges are single-use (deleted on verify), 10-min expiry; sessions 24h. Confirm
no replay window, and that sessions are bound to the exact verified address.

## 5. Mainnet go-live checklist (all must pass)
- [ ] Finding #1 fixed with correct dummy-padding ordinal swap + inscription-sat
      lands with buyer, proven on signet with a REAL signet inscription.
- [ ] Findings #2–#7 resolved / accepted with rationale.
- [ ] Independent review of `settlement.js` by a Bitcoin security auditor.
- [ ] Signet dry-runs: ≥1 successful inscription-preserving swap, verified on-chain.
- [ ] Fee-rate sanity + RBF/timeout policy defined.
- [ ] Explicit legal/compliance review of operating a marketplace.
- [ ] Only then set `ASSET_LOOP_NETWORK=mainnet` + `ASSET_LOOP_ALLOW_MAINNET=I_UNDERSTAND`.

## 6. How to reproduce / test on signet
1. Install a Bitcoin wallet (UniSat / OKX / Leather), switch to **signet**.
2. Fund from a signet faucet (e.g. signetfaucet.com).
3. In the app: Connect wallet → Settlement Studio → build offer with one of your
   own UTXOs (Load my signet UTXOs) → sign → have a second wallet complete + sign +
   broadcast → verify the resulting tx on the signet explorer.

*This document is generated by the builder as an honest starting point. It is not a
substitute for an independent professional audit.*
