/*
 * test-offsets.js — deterministic unit test of buildAtomicSwap()'s handling of
 * NON-ZERO inscription sat offsets and the sat-flow guard. No node required.
 *   node tools/test-offsets.js
 */
process.env.ASSET_LOOP_NETWORK = 'regtest';
const S = require('/app/groups/main/asset-loop/settlement.js');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const crypto = require('crypto');
bitcoin.initEccLib(ecc);

// Generate VALID regtest p2wpkh addresses (correct bech32 checksum).
function regtestAddr() {
  let p; do { p = crypto.randomBytes(32); } while (!ecc.isPrivate(p));
  const pub = Buffer.from(ecc.pointFromScalar(p, true));
  return bitcoin.payments.p2wpkh({ pubkey: pub, network: bitcoin.networks.regtest }).address;
}
const A = regtestAddr();
const B = regtestAddr();
const DUMMY = 1000, INSC_VAL = 10000, PRICE = 50000, PAY = 100000;

function mock(txidByte) { return { txid: String(txidByte).repeat(64).slice(0, 64), vout: 0 }; }
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`); cond ? pass++ : fail++; };

console.log('== buildAtomicSwap across inscription sat offsets (inscription value 10000) ==');
for (const off of [0, 1, 3000, 9999]) {
  let landed = null, threw = null, routed = null;
  try {
    const r = S.buildAtomicSwap({
      sellerPayoutAddress: A,
      inscriptionUtxo: { ...mock(1), value: INSC_VAL, address: A },
      buyerAddress: B,
      buyerDummyUtxo: { ...mock(2), value: DUMMY },
      buyerPaymentUtxos: [{ ...mock(3), value: PAY }],
      priceSats: PRICE, feeRate: 2, inscriptionOffset: off,
    });
    routed = r.routing.inscriptionOutput;
    // independently recompute where the inscribed sat lands (FIFO)
    const outVals = [DUMMY + INSC_VAL, PRICE]; // change may exist but sat lands before it
    landed = S.ordinalRoutedOutput([DUMMY, INSC_VAL, PAY], outVals, 1, off);
  } catch (e) { threw = e.message; }
  ok(`offset ${off}: built, routing→output[0], inscribed sat in output[0]`, threw === null && routed === 0 && landed === 0);
}

console.log('\n== invalid offsets must be REJECTED ==');
for (const off of [10000, 15000, -1]) {
  let threw = null;
  try {
    S.buildAtomicSwap({
      sellerPayoutAddress: A, inscriptionUtxo: { ...mock(1), value: INSC_VAL, address: A },
      buyerAddress: B, buyerDummyUtxo: { ...mock(2), value: DUMMY },
      buyerPaymentUtxos: [{ ...mock(3), value: PAY }], priceSats: PRICE, inscriptionOffset: off,
    });
  } catch (e) { threw = e.message; }
  ok(`offset ${off}: rejected (out of range)`, threw !== null);
}

console.log('\n== the guard catches a genuine mis-route (belt-and-suspenders) ==');
// If payment were output[0] (the original finding-#1 bug), the inscribed sat would
// land with the seller — assertOrdinalRouting must throw.
let caught = false;
try { S.assertOrdinalRouting({ inputValues: [INSC_VAL, PAY], outputValues: [PRICE, INSC_VAL], insInputIdx: 0, insOffset: 0, buyerOutputIdx: 1 }); }
catch (e) { caught = /SAT-FLOW/.test(e.message); }
ok('mis-routing layout is refused by the guard', caught);

// A burn (sat beyond all outputs) must be detected.
ok('burn (sat → fee) detected as -1', S.ordinalRoutedOutput([1000, 10000], [1000], 1, 0) === -1);

console.log(`\nRESULT: ${fail === 0 ? 'ALL PASS ✅' : fail + ' FAILURES ❌'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
