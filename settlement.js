/*
 * settlement.js — real Bitcoin PSBT settlement engine (SIGNET by default).
 *
 * Implements the canonical Ordinals atomic-swap PSBT pattern:
 *   • Seller signs input[0] (their inscription UTXO) with SIGHASH_SINGLE |
 *     ANYONECANPAY, committing ONLY to output[0] = payment to themselves.
 *     That signed PSBT is a self-contained, broadcastable "offer".
 *   • Buyer completes it: adds their payment inputs, an output sending the
 *     inscription to their own address, and change; then signs their inputs
 *     with SIGHASH_ALL. Now the tx is fully signed and atomic — the ordinal
 *     moves iff the seller is paid, in ONE transaction.
 *
 * SAFETY:
 *   - Network is SIGNET (worthless test coins) unless explicitly overridden.
 *   - MAINNET is HARD-BLOCKED unless ASSET_LOOP_ALLOW_MAINNET === 'I_UNDERSTAND'
 *     AND it has been audited. Do not flip that switch without an audit — a
 *     malformed swap PSBT can misplace or burn an inscription.
 *   - The platform never holds keys. It only builds unsigned/partially-signed
 *     PSBTs and broadcasts what the wallets return.
 */

const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
bitcoin.initEccLib(ecc);

const SIGHASH_SINGLE_ACP = bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY;

function resolveNetwork() {
  const name = (process.env.ASSET_LOOP_NETWORK || 'signet').toLowerCase();
  const allowMainnet = process.env.ASSET_LOOP_ALLOW_MAINNET === 'I_UNDERSTAND';
  if (name === 'mainnet') {
    if (!allowMainnet) throw new Error('MAINNET is blocked. Settlement runs on signet until audited. Set ASSET_LOOP_ALLOW_MAINNET=I_UNDERSTAND only after a security audit.');
    return { net: bitcoin.networks.bitcoin, apiBase: 'https://mempool.space/api', name: 'mainnet' };
  }
  if (name === 'testnet') return { net: bitcoin.networks.testnet, apiBase: 'https://mempool.space/testnet/api', name: 'testnet' };
  if (name === 'regtest') return { net: bitcoin.networks.regtest, apiBase: process.env.ASSET_LOOP_REGTEST_API || 'http://localhost:18443', name: 'regtest' };
  // default signet (uses testnet address params)
  return { net: bitcoin.networks.testnet, apiBase: 'https://mempool.space/signet/api', name: 'signet' };
}

