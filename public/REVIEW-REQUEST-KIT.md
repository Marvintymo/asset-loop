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
Then replace `https://github.com/Marvintymo/asset-loop` below with your new repo link.

---

## Step 2A — Bitcoin StackExchange (best for precise answers)
*Post at* bitcoin.stackexchange.com · *tags:* `psbt` `taproot` `ordinals` `transactions`

> **Title:** Is this dummy-padded Ordinals atomic-swap PSBT construction correct and safe?
>
> I've built an Ordinals atomic-swap marketplace. The core (`settlement.js`,
> ~260 lines) assembles a single unsigned transaction, co-signed by both parties:
> inputs `[buyer dummy, seller inscription, buyer payment]`; outputs
> `[inscription→buyer (dummy+inscription value), payment→seller, change]`. A
> sat-flow verifier asserts the inscribed sat lands in the buyer output before
> signing. It's proven end-to-end on regtest with a real `ord` inscription; it
> runs on signet/regtest only and mainnet is code-locked. Repo: `https://github.com/Marvintymo/asset-loop`
>
> Specific questions:
> 1. Is the dummy-padded sat routing correct for non-zero inscription offsets and
>    multi-inscription UTXOs?
> 2. I sign the fully-assembled tx with SIGHASH_ALL (no pre-signed listing). Is the
>    seller fully protected vs. the OpenOrdex SINGLE|ANYONECANPAY model?
> 3. For taproot inputs added `witnessUtxo`-only, what tap fields must be present
>    for arbitrary external wallets (Unisat/OKX/Xverse) to finalize reliably?
> 4. Is my fee model (68 vB/in, 43 vB/out, +11, ×1.1) safe across input types?
> 5. Best practice for confirmation depth + double-spend checks before broadcast?

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
