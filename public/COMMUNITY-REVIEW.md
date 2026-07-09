# Asset Loop — Community Review Request (copy-paste ready)

Use this to get real, free external eyes on the settlement code from people who
know Bitcoin PSBT / Ordinals swaps. **Do not pay a "free auditor"; do not move
real BTC until an independent reviewer who knows this primitive signs off.**

## Where to post (free, legitimate)
1. **Bitcoin StackExchange** (bitcoin.stackexchange.com) — tag `psbt`, `taproot`, `ordinals`. Best for precise PSBT/sighash/sat-flow questions.
2. **Ordinals / OpenOrdex community** — the ordinals Discord (dev channels) and the OpenOrdex GitHub; they built this exact atomic-swap primitive.
3. **Public GitHub repo** — push `settlement.js` + `tools/` + these docs, open an issue titled "Review request: ordinal atomic-swap PSBT construction", link it around.
4. **delvingbitcoin.org** — for a deeper design-level critique.

## What to share
- `settlement.js` (~260 lines — the whole swap engine).
- `tools/regtest-reproduce.sh` + `tools/test-offsets.js` (reproducible proof + unit tests).
- `PRE-AUDIT.md` (findings + what's fixed) and `SECURITY-AUDIT.md` (threat model).

## The pitch (paste this)
> I've built an Ordinals atomic-swap marketplace. The core is a dummy-padded PSBT
> swap (`buildAtomicSwap` in settlement.js): inputs `[buyer dummy, seller
> inscription, buyer payment]`, outputs `[inscription→buyer (dummy+inscription
> value), payment→seller, change]`, assembled as one unsigned tx and co-signed by
> both parties. A sat-flow verifier (`assertOrdinalRouting`) asserts the inscribed
> sat lands in the buyer output before signing. It's proven end-to-end on regtest
> with a real `ord` inscription (reproducible via tools/regtest-reproduce.sh).
> It runs on signet/regtest only; mainnet is hard-blocked in code. Before I'd ever
> consider mainnet I want independent eyes. Specific questions below.

## Specific questions to ask reviewers
1. **Sat routing:** Is the dummy-padded layout correct for ALL cases — non-zero
   inscription offsets, multiple inscriptions per UTXO, cursed/reinscribed sats?
   (I currently move the whole seller UTXO to the buyer — how should I split a
   multi-inscription UTXO safely?)
2. **Sighash:** I assemble the full tx and sign every input with `SIGHASH_ALL`
   (no pre-signed listing). Is the seller fully protected (paid iff asset moves)?
   Any advantage/risk vs the OpenOrdex `SINGLE|ANYONECANPAY` listing model?
3. **Taproot:** Inputs are added `witnessUtxo`-only. What tap fields
   (`tapInternalKey`, sighash) must be present for arbitrary external taproot
   signers to finalize reliably?
4. **Fees:** Is my vbyte model (68 in / 43 out / +11 / ×1.1) safe across input
   types and real fee markets? RBF/CPFP recommendations since we hold no keys?
5. **Indexer trust:** Best practice for confirmation depth + double-spend checks
   before building/broadcasting? Multi-indexer quorum worth it?
6. **Dust / standardness:** Are my 546-sat floors and output ordering
   mempool-standard on mainnet?

## Also worth doing (free, automated)
- Run `semgrep --config auto settlement.js server.js` in CI (couldn't install in
  the build sandbox).
- `npm audit` (currently 3 low-severity via `elliptic`).
- Put a **signet bounty**: publish the swap on signet and invite people to break
  it — free, and attackers self-select.

## What NOT to do
- Don't accept an unsolicited "free professional audit" offer — common backdoor/
  exploit setup for money-moving code.
- Don't enable mainnet (`ASSET_LOOP_NETWORK=mainnet` + `ASSET_LOOP_ALLOW_MAINNET`)
  until the remaining items in `PRE-AUDIT.md` are resolved and reviewed.
