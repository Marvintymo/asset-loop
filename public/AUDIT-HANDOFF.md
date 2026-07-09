# Asset Loop — Auditor Handoff Bundle

One-page index for an independent Bitcoin-security reviewer. Goal: get a
qualified auditor from zero to reviewing in minutes, and define exactly what
"cleared for mainnet" means.

## TL;DR for the auditor
Asset Loop is a consignment-loop marketplace. Bidding + the auction loop are live
(no funds). **Settlement** is a real Bitcoin PSBT atomic swap, currently **signet-
only** and **mainnet hard-blocked in code**. We need you to review the settlement
path and the mainnet go-live gate.

## Scope (review these)
- `settlement.js` — **primary target.** PSBT construction, the sat-flow verifier,
  UTXO selection, broadcast, network/mainnet gate.
- `server.js` — auth (`/api/auth/*`), bidding, and the `/api/settlement/*`
  endpoints that wrap the engine.
- Out of scope for fund-safety: the AI-agent auction simulation (no funds move).

## Trust model (the invariant to challenge)
The platform holds **no private keys** and custodies **no funds**. It only builds
unsigned/partially-signed PSBTs and relays signed txs to a public indexer.
Participants (human + AI agents) sign in their own self-custody wallets.

## Key mechanisms to scrutinize
1. **Sat-flow routing** — `ordinalRoutedOutput()` / `assertOrdinalRouting()`.
   FIFO sat theory says the inscription must land in the buyer's output. The guard
   throws otherwise (incl. "burned to fee"). Verify the math and that it wraps
   EVERY build path.
2. **`buildAtomicSwap()`** — dummy-padded layout: in `[buyer dummy, seller
   inscription, buyer payment]`, out `[inscription→buyer, payment→seller, change]`.
   Full tx assembled unsigned so indices are fixed pre-signing. Confirm sat
   preservation for real inscriptions and non-zero offsets.
3. **Signature verification** — EVM eip191 (ethers), BTC bip137 (bitcoinjs-message),
   taproot BIP-322 = not implemented (sessions created but flagged unverified).
4. **Fee / value conservation** — confirm `fee_actual == estimate`; the earlier
   inscription-value double-count is fixed (see SECURITY-AUDIT #2).
5. **Mainnet gate** — `resolveNetwork()` throws unless `ASSET_LOOP_NETWORK=mainnet`
   AND `ASSET_LOOP_ALLOW_MAINNET=I_UNDERSTAND`. Confirm no other path enables it.

## Open items you must sign off (from SECURITY-AUDIT.md)
- #1 sat routing — ADDRESSED in code; **needs on-chain proof with a real signet
  inscription** (see RUNBOOK-SIGNET.md) and your review.
- #3 dust floors, #4 taproot BIP-322, #5 indexer trust, #6 SQL interpolation,
  #7 nonce/session hygiene.
- Legacy pre-signed "listing" offer (`buildSellerOffer`) is index-fragile —
  recommendation is to replace with an audited swap library.

## Reproduce the on-chain proof (1 command)
```bash
bash tools/regtest-reproduce.sh   # see tools/README.md
```
Stands up a local Bitcoin Core v28 regtest + `ord` v0.22.2, inscribes a REAL
inscription, sells it via the production `buildAtomicSwap()`, and verifies with
`ord` that the buyer now owns it. Ends in `RESULT: ALL PASS ✅`. No faucet, no
mainnet. A recorded run is in `PROOF-REGTEST.md`.

## Code pointers (review these — `settlement.js`)
- `resolveNetwork()` — L28. Network + **mainnet hard-block** gate.
- `ordinalRoutedOutput()` — L70. FIFO sat-flow: which output the inscription lands in (−1 = burned).
- `assertOrdinalRouting()` — L83. Guard; throws unless the inscription lands in the intended buyer output. **Wraps every build path.**
- `buildAtomicSwap()` — L159. The routing-correct dummy-padded swap (guard at L182). **Primary target.**
- `buildBuyerCompletion()` — L105. Legacy path; now guarded (L145) so it refuses the mis-routing layout.
- `buildSellerOffer()` — L91. Legacy pre-signed listing offer (index-fragile; recommend replacing with an audited lib).
- `finalizeAndBroadcast()` — L199.

Server (`server.js`): `verifySignature()` L513, `resolveParticipant()` L539,
`/api/auth/*` L555–L607, `/api/settlement/*` L644–L779, `/api/bid` L805.

## Companion docs
- `SECURITY-AUDIT.md` — full findings list + go-live checklist.
- `PROOF-REGTEST.md` — recorded end-to-end real-inscription proof.
- `RUNBOOK-SIGNET.md` — signet dry-run procedure (public-network variant).
- `tools/README.md` — how to run the reproducible proof.

## Definition of "cleared for mainnet" (ALL required)
1. Signet dry-run with a **real inscription** passes all acceptance criteria,
   evidenced by an on-chain txid.
2. Findings #1–#7 resolved or accepted with written rationale.
3. Independent auditor sign-off on `settlement.js`.
4. Legal/compliance review of operating the marketplace.
5. Human sets `ASSET_LOOP_NETWORK=mainnet` + `ASSET_LOOP_ALLOW_MAINNET=I_UNDERSTAND`.

Until 1–4 are done, item 5 must not be set.
