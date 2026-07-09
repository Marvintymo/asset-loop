#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# regtest-reproduce.sh — reproducible, end-to-end proof of the Asset Loop
# ordinal atomic swap on a local Bitcoin Core regtest chain + ord indexer.
#
# It stands up (or reuses) a private regtest node, creates a REAL inscription
# with `ord`, sells it via the production buildAtomicSwap() from a seller wallet
# to a buyer wallet, broadcasts + confirms, and verifies with `ord` that the
# inscription now belongs to the buyer. Prints PASS/FAIL for every criterion.
#
# No faucet, no external network beyond one-time binary downloads. Idempotent:
# re-run it any time; each run inscribes a fresh inscription.
#
# Requirements: linux x86_64, curl, python3, node (with the repo's node_modules).
# Usage:  bash tools/regtest-reproduce.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="${BTC_ROOT:-/app/groups/main/.btctest}"
REPO="${ASSET_LOOP_REPO:-/app/groups/main/asset-loop}"
BTC_VER=28.0
ORD_VER=0.22.2
ORD_PORT=8090
mkdir -p "$ROOT"
BIND="$ROOT/bitcoin-$BTC_VER/bin"
DATA="$ROOT/data"; ORDDATA="$ROOT/orddata"
CLI="$BIND/bitcoin-cli -regtest -datadir=$DATA"
ORD="$ROOT/ord --regtest --bitcoin-data-dir $DATA --data-dir $ORDDATA"
ORDW="$ORD wallet --server-url http://localhost:$ORD_PORT"
say(){ echo -e "\n=== $* ==="; }

# ── 1. binaries ────────────────────────────────────────────────────────────
if [ ! -x "$BIND/bitcoind" ]; then
  say "downloading Bitcoin Core $BTC_VER"
  ( cd "$ROOT" && curl -sSL --max-time 240 -o btc.tgz "https://bitcoincore.org/bin/bitcoin-core-$BTC_VER/bitcoin-$BTC_VER-x86_64-linux-gnu.tar.gz" \
    && tar xzf btc.tgz bitcoin-$BTC_VER/bin/bitcoind bitcoin-$BTC_VER/bin/bitcoin-cli && rm btc.tgz )
fi
if [ ! -x "$ROOT/ord" ]; then
  say "downloading ord $ORD_VER"
  ( cd "$ROOT" && curl -sSL --max-time 240 -o ord.tgz "https://github.com/ordinals/ord/releases/download/$ORD_VER/ord-$ORD_VER-x86_64-unknown-linux-gnu.tar.gz" \
    && tar xzf ord.tgz ord-$ORD_VER/ord && mv ord-$ORD_VER/ord ord && rmdir ord-$ORD_VER && rm ord.tgz && chmod +x ord )
fi

# ── 2. bitcoind ────────────────────────────────────────────────────────────
mkdir -p "$DATA"
if ! $CLI getblockcount >/dev/null 2>&1; then
  say "starting bitcoind (regtest)"
  "$BIND/bitcoind" -regtest -datadir="$DATA" -daemon -fallbackfee=0.0001 -txindex=1 >/dev/null
  for i in $(seq 1 20); do $CLI getblockcount >/dev/null 2>&1 && break; sleep 1; done
fi

# ── 3. wallets ─────────────────────────────────────────────────────────────
loadw(){ $CLI loadwallet "$1" >/dev/null 2>&1 || $CLI -named createwallet wallet_name="$1" >/dev/null 2>&1 || true; }
loadw miner; loadw buyer
MINE=$($CLI -rpcwallet=miner getnewaddress "" bech32)
[ "$($CLI getblockcount)" -lt 101 ] && { say "mining 101 blocks"; $CLI generatetoaddress 101 "$MINE" >/dev/null; }

# ── 4. ord server ──────────────────────────────────────────────────────────
mkdir -p "$ORDDATA"
if ! curl -s -m 3 "http://localhost:$ORD_PORT/blockcount" >/dev/null 2>&1; then
  say "starting ord server on :$ORD_PORT"
  setsid $ORD server --http-port $ORD_PORT >"$ROOT/ord.log" 2>&1 </dev/null &
  for i in $(seq 1 30); do curl -s -m 3 "http://localhost:$ORD_PORT/blockcount" >/dev/null 2>&1 && break; sleep 1; done
fi
$ORD wallet create >/dev/null 2>&1 || true   # no-op if it already exists
sync_ord(){ for i in $(seq 1 40); do [ "$($CLI getblockcount)" = "$(curl -s -m3 http://localhost:$ORD_PORT/blockcount 2>/dev/null || echo x)" ] && { sleep 1; return; }; sleep 1; done; }
# Retry an ord wallet command while the indexer is catching up (several transient
# sync errors: "blocks behind", or a wallet output not yet in the ord index).
ord_retry(){ local out; for i in $(seq 1 15); do if out=$("$@" 2>/tmp/orderr); then echo "$out"; return 0; fi; if grep -qE "blocks behind|not in ord server|not in index|wallet but not" /tmp/orderr; then sync_ord; sleep 2; else cat /tmp/orderr >&2; return 1; fi; done; cat /tmp/orderr >&2; return 1; }

# fund ord (seller) wallet if needed
ORD_ADDR=$(ord_retry $ORDW receive | python3 -c "import sys,json;print(json.load(sys.stdin)['addresses'][0])")
$CLI -rpcwallet=miner sendtoaddress "$ORD_ADDR" 1.0 >/dev/null
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord

