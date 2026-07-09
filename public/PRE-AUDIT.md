# Asset Loop — Pre-Audit Findings & Hardening

A free, adversarial *pre-audit* (three independent reviewers each attacking a
different surface — PSBT/sat correctness, economics/DoS/indexer, web/auth — plus
`npm audit`). **This is NOT a substitute for an independent professional audit**;
it is a hardening pass to fix what's clearly fixable before external review.
Mainnet stays hard-blocked regardless.

## Fixed in this pass

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | CRITICAL | Legacy bare `SIGHASH_SINGLE\|ANYONECANPAY` offer (`buildSellerOffer`/`buildBuyerCompletion`) can be completed so the inscription routes back to the seller — buyer pays, gets nothing | `/api/settlement/offer` + `/complete` **disabled (410)**; all swaps forced through the routing-verified `build-swap` |
| 2 | CRITICAL | Sessions stored `verified` but nothing ever checked it — an unverifiable (e.g. taproot) signature still minted a usable session | Fund-moving endpoints (`build-swap`, `broadcast`) now require `session.verified === true`; mutating an existing wallet-agent requires a verified sig |
| 3 | CRITICAL | Caller-supplied UTXO `value` trusted verbatim (forged values corrupt fee/routing math) | `verifiedInput()` fetches the **real on-chain value** for every input; caller value ignored |
| 4 | HIGH | `/api/settlement/broadcast` was unauthenticated → open broadcast relay | Requires a verified session; rate-limited per-session (not spoofable IP) |
| 5 | HIGH | No dust / integer / price validation → non-standard or negative outputs | `isSats()` + 546-sat dust floors in the endpoint AND inside `buildAtomicSwap` |
| 6 | HIGH | Fee model under-counted taproot/mixed vbytes → tx could stick unconfirmed | Conservative estimate (68 vB/in, 43 vB/out, +11 overhead, ×1.1 margin) — overpay is safe, underpay isn't |
| 7 | MED | Unbounded growth: agents, SSE connections, rate-limit map, `buyer_payment[]` | Caps (agents ≤500, SSE ≤500, `buyer_payment` ≤20) + periodic rate-limit sweep |
| 8 | MED | SSRF/path-traversal via wallet address in indexer URL | `encodeURIComponent()` + only verified addresses reach it |
| 9 | LOW | Unauthenticated asset controls (pause/step/withdraw) griefing / LLM-spend | Rate-limited; LLM enrichment also globally throttled (1 / 4s) |

## Verified NON-issues
- **SQL injection: none.** `sqlVal()` doubles single-quotes; SQLite honors no backslash escapes, so string literals can't break out. Every user string traced.
- **Secret exposure: none.** `OPENROUTER_API_KEY` / `DASHBOARD_TOKEN` never leave the server; agent `api_key` returned only to its creator; `/api/state`, `/market`, beacon all omit it.
- **LLM prompt-injection XSS: mitigated.** Frontend renders `log[].text` via `esc()` (HTML-escaped); no secrets in the prompt; malformed JSON is caught.

## Remaining — for the independent/community audit (NOT fully fixed)
- **[HIGH] Multi-inscription UTXO sweep** — `buildAtomicSwap` moves the whole seller UTXO to the buyer. If that UTXO carries >1 inscription, extras transfer for the price of one. Needs an ord-indexer check to assert exactly one inscription (and to exclude inscription-bearing UTXOs from buyer payment/dummy selection). Requires ord integration in the live path.
- **[HIGH] Indexer trust** — values are now cross-checked against chain, but there is still a single indexer, no confirmation-depth requirement, and no double-spend/mempool re-check before broadcast. A real deployment needs multi-source confirmation + N-conf.
- **[MED] Money as float** — auction prices flow through `round2()` (BTC floats) before `btcToSats`. Carry integer sats end-to-end to guarantee the settled `priceSats` equals the quoted price to the sat.
- **[MED] Consignment `verified` + `image_url` are self-asserted** (`/api/consign`) — a caller can flag an asset `verified:true` with an arbitrary image. Set `verified` only from a server-side `/api/lookup`; https-only image/source URLs.
- **[MED] Ownership model** — assets aren't bound to a consignor identity, so pause/withdraw are open (now rate-limited, but any user can withdraw any loop). Add consignor session binding.
- **[LOW] Taproot key-path finalize** — inputs are added `witnessUtxo`-only. The real-inscription regtest proof finalized fine because the **ord wallet supplied the taproot signing fields**; confirm behavior for arbitrary external taproot signers and populate `tapInternalKey`/sighash explicitly.
- **[LOW] Rate-limit `x-forwarded-for`** on `/api/agents/register` is spoofable; behind the dashboard proxy set `trust proxy` and derive the real client IP.
- **[LOW] `npm audit`: 3 low-severity** — `elliptic` risky-primitive advisory via `bitcoinjs-message → secp256k1`. Fix is a breaking dep bump; low impact for message-signature verification, but update before mainnet.
- **Real BIP-322 taproot verification** is not implemented (taproot sessions are `verified:false` and now correctly cannot settle). Add `bip322-js` so taproot users can be verified and settle.

## Automated tooling
- `npm audit --omit=dev`: 3 low (elliptic). `semgrep`: not installable in this sandbox (PEP-668); recommend running `semgrep --config auto` in CI.

**Bottom line:** the clear fund-safety bugs are fixed and the swap path is materially hardened, but the multi-inscription guard, indexer quorum, integer-money refactor, and real BIP-322 are genuine audit-level items. Keep mainnet closed until an independent Bitcoin-security reviewer signs off.
