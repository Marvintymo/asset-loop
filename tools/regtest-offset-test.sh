#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# regtest-offset-test.sh — edge case: inscription NOT at sat offset 0.
#
# Fresh inscriptions sit at offset 0 of their UTXO. But a consolidated UTXO can
# hold the inscribed sat at an arbitrary offset K. This test creates exactly
# that (pads the inscription behind a K-sat input), then runs the production
# buildAtomicSwap() with inscriptionOffset=K and verifies with `ord` that the
# inscription still lands with the BUYER. Proves the guard uses the real offset.
#
# Requires the node + ord already up (run tools/regtest-reproduce.sh first).
# Usage:  bash tools/regtest-offset-test.sh [OFFSET_SATS]   (default 3000)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="${BTC_ROOT:-/app/groups/main/.btctest}"; REPO="${ASSET_LOOP_REPO:-/app/groups/main/asset-loop}"
BIND="$ROOT/bitcoin-28.0/bin"; DATA="$ROOT/data"; ORDDATA="$ROOT/orddata"; ORD_PORT=8090
CLI="$BIND/bitcoin-cli -regtest -datadir=$DATA"
ORD="$ROOT/ord --regtest --bitcoin-data-dir $DATA --data-dir $ORDDATA"
ORDW="$ORD wallet --server-url http://localhost:$ORD_PORT"
OFFSET="${1:-3000}"
say(){ echo -e "\n=== $* ==="; }
$CLI getblockcount >/dev/null 2>&1 || { echo "node not running — run tools/regtest-reproduce.sh first"; exit 1; }
curl -s -m3 "http://localhost:$ORD_PORT/blockcount" >/dev/null || { echo "ord server not running — run tools/regtest-reproduce.sh first"; exit 1; }
sync_ord(){ for i in $(seq 1 40); do [ "$($CLI getblockcount)" = "$(curl -s -m3 http://localhost:$ORD_PORT/blockcount 2>/dev/null||echo x)" ] && { sleep 1; return; }; sleep 1; done; }
ord_retry(){ local out; for i in $(seq 1 15); do if out=$("$@" 2>/tmp/oe); then echo "$out"; return 0; fi; grep -qE "blocks behind|not in ord server|not in index|wallet but not" /tmp/oe && { sync_ord; sleep 2; continue; }; cat /tmp/oe >&2; return 1; done; return 1; }
MINE=$($CLI -rpcwallet=miner getnewaddress "" bech32)

say "inscribe (offset 0 initially)"
echo "offset edge-case $(date -u +%s)" > "$ROOT/insc_off.txt"
INS=$(ord_retry $ORDW inscribe --fee-rate 1 --file "$ROOT/insc_off.txt")
INSC_ID=$(echo "$INS" | python3 -c "import sys,json;print(json.load(sys.stdin)['inscriptions'][0]['id'])")
R=$(echo "$INS" | python3 -c "import sys,json;print(json.load(sys.stdin)['reveal'])")
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
RVAL=$($CLI gettxout "$R" 0 | python3 -c "import sys,json;print(int(round(json.load(sys.stdin)['value']*1e8)))")

say "consolidate: pad inscription behind a ${OFFSET}-sat input -> offset ${OFFSET}"
PAD_ADDR=$(ord_retry $ORDW receive | python3 -c "import sys,json;print(json.load(sys.stdin)['addresses'][0])")
# fund an exact OFFSET-sat padding UTXO owned by the ord (seller) wallet
$CLI -rpcwallet=miner sendtoaddress "$PAD_ADDR" "$(python3 -c "print(f'{$OFFSET/1e8:.8f}')")" >/dev/null
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
PAD=$($CLI -rpcwallet=ord listunspent 0 9999999 "[\"$PAD_ADDR\"]" | python3 -c "import sys,json;u=[x for x in json.load(sys.stdin) if int(round(x['amount']*1e8))==$OFFSET][0];print(u['txid'],u['vout'])")
PAD_TX=$(echo $PAD|cut -d' ' -f1); PAD_VOUT=$(echo $PAD|cut -d' ' -f2)
DEST=$(ord_retry $ORDW receive | python3 -c "import sys,json;print(json.load(sys.stdin)['addresses'][0])")
FEE=300; OUTVAL=$(python3 -c "print(f'{($OFFSET+$RVAL-$FEE)/1e8:.8f}')")
# input[0]=pad, input[1]=inscription -> single output; inscription sat now at offset OFFSET
CPSBT=$($CLI createpsbt "[{\"txid\":\"$PAD_TX\",\"vout\":$PAD_VOUT},{\"txid\":\"$R\",\"vout\":0}]" "[{\"$DEST\":$OUTVAL}]")
CS=$($CLI -rpcwallet=ord walletprocesspsbt "$CPSBT" | python3 -c "import sys,json;print(json.load(sys.stdin)['psbt'])")
CHEX=$($CLI finalizepsbt "$CS" | python3 -c "import sys,json;print(json.load(sys.stdin)['hex'])")
CONS=$($CLI sendrawtransaction "$CHEX")
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
# confirm ord sees the inscription at offset OFFSET now
for i in $(seq 1 40); do S=$(curl -s -m5 -H "Accept: application/json" "http://localhost:$ORD_PORT/inscription/$INSC_ID"|python3 -c "import sys,json;print(json.load(sys.stdin).get('satpoint',''))" 2>/dev/null||echo); [ "${S%%:*}" = "$CONS" ] && break; sleep 1; done
echo "ord satpoint after consolidation: $S  (expect $CONS:0:$OFFSET)"
CVAL=$($CLI gettxout "$CONS" 0 | python3 -c "import sys,json;print(int(round(json.load(sys.stdin)['value']*1e8)))")

