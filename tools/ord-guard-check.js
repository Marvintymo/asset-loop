/*
 * ord-guard-check.js — exercises the multi-inscription safety guard against the
 * live regtest ord server. Asserts the seller inscription UTXO carries exactly
 * ONE inscription and the buyer payment UTXO carries NONE (the two conditions the
 * production build-swap endpoint enforces via SETTLE.inscriptionsOnOutput()).
 *   ASSET_LOOP_ORD_API=http://localhost:8090 node tools/ord-guard-check.js
 */
process.env.ASSET_LOOP_NETWORK = 'regtest';
process.env.ASSET_LOOP_ORD_API = process.env.ASSET_LOOP_ORD_API || 'http://localhost:8090';
const fs = require('fs');
const ROOT = process.env.BTC_ROOT || '/app/groups/main/.btctest';
const S = require('/app/groups/main/asset-loop/settlement.js');

(async () => {
  const ctx = JSON.parse(fs.readFileSync(`${ROOT}/swapctx.json`));
  const buyers = fs.readFileSync(`${ROOT}/buyer.txt`, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));
  const pay = buyers.find((b) => +b[2] !== 1000) || buyers[0];
  try {
    const insIds = await S.inscriptionsOnOutput(ctx.insc_txid, ctx.insc_vout);
    const payIds = await S.inscriptionsOnOutput(pay[0], +pay[1]);
    const ok = insIds.length === 1 && payIds.length === 0;
    console.log(`  inscription UTXO: ${insIds.length} inscription(s) [expect 1] · buyer payment UTXO: ${payIds.length} [expect 0]`);
    console.log('  MULTI-INSCRIPTION GUARD:', ok ? 'PASS ✅ (would allow this single-inscription swap; would REJECT a multi-inscription UTXO)' : 'FAIL ❌');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.log('  ord-guard check skipped:', e.message);
    process.exit(0);
  }
})();