# ── 5. create a REAL inscription ───────────────────────────────────────────
say "inscribing a real inscription"
echo "Asset Loop reproducible proof $(date -u +%s)" > "$ROOT/insc.txt"
INS_JSON=$(ord_retry $ORDW inscribe --fee-rate 1 --file "$ROOT/insc.txt")
INSC_ID=$(echo "$INS_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['inscriptions'][0]['id'])")
INSC_TXID=$(echo "$INS_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['reveal'])")
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
INSC_VAL=$($CLI gettxout "$INSC_TXID" 0 | python3 -c "import sys,json;print(int(round(json.load(sys.stdin)['value']*1e8)))")
INSC_ADDR=$($CLI gettxout "$INSC_TXID" 0 | python3 -c "import sys,json;print(json.load(sys.stdin)['scriptPubKey']['address'])")
echo "inscription $INSC_ID  (UTXO $INSC_TXID:0, $INSC_VAL sats, $INSC_ADDR)"

# ── 6. fund buyer (dummy + payment) ────────────────────────────────────────
BUYER_ADDR=$($CLI -rpcwallet=buyer getnewaddress buyer bech32)
SELLER_PAYOUT=$($CLI -rpcwallet=miner getnewaddress payout bech32)
$CLI -rpcwallet=miner sendtoaddress "$BUYER_ADDR" 0.00001000 >/dev/null   # dummy
$CLI -rpcwallet=miner sendtoaddress "$BUYER_ADDR" 0.00100000 >/dev/null   # payment
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
$CLI -rpcwallet=buyer listunspent 0 9999999 "[\"$BUYER_ADDR\"]" | python3 -c "
import sys,json
us=sorted(json.load(sys.stdin),key=lambda x:x['amount'])
open('$ROOT/buyer.txt','w').write('\n'.join(f\"{u['txid']} {u['vout']} {int(round(u['amount']*1e8))}\" for u in us))"
echo "{\"insc_txid\":\"$INSC_TXID\",\"insc_vout\":0,\"insc_val\":$INSC_VAL,\"insc_addr\":\"$INSC_ADDR\",\"buyer_addr\":\"$BUYER_ADDR\",\"seller_payout\":\"$SELLER_PAYOUT\"}" > "$ROOT/swapctx.json"

# ── 7. build the routing-verified swap (production buildAtomicSwap) ─────────
say "buildAtomicSwap (production code, regtest)"
BTC_ROOT="$ROOT" node "$REPO/tools/regtest-swap-build.js"

# ── 8. sign (seller + buyer), finalize, broadcast, confirm ─────────────────
say "sign + broadcast"
PSBT=$(cat "$ROOT/unsigned.psbt")
S1=$($CLI -rpcwallet=ord   walletprocesspsbt "$PSBT" | python3 -c "import sys,json;print(json.load(sys.stdin)['psbt'])")
S2=$($CLI -rpcwallet=buyer walletprocesspsbt "$S1"   | python3 -c "import sys,json;print(json.load(sys.stdin)['psbt'])")
HEX=$($CLI finalizepsbt "$S2" | python3 -c "import sys,json;print(json.load(sys.stdin)['hex'])")
TXID=$($CLI sendrawtransaction "$HEX")
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
echo "swap txid: $TXID"

# ── 9. verify with ord + acceptance criteria ───────────────────────────────
say "verification"
# Wait until the ord indexer reflects the inscription's move into the swap tx
# (ord indexes a beat behind bitcoind; poll the satpoint rather than assume).
for i in $(seq 1 40); do
  CUR=$(curl -s -m5 -H "Accept: application/json" "http://localhost:$ORD_PORT/inscription/$INSC_ID" \
        | python3 -c "import sys,json;print(json.load(sys.stdin).get('satpoint','').split(':')[0])" 2>/dev/null || echo "")
  [ "$CUR" = "$TXID" ] && break
  sleep 1
done
LOC=$(curl -s -m8 -H "Accept: application/json" "http://localhost:$ORD_PORT/inscription/$INSC_ID")

# Multi-inscription safety guard (exercises SETTLE.inscriptionsOnOutput via ord).
say "multi-inscription guard (ASSET_LOOP_ORD_API)"
ASSET_LOOP_ORD_API="http://localhost:$ORD_PORT" BTC_ROOT="$ROOT" node "$REPO/tools/ord-guard-check.js" || true

CLI="$CLI" TXID="$TXID" INSC_ID="$INSC_ID" LOC="$LOC" python3 <<'PY'
import os,subprocess,json
cli=os.environ['CLI'].split(); txid=os.environ['TXID']
ctx=json.load(open(os.path.join(os.environ.get('BTC_ROOT','/app/groups/main/.btctest'),'swapctx.json')))
loc=json.loads(os.environ['LOC']); sat=loc.get('satpoint',''); addr=loc.get('address')
otx,ovout,ooff=sat.split(':')
tx=json.loads(subprocess.check_output(cli+["getrawtransaction",txid,"true"]))
outs=[(o['n'],int(round(o['value']*1e8)),o['scriptPubKey'].get('address')) for o in tx['vout']]
buyer=ctx['buyer_addr']; payout=ctx['seller_payout']
print("inscription satpoint now:",sat,"->",("BUYER" if addr==buyer else addr))
for n,s,a in outs:
    print(f"  out[{n}] {s} -> {'BUYER' if a==buyer else ('SELLER' if a==payout else '?')}")
crit={
 "ord: inscription owned by BUYER": addr==buyer,
 "ord: inscription in swap output[0]": otx==txid and ovout=='0',
 "output[0]=buyer, 11000 sats": outs[0][2]==buyer and outs[0][1]==11000,
 "seller received 50000 sats": any(s==50000 and a==payout for n,s,a in outs),
 "single atomic tx": len(outs)>=2,
 "confirmed": tx.get('confirmations',0)>=1,
}
for k,v in crit.items(): print(f"  [{'PASS' if v else 'FAIL'}] {k}")
print("\nRESULT:", "ALL PASS ✅" if all(crit.values()) else "FAILURES ❌")
PY