say "build + swap with inscriptionOffset=$OFFSET"
BUYER_ADDR=$($CLI -rpcwallet=buyer getnewaddress buyer bech32)
SELLER_PAYOUT=$($CLI -rpcwallet=miner getnewaddress payout bech32)
$CLI -rpcwallet=miner sendtoaddress "$BUYER_ADDR" 0.00001000 >/dev/null
$CLI -rpcwallet=miner sendtoaddress "$BUYER_ADDR" 0.00100000 >/dev/null
$CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
$CLI -rpcwallet=buyer listunspent 0 9999999 "[\"$BUYER_ADDR\"]" | python3 -c "
import sys,json;us=sorted(json.load(sys.stdin),key=lambda x:x['amount'])
open('$ROOT/buyer.txt','w').write('\n'.join(f\"{u['txid']} {u['vout']} {int(round(u['amount']*1e8))}\" for u in us))"
echo "{\"insc_txid\":\"$CONS\",\"insc_vout\":0,\"insc_val\":$CVAL,\"insc_addr\":\"$DEST\",\"insc_offset\":$OFFSET,\"buyer_addr\":\"$BUYER_ADDR\",\"seller_payout\":\"$SELLER_PAYOUT\"}" > "$ROOT/swapctx.json"
BTC_ROOT="$ROOT" node "$REPO/tools/regtest-swap-build.js"
PSBT=$(cat "$ROOT/unsigned.psbt")
S1=$($CLI -rpcwallet=ord   walletprocesspsbt "$PSBT" | python3 -c "import sys,json;print(json.load(sys.stdin)['psbt'])")
S2=$($CLI -rpcwallet=buyer walletprocesspsbt "$S1"   | python3 -c "import sys,json;print(json.load(sys.stdin)['psbt'])")
HEX=$($CLI finalizepsbt "$S2" | python3 -c "import sys,json;print(json.load(sys.stdin)['hex'])")
TXID=$($CLI sendrawtransaction "$HEX"); $CLI generatetoaddress 1 "$MINE" >/dev/null; sync_ord
echo "swap txid: $TXID"

say "verify"
for i in $(seq 1 40); do C=$(curl -s -m5 -H "Accept: application/json" "http://localhost:$ORD_PORT/inscription/$INSC_ID"|python3 -c "import sys,json;print(json.load(sys.stdin).get('satpoint','').split(':')[0])" 2>/dev/null||echo); [ "$C" = "$TXID" ] && break; sleep 1; done
LOC=$(curl -s -m8 -H "Accept: application/json" "http://localhost:$ORD_PORT/inscription/$INSC_ID")
CLI="$CLI" TXID="$TXID" LOC="$LOC" OFFSET="$OFFSET" BTC_ROOT="$ROOT" python3 <<'PY'
import os,subprocess,json
cli=os.environ['CLI'].split(); txid=os.environ['TXID']; off=int(os.environ['OFFSET'])
ctx=json.load(open(os.path.join(os.environ['BTC_ROOT'],'swapctx.json')))
loc=json.loads(os.environ['LOC']); sat=loc.get('satpoint',''); addr=loc.get('address')
otx,ovout,ooff=sat.split(':'); buyer=ctx['buyer_addr']
print("inscription satpoint now:",sat,"->",("BUYER" if addr==buyer else addr))
crit={
 f"ord: inscription owned by BUYER": addr==buyer,
 f"ord: located in swap output[0]": otx==txid and ovout=='0',
 f"sat offset in output[0] == dummy(1000)+K({off}) == {1000+off}": int(ooff)==1000+off,
}
for k,v in crit.items(): print(f"  [{'PASS' if v else 'FAIL'}] {k}")
print("\nOFFSET TEST:", "ALL PASS ✅" if all(crit.values()) else "FAIL ❌")
PY