async function api(path, { method = 'GET', body, base } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${base}${path}`, { method, body, signal: ctrl.signal, headers: body ? { 'Content-Type': 'text/plain' } : {} });
    const text = await r.text();
    if (!r.ok) throw new Error(`indexer ${r.status}: ${text.slice(0, 120)}`);
    return text;
  } finally { clearTimeout(t); }
}

async function getUtxos(address, base) {
  const raw = await api(`/address/${encodeURIComponent(address)}/utxo`, { base });
  return JSON.parse(raw).filter((u) => u.status && u.status.confirmed);
}
async function getFeeRate(base) {
  try { const j = JSON.parse(await api('/v1/fees/recommended', { base })); return Math.max(1, j.halfHourFee || 1); }
  catch { return 2; }
}
async function broadcast(txHex, base) {
  return await api('/tx', { method: 'POST', body: txHex, base });
}

// ── Ordinals FIFO sat-flow verifier (the machine-check for finding #1) ───────
// Sats flow through a tx first-in-first-out. Given input values (in order), the
// inscription's input index + offset, and output values (in order), compute
// which OUTPUT the inscription sat lands in. Returns -1 if it falls into the
// fee (i.e. the inscription would be BURNED). This lets us assert routing
// correctness before anyone signs anything.
function ordinalRoutedOutput(inputValues, outputValues, insInputIdx, insOffset = 0) {
  let pos = 0;
  for (let i = 0; i < insInputIdx; i++) pos += inputValues[i];
  pos += insOffset;
  let acc = 0;
  for (let o = 0; o < outputValues.length; o++) {
    if (pos < acc + outputValues[o]) return o;
    acc += outputValues[o];
  }
  return -1; // sat is beyond all outputs → paid to miners as fee → BURNED
}

// Assert the inscription routes to the intended buyer output; throw otherwise.
function assertOrdinalRouting({ inputValues, outputValues, insInputIdx, insOffset = 0, buyerOutputIdx }) {
  const landed = ordinalRoutedOutput(inputValues, outputValues, insInputIdx, insOffset);
  if (landed === -1) throw new Error('SAT-FLOW: inscription would be BURNED to fee — refusing to build.');
  if (landed !== buyerOutputIdx) throw new Error(`SAT-FLOW: inscription would land in output[${landed}], not the buyer output[${buyerOutputIdx}] — refusing to build.`);
  return { ok: true, landed };
}

// Build the seller's signed-offer PSBT (unsigned here; the seller wallet signs input[0]).
function buildSellerOffer({ sellerAddress, inscriptionUtxo, priceSats }) {
  const { net } = resolveNetwork();
  const script = bitcoin.address.toOutputScript(sellerAddress, net);
  const psbt = new bitcoin.Psbt({ network: net });
  psbt.addInput({
    hash: inscriptionUtxo.txid, index: inscriptionUtxo.vout,
    witnessUtxo: { script, value: inscriptionUtxo.value },
    sighashType: SIGHASH_SINGLE_ACP,
  });
  psbt.addOutput({ address: sellerAddress, value: priceSats });
  return { psbt: psbt.toBase64(), sighash: 'SINGLE|ANYONECANPAY' };
}

// Complete the buyer side: add payment inputs, send the inscription to the buyer, and change.
async function buildBuyerCompletion({ offerPsbtB64, buyerAddress, inscriptionValue, priceSats }) {
  const cfg = resolveNetwork();
  const { net, apiBase } = cfg;
  const psbt = bitcoin.Psbt.fromBase64(offerPsbtB64, { network: net });
  const buyerScript = bitcoin.address.toOutputScript(buyerAddress, net);
  const feeRate = await getFeeRate(apiBase);

  const utxos = await getUtxos(buyerAddress, apiBase);
  if (!utxos.length) throw new Error(`buyer address has no confirmed UTXOs on ${cfg.name} — fund it from a faucet first`);

  // Value conservation: the inscription output (value = inscriptionValue) is
  // funded by input[0] (the seller's inscription UTXO). The buyer's own inputs
  // therefore only need to cover the seller PAYMENT + the network fee — NOT the
  // inscription value. (Earlier draft double-counted inscriptionValue, inflating
  // the fee by V sats; corrected here.)
  const estFee = (nin) => Math.ceil((10 + nin * 68 + 3 * 31) * feeRate);
  let gathered = 0, used = [];
  const need = () => priceSats + estFee(used.length + 1);
  for (const u of utxos.sort((a, b) => b.value - a.value)) {
    used.push(u); gathered += u.value;
    if (gathered >= need()) break;
  }
  if (gathered < need()) throw new Error(`insufficient buyer balance: have ${gathered} sats, need ~${need()} sats (price + fee)`);

  for (const u of used) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: buyerScript, value: u.value } });
  // Output[1]: inscription to the buyer, funded by input[0]'s value.
  // ⚠ KNOWN LIMITATION (audit item #1): under SIGHASH_SINGLE the inscription
  // sat in input[0] follows FIFO ordering into output[0] (the seller payment),
  // NOT this output. A production ordinal swap must use the dummy-padding
  // ordering (OpenOrdex/Magic Eden pattern) so the inscription sat lands here.
  // On signet with plain UTXOs this only validates sign/broadcast plumbing.
  psbt.addOutput({ address: buyerAddress, value: inscriptionValue });
  const change = gathered - priceSats - estFee(used.length);
  if (change > 330) psbt.addOutput({ address: buyerAddress, value: change });

  // SAFETY GUARD (finding #1): refuse to return a PSBT that misroutes/burns the
  // inscription. This legacy layout puts payment at output[0], so the inscription
  // sat (input[0] offset 0) routes to the SELLER — the guard correctly rejects it
  // and callers must use buildAtomicSwap (dummy-padded, routing-verified) instead.
  const outVals = psbt.txOutputs.map((o) => o.value);
  assertOrdinalRouting({ inputValues: [inscriptionValue, ...used.map((u) => u.value)], outputValues: outVals, insInputIdx: 0, insOffset: 0, buyerOutputIdx: 1 });

  return { psbt: psbt.toBase64(), network: cfg.name, feeRate, buyerInputs: used.length, changeSats: Math.max(0, change) };
}

// ── Routing-correct atomic swap (dummy-padded, machine-verified) ─────────────
// Assembles the FULL unsigned swap in one shot so every input index is fixed
// BEFORE anyone signs (this sidesteps the pre-signed-offer index fragility).
// Layout:
//   inputs : [0] buyer dummy (pad) · [1] seller inscription · [2..] buyer payment
//   outputs: [0] inscription → buyer (pad+inscriptionValue) · [1] payment → seller · [2] change → buyer
// The dummy at input[0] shifts the inscription sat (offset `inscriptionOffset`
// within input[1]) to global position = dummyValue + inscriptionOffset, which
// lands inside output[0] → the buyer. Asserted by the sat-flow verifier before
// the PSBT is returned. `inscriptionOffset` defaults to 0 (fresh inscriptions),
// but MUST be supplied when the inscribed sat is not the first sat of its UTXO
// (e.g. a consolidated/padded UTXO) — otherwise the guard checks the wrong sat.
function buildAtomicSwap({ sellerPayoutAddress, inscriptionUtxo, buyerAddress, buyerDummyUtxo, buyerPaymentUtxos, priceSats, feeRate = 2, inscriptionOffset = 0 }) {
  const { net } = resolveNetwork();
  const DUST = 546;
  const okSats = (x) => Number.isInteger(x) && x > 0 && x <= 21e14;
  if (!okSats(priceSats) || priceSats < DUST) throw new Error(`priceSats must be an integer ≥ ${DUST}`);
  if (!okSats(inscriptionUtxo.value) || !okSats(buyerDummyUtxo.value)) throw new Error('inscription/dummy values must be positive integer sats');
  if (buyerDummyUtxo.value < DUST) throw new Error(`buyer dummy must be ≥ ${DUST} sats`);
  for (const u of buyerPaymentUtxos) if (!okSats(u.value)) throw new Error('buyer payment values must be positive integer sats');
  if (inscriptionOffset < 0 || inscriptionOffset >= inscriptionUtxo.value) {
    throw new Error(`inscriptionOffset ${inscriptionOffset} out of range for a ${inscriptionUtxo.value}-sat inscription UTXO`);
  }
  const buyerScript = bitcoin.address.toOutputScript(buyerAddress, net);
  const sellerInsScript = bitcoin.address.toOutputScript(inscriptionUtxo.address, net);
  const payoutOk = bitcoin.address.toOutputScript(sellerPayoutAddress, net); // validate

  const inputsMeta = [
    { ...buyerDummyUtxo, script: buyerScript, owner: 'buyer' },
    { ...inscriptionUtxo, script: sellerInsScript, owner: 'seller' },
    ...buyerPaymentUtxos.map((u) => ({ ...u, script: buyerScript, owner: 'buyer' })),
  ];
  const inputValues = inputsMeta.map((i) => i.value);
  const sumIn = inputValues.reduce((a, b) => a + b, 0);

  const ordinalOut = buyerDummyUtxo.value + inscriptionUtxo.value; // preserves the inscription sat
  // Conservative vbyte estimate: 68 vB/input (p2wpkh; taproot key-path ~57.5 → over-est = safe),
  // 43 vB/output (taproot-safe upper bound), +11 segwit overhead, ×1.1 margin. Overpaying is
  // safe (change absorbs it); underpaying would strand the tx since the platform holds no keys.
  const est = Math.ceil((11 + inputsMeta.length * 68 + 3 * 43) * feeRate * 1.1);
  const change = sumIn - ordinalOut - priceSats - est;
  if (change < 0) throw new Error(`insufficient buyer funds: need ~${ordinalOut + priceSats + est - buyerDummyUtxo.value} more sats of payment`);

  const outputValues = [ordinalOut, priceSats];
  if (change > 330) outputValues.push(change);

  // MACHINE CHECK: the inscribed sat (input[1], offset inscriptionOffset) must
  // land in buyer output[0]. Guard uses the REAL offset, not an assumed 0.
  assertOrdinalRouting({ inputValues, outputValues, insInputIdx: 1, insOffset: inscriptionOffset, buyerOutputIdx: 0 });

  const psbt = new bitcoin.Psbt({ network: net });
  for (const i of inputsMeta) psbt.addInput({ hash: i.txid, index: i.vout, witnessUtxo: { script: i.script, value: i.value } });
  psbt.addOutput({ address: buyerAddress, value: ordinalOut });      // [0] inscription → buyer
  psbt.addOutput({ address: sellerPayoutAddress, value: priceSats }); // [1] payment → seller
  if (change > 330) psbt.addOutput({ address: buyerAddress, value: change }); // [2] change → buyer

  return {
    psbt: psbt.toBase64(),
    signing: { sellerInputIndex: 1, buyerInputIndexes: inputsMeta.map((m, idx) => (m.owner === 'buyer' ? idx : null)).filter((x) => x !== null) },
    routing: { inscriptionOutput: 0, verified: true },
    fee: sumIn - outputValues.reduce((a, b) => a + b, 0), change: Math.max(0, change),
  };
}

// Finalize a fully-signed PSBT and broadcast it.
async function finalizeAndBroadcast(signedPsbtB64) {
  const cfg = resolveNetwork();
  const psbt = bitcoin.Psbt.fromBase64(signedPsbtB64, { network: cfg.net });
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const hex = tx.toHex();
  const txid = await broadcast(hex, cfg.apiBase);
  return { txid, network: cfg.name, explorer: `${cfg.apiBase.replace('/api', '')}/tx/${txid}` };
}

// Fetch a UTXO's value (helper for the seller inscription input).
async function getUtxoValue(txid, vout) {
  const cfg = resolveNetwork();
  const raw = await api(`/tx/${txid}`, { base: cfg.apiBase });
  const tx = JSON.parse(raw);
  const out = tx.vout[vout];
  if (!out) throw new Error('vout not found');
  return out.value;
}

module.exports = {
  resolveNetwork, buildSellerOffer, buildBuyerCompletion, finalizeAndBroadcast,
  getUtxos, getFeeRate, getUtxoValue,
  ordinalRoutedOutput, assertOrdinalRouting, buildAtomicSwap,
};
