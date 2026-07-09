# Asset Loop — Signet Dry-Run Runbook (real inscription swap)

**Purpose:** prove, on Bitcoin **signet**, that the routing-verified atomic swap
(`buildAtomicSwap` + `assertOrdinalRouting`) actually delivers a **real
inscription** to the buyer's output and pays the seller — end to end, on-chain.
This is the last gate before an independent audit and any mainnet discussion.

**Nothing here touches mainnet.** Signet coins are worthless test coins.

---

## Acceptance criteria (all must be TRUE to pass)
1. After broadcast + 1 confirmation, the inscription is controlled by the
   **buyer** address (verify with `ord`).
2. The inscribed sat sits in **output[0]** of the swap tx (the buyer output).
3. The **seller** address received exactly `price_sats`.
4. Fee is sane (≈ `feeRate × vsize`), not inflated by the inscription value.
5. The transaction is a **single** atomic tx (asset + payment together).

If ANY fail → STOP. Do not proceed toward mainnet; hand the txid + PSBT to the
auditor.

---

## 0. Prerequisites
- `bitcoind` (Bitcoin Core) and `ord` (ordinals) installed.
- `bitcoin.conf`:
  ```
  signet=1
  txindex=1
  server=1
  ```
- Start: `bitcoind -signet -daemon`
- Two wallets so buyer ≠ seller. Simplest: two `ord` wallets, or one `ord`
  (seller) + one Core wallet (buyer).

## 1. Fund the seller
```
ord --signet wallet create
ord --signet wallet receive          # -> seller address
```
Send signet coins from a faucet (https://signetfaucet.com,
https://alt.signetfaucet.com). Wait 1 confirmation.

## 2. Inscribe a test inscription (seller)
```
echo "asset-loop signet test $(date -u +%s)" > test.txt
ord --signet wallet inscribe --fee-rate 1 --file test.txt
```
Note the returned **inscription id** and **reveal txid**. Wait 1 confirmation.

## 3. Locate the inscription UTXO + confirm offset 0
```
ord --signet wallet inscriptions      # shows inscription -> satpoint txid:vout:offset
```
- Record `INSCRIPTION_UTXO = <txid>:<vout>` and its **value** (sats).
- **Confirm offset == 0.** The current builder assumes the inscription is the
  first sat of its UTXO. If offset ≠ 0, do NOT run this build — that is an
  explicit audit item.

## 4. Prepare the buyer (dummy + payment UTXOs)
The buyer needs:
- one small **dummy** UTXO (~1000 sats), and
- enough **payment** UTXOs to cover `price + fee`.
Create a dummy by sending yourself a small amount, then list UTXOs:
```
bitcoin-cli -signet -rpcwallet=buyer listunspent
```
Record `BUYER_DUMMY = txid:vout` (~1000 sats) and the payment UTXO(s).

## 5. Assemble the routing-verified swap (Asset Loop builder)
Get a wallet session: open the app, **Connect wallet** (buyer, signet), then in
the browser console copy `localStorage.al_session`.
```
SESSION=<al_session value>
BASE=https://build-63e0680f0f405dd3ab519785.emblem.build/pub/main/asset-loop

curl -s -X POST "$BASE/api/settlement/build-swap" \
  -H "Content-Type: application/json" -H "x-session: $SESSION" \
  -d '{
    "inscription_utxo": { "txid":"<INS_TXID>", "vout":<N>, "value":<INS_VALUE>, "address":"<SELLER_ADDR>" },
    "buyer_dummy":      { "txid":"<DUMMY_TXID>", "vout":<N>, "value":<DUMMY_VALUE> },
    "buyer_payment":    [ { "txid":"<PAY_TXID>", "vout":<N>, "value":<PAY_VALUE> } ],
    "price_sats": 50000,
    "seller_payout": "<SELLER_ADDR>",
    "buyer_address": "<BUYER_ADDR>"
  }'
```
The response MUST include `"routing":{"inscriptionOutput":0,"verified":true}` and a
`signing` map. If the server returns a `SAT-FLOW:` error, the build was refused —
that is the guard working; recheck your values. Save `psbt` (base64).

## 6. Sign (both parties)
**Route A — bitcoin-cli (recommended, reproducible):**
```
# Seller signs their input(s):
S1=$(bitcoin-cli -signet -rpcwallet=seller walletprocesspsbt "<PSBT>" | jq -r .psbt)
# Buyer signs their input(s):
S2=$(bitcoin-cli -signet -rpcwallet=buyer  walletprocesspsbt "$S1" | jq -r .psbt)
# Combine + finalize:
FINAL=$(bitcoin-cli -signet finalizepsbt "$S2" | jq -r .hex)
```
**Route B — browser wallets:** paste the PSBT into the wallet, sign the indices in
the `signing` map (seller signs `sellerInputIndex`, buyer signs `buyerInputIndexes`).

## 7. Broadcast
```
bitcoin-cli -signet sendrawtransaction "$FINAL"
# or via the app:
curl -s -X POST "$BASE/api/settlement/broadcast" \
  -H "Content-Type: application/json" -d "{\"signed_psbt\":\"<FULLY_SIGNED_PSBT_B64>\"}"
```
Record the `TXID`.

## 8. Verify on-chain (the actual test)
Wait 1 confirmation, then:
```
ord --signet wallet inscriptions        # run from the BUYER wallet -> inscription now listed here
ord --signet inscription <INSCRIPTION_ID>   # location should be <TXID>:0:0  (output 0)
```
- Confirm the inscription's new location is **`<TXID>:0`** (output index 0, buyer).
- Confirm on any signet explorer that output[1] paid `price_sats` to the seller.
- Confirm the buyer's change returned to the buyer.

Tick the acceptance criteria at the top. All green → the routing fix is proven on
a real inscription. Then, and only then, move to the independent audit
(`SECURITY-AUDIT.md`) before any mainnet conversation.

---

*Signet-only. This runbook validates the Asset Loop builder against a real
inscription; it is not itself a security audit.*
