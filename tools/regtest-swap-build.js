/*
 * regtest-swap-build.js — invoked by regtest-reproduce.sh.
 * Reads the swap context + buyer UTXOs, calls the PRODUCTION buildAtomicSwap()
 * (with the sat-flow routing guard) in regtest mode, and writes the unsigned PSBT.
 * Prints the routing verdict + signing map as JSON.
 */
process.env.ASSET_LOOP_NETWORK = 'regtest';
const fs = require('fs');
const ROOT = process.env.BTC_ROOT || '/app/groups/main/.btctest';
const S = require('/app/groups/main/asset-loop/settlement.js');

const ctx = JSON.parse(fs.readFileSync(`${ROOT}/swapctx.json`));
const buyers = fs.readFileSync(`${ROOT}/buyer.txt`, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));
const dummy = buyers.find((b) => +b[2] === 1000);
const pay = buyers.filter((b) => +b[2] !== 1000);

const swap = S.buildAtomicSwap({
  sellerPayoutAddress: ctx.seller_payout,
  inscriptionUtxo: { txid: ctx.insc_txid, vout: ctx.insc_vout, value: ctx.insc_val, address: ctx.insc_addr },
  buyerAddress: ctx.buyer_addr,
  buyerDummyUtxo: { txid: dummy[0], vout: +dummy[1], value: +dummy[2] },
  buyerPaymentUtxos: pay.map((p) => ({ txid: p[0], vout: +p[1], value: +p[2] })),
  priceSats: 50000, feeRate: 2,
  inscriptionOffset: ctx.insc_offset || 0,
});
fs.writeFileSync(`${ROOT}/unsigned.psbt`, swap.psbt);
console.log(JSON.stringify({ routing: swap.routing, signing: swap.signing, fee: swap.fee, change: swap.change }));
