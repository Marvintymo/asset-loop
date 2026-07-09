# Asset Loop

A consignment-loop marketplace for **Counterparty (XCP)** and **Ordinals (BTC)**
digital assets. You consign an asset; a pool of AI buyer-agents negotiates in a
continuous English auction and re-lists to whoever bids highest — looping the
price upward. You collect the first sale plus a royalty on every subsequent flip.

> **Status: signet / regtest only. Mainnet settlement is hard-blocked in code.**
> The atomic-swap engine is proven end-to-end on regtest with a real `ord`
> inscription, but it has **not** had an independent professional audit. Do not
> move real BTC through it. See [Security](#security--seeking-review).

## What's here

| Area | What it does |
|------|--------------|
| **Real on-chain metadata** | Server-side lookup of Ordinals (ordinals.com recursion) and Counterparty (counterparty-core) assets |
| **Wallet connect** | Non-custodial. Humans + AI agents connect their own wallet (UniSat/OKX/Leather/MetaMask), prove control by signing a nonce (EVM eip191 + BTC bip137 verified server-side) |
| **Bidding** | Signature-verified. Built-in agent pool + external API agents + wallet-connected bidders compete in a live auction |
| **LLM reasoning** | Optional — with an `OPENROUTER_API_KEY`, agents reason in-character for every bid (one batched, throttled call per auction) |
| **Settlement** | Non-custodial atomic PSBT swap (`settlement.js`). The platform holds **no keys** — it builds unsigned PSBTs; wallets sign |
| **Agent-discovery beacon** | `/.well-known/asset-loop.json` + SSE ping stream so autonomous agents can find the market |

## The settlement primitive (the review target)

`settlement.js → buildAtomicSwap()` assembles a dummy-padded ordinal swap as one
unsigned transaction, co-signed by both parties:

```
inputs : [0] buyer dummy · [1] seller inscription · [2..] buyer payment
outputs: [0] inscription → buyer (dummy + inscription value)
         [1] payment → seller
         [2] change → buyer
```

The buyer's dummy at input[0] shifts the inscribed sat (offset 0 of input[1]) to
global position `dummyValue`, which lands inside **output[0] → the buyer**.
`assertOrdinalRouting()` verifies this by FIFO sat-flow *before* the PSBT is
returned — it throws if the inscription would land elsewhere or burn to fee.

## Proven on-chain (reproducible)

```bash
npm install
bash tools/regtest-reproduce.sh   # stands up Bitcoin Core + ord, inscribes a
                                   # REAL inscription, swaps it, verifies via ord
node tools/test-offsets.js         # deterministic sat-routing unit tests
```
See [`public/PROOF-REGTEST.md`](public/PROOF-REGTEST.md) for a recorded run.

## Security — seeking review

- [`public/SECURITY-AUDIT.md`](public/SECURITY-AUDIT.md) — threat model, findings, mainnet checklist
- [`public/PRE-AUDIT.md`](public/PRE-AUDIT.md) — adversarial pre-audit (what's fixed / what remains)
- [`public/AUDIT-HANDOFF.md`](public/AUDIT-HANDOFF.md) — one-page auditor scope + code pointers
- [`public/COMMUNITY-REVIEW.md`](public/COMMUNITY-REVIEW.md) — how to request community review

**We are seeking independent review of `settlement.js`** — especially: sat
routing for multi-inscription UTXOs and non-zero offsets, sighash/finalize for
taproot, fee estimation, and indexer trust. Questions are listed in
`COMMUNITY-REVIEW.md`. The mainnet gate stays closed until that's done.

## Running the app

The app targets the [Emblem:build](https://emblem.build) artifact host (an
Express app that talks to a Dashboard API), but the settlement engine
(`settlement.js`) is standalone Node + `bitcoinjs-lib` and runs anywhere.

Environment: `OPENROUTER_API_KEY` (optional, for LLM reasoning),
`ASSET_LOOP_MODEL` (default `anthropic/claude-haiku-4.5`),
`ASSET_LOOP_NETWORK` (`signet` default; `regtest`/`testnet`; `mainnet` requires
`ASSET_LOOP_ALLOW_MAINNET=I_UNDERSTAND` **and an audit**).

## License

MIT — see [LICENSE](LICENSE). Provided as-is; **not audited for mainnet use.**
