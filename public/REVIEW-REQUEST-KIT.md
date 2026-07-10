# Asset Loop — Review Request Kit (copy-paste ready)

Everything you need to (1) publish the repo and (2) ask real Bitcoin experts to
review it. Post these as **yourself** — authentic engagement gets real answers.

---

## Step 1 — Publish the repo (2 commands)
Download the git-ready bundle, then push to your own GitHub:
```bash
curl -O https://build-63e0680f0f405dd3ab519785.emblem.build/pub/main/asset-loop/asset-loop-repo.tar.gz
tar xzf asset-loop-repo.tar.gz && cd asset-loop-oss

# with the GitHub CLI:
gh repo create asset-loop --public --source=. --push
# or manually (create an empty repo on github.com first):
git remote add origin https://github.com/<you>/asset-loop.git
git branch -M main && git push -u origin main
```
✅ Already done — your repo is live at https://github.com/Marvintymo/asset-loop and the posts below are pre-filled with it.

---

## Step 2A — Bitcoin StackExchange (ONE narrow, on-topic PSBT question)
Per moderator feedback (Murch): SE wants *one focused question*, and Ordinals-
mechanics questions are often *off-topic* there. So ask a single, general-Bitcoin
PSBT/taproot question (not Ordinals-specific) — the taproot-signing one below is a
perfect fit and is our real open item. Take the Ordinals-specific questions to the
venues in 2C/2D instead.

*Post at* bitcoin.stackexchange.com · *tags:* `psbt` `taproot` `wallet` `transactions`

> **Title:** What PSBT fields must a P2TR key-path input carry to be reliably signed by external wallets?
>
> I build a PSBT that mixes a **P2TR key-path** input (owned by an external browser
> wallet — UniSat/OKX/Xverse) with **P2WPKH** inputs, then hand the PSBT to the
> wallet to sign. With only `witnessUtxo` set on the taproot input, some wallets
> refuse it or silently skip signing it.
>
> What must the taproot input contain for these wallets to reliably produce a
> **finalizable key-path signature**? Specifically:
> - Is an explicit `sighashType` required, and does `SIGHASH_ALL` (0x01) vs
>   `SIGHASH_DEFAULT` (0x00) matter for wallet compatibility?
> - Is `tapInternalKey` (x-only) needed, and/or `tapBip32Derivation`?
> - Any case where `nonWitnessUtxo` is expected for P2TR (e.g. hardware wallets)?
>
> (Standalone PSBT question — not asking about any specific application.)

## Step 2B — GitHub issue (on your own repo, to anchor reviews)
> **Title:** Review request: Ordinals atomic-swap PSBT construction (settlement.js)
>
> Seeking independent review before any mainnet consideration. Scope, threat model,
> and reproducible proof are in `/public/AUDIT-HANDOFF.md` and
> `/public/SECURITY-AUDIT.md`. Run `bash tools/regtest-reproduce.sh` to reproduce
> the on-chain proof. Findings + open items in `/public/PRE-AUDIT.md`. Please
> comment inline on `settlement.js`. Questions listed in `/public/COMMUNITY-REVIEW.md`.

## Step 2C — delvingbitcoin.org (deeper design critique)
> **Title:** Design review: dummy-padded Ordinals atomic swap for a re-listing marketplace
>
> [Same summary as 2A, plus:] I'd especially value critique of the trust model
> (single indexer, confirmation depth) and whether the whole-UTXO transfer is the
> right primitive for a marketplace that re-lists continuously. Repo: `https://github.com/Marvintymo/asset-loop`

## Step 2D — Ordinals / OpenOrdex dev community (Discord/GitHub)
> Hi — I've built an Ordinals swap marketplace and want eyes on the PSBT
> construction before mainnet (it's signet/regtest-only, mainnet code-locked). It's
> close to the OpenOrdex pattern but assembles the full tx and co-signs rather than
> using a pre-signed listing. Would love a sanity check from people who live in this
> code. Repo + reproducible proof: `https://github.com/Marvintymo/asset-loop`

## Step 2E — Direct outreach to a paid auditor (for real money)
> Subject: Security review — Bitcoin Ordinals atomic-swap PSBT engine (~260 LOC)
>
> We're preparing a mainnet Ordinals swap marketplace and want an independent
> review of the settlement engine before enabling real funds. Scope is small
> (`settlement.js`, ~260 lines) + a threat model and reproducible regtest proof.
> Repo: `https://github.com/Marvintymo/asset-loop`. Could you scope a review + quote? Happy to pin to a commit.

---

## What "good" looks like (so you can judge replies)
- A reviewer who **traces the sat-flow / tests a PSBT** and explains *why* — not "lgtm".
- Ideally **2+ independent** reviewers, or one paid auditor with a written report.
- They engage the open items in `PRE-AUDIT.md`.

Bring the responses back and I'll help you judge whether they're substantive — and,
once the bar in `MAINNET-READINESS.md` is met, help open the two gates properly.
