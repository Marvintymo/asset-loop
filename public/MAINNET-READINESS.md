# Asset Loop — Mainnet Go-Live Acceptance Checklist

Enabling mainnet is a **human decision** made by setting `ASSET_LOOP_NETWORK=mainnet`
+ `ASSET_LOOP_ALLOW_MAINNET=I_UNDERSTAND`. This is the bar that should be met first.
It moves *irreversible* value — treat every box as mandatory.

## A. Independent review evidence (what actually counts)
"Independent" = **not the author (me), not you, not anyone paid to rubber-stamp.**

Provide ONE of:
- [ ] **A written audit report** from a recognized Bitcoin / PSBT security reviewer
      or firm, that: states scope + methodology, lists findings (or "no criticals"),
      names the reviewer, and is **tied to a specific git commit hash** of
      `settlement.js`. A report against a commit you can show me is the gold standard.
- [ ] **A substantive public review** by a named expert with a track record —
      e.g. a detailed Bitcoin StackExchange answer, a GitHub PR review with
      line-level comments, or a delvingbitcoin thread — that engages with the swap
      logic. **Not** "lgtm", not silence, not an anonymous one-liner.

Stronger is better:
- [ ] **Two or more independent reviewers** converging (much stronger than one).
- [ ] The reviewer explicitly OK'd (or you resolved) the open items in `PRE-AUDIT.md`.

What I will do with it: read it and tell you honestly whether it's *substantive and
covers the fund-critical paths* — or whether it's thin. I **cannot** authenticate
that a report/reviewer is genuine; that authenticity (and the liability) is yours.

## B. Open technical items closed (from PRE-AUDIT.md)
- [ ] **Third-party taproot wallet finalize** proven on **signet** with each wallet
      you'll support (Unisat / OKX / Xverse) — a real inscription swap, signed in
      that wallet, that finalizes + confirms. (This one genuinely needs real wallets.)
- [ ] **Transitive `elliptic` low-sev** resolved upstream in `bip322-js` or pinned
      via a vetted `overrides`, or explicitly accepted in writing by the auditor.
- [ ] A **real-inscription mainnet dry-run in `design` mode** (build the PSBT, inspect
      it, do NOT broadcast) reviewed against the auditor's expectations.

## C. Operational gates (not code — but required)
- [ ] **Value caps** — cap `priceSats` / per-swap value low at first (e.g. a few
      hundred $ equivalent), raise slowly.
- [ ] **Monitoring + alerting** on every settlement (txid, value, parties).
- [ ] **Fee/stuck-tx plan** — RBF/CPFP guidance, since the platform holds no keys.
- [ ] **Incident + rollback plan** — how you pause (`ASSET_LOOP_ALLOW_MAINNET` off)
      and communicate if something goes wrong.
- [ ] **Legal / compliance review** — running a value-moving marketplace can carry
      money-transmission / KYC / sanctions obligations depending on jurisdiction.
      This is **outside my lane** — get a lawyer. Do not skip it.

## D. The switch (only after A–C) — now TWO independent gates
Mainnet is deliberately gated **twice** so a single stray env var can never arm
real-money settlement:
- [ ] **Code gate:** `MAINNET_CODE_UNLOCK` in `settlement.js` is set to `true` — a
      deliberate code change made only after the audit (A) passes.
- [ ] **Env gate:** you (a human) set `ASSET_LOOP_NETWORK=mainnet` +
      `ASSET_LOOP_ALLOW_MAINNET=I_UNDERSTAND` in the dashboard.
- [ ] Start with the caps from (C), watch the first real settlements closely.

> Until BOTH gates are open, the settlement engine refuses mainnet and no swap can
> be built or broadcast — even if the env vars are set. This is intentional.

---

**My role:** help you assess evidence for substance, wire the staged rollout, and
refuse to call it "safe" on author-side work alone. **Your role:** authenticate the
review, own the legal/business decision, and flip the switch. I won't stand in the
way once A–C are genuinely met — but I also won't be the one who says "it's safe,
go," because that call, with real money, isn't mine to make.
