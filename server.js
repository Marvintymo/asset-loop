/*
 * Asset Loop — consignment loop marketplace.
 *
 * You consign a digital asset (Counterparty / Ordinals). The platform runs a
 * continuous English-auction loop against a pool of AI buyer-agents: it matches
 * agents whose taste + budget fit the asset, negotiates bids between them, sells
 * to the highest bidder, then keeps looping — re-listing to find the next agent
 * willing to pay MORE than the last clearing price. You collect first-sale
 * proceeds plus a royalty on every subsequent flip.
 *
 * v2 adds:
 *  1. REAL on-chain metadata lookup (Ordinals via ordinals.com recursion,
 *     Counterparty via counterparty-core API) — all server-side.
 *  2. An external-agent API: real outside AI agents can register, poll the
 *     market, and place standing bids that compete in the live auction.
 *  3. Optional LLM-driven negotiation reasoning (activates when an
 *     OPENROUTER_API_KEY env var is present; graceful deterministic fallback).
 *
 * All external network calls happen here in the server, never in the browser.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
let btcMessage = null;
try { btcMessage = require('bitcoinjs-message'); } catch (e) { console.error('bitcoinjs-message unavailable:', e.message); }
let SETTLE = null;
try { SETTLE = require('./settlement'); } catch (e) { console.error('settlement engine unavailable:', e.message); }
const btcToSats = (btc) => Math.max(0, Math.round(Number(btc) * 1e8));

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const API = process.env.DASHBOARD_BASE || `http://localhost:${process.env.DASHBOARD_PORT || 4000}`;
const TOKEN = process.env.DASHBOARD_TOKEN;
const GROUP = process.env.ARTIFACT_GROUP || 'main';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const LLM_MODEL = process.env.ASSET_LOOP_MODEL || 'anthropic/claude-haiku-4.5';

// ─────────────────────────── DB helpers (server-side only) ───────────────────
const AUTH = { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } };

function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}
async function dbQuery(sql) {
  try {
    const r = await fetch(`${API}/api/db/${GROUP}/database/query?sql=${encodeURIComponent(sql)}`, AUTH);
    const j = await r.json();
    return j.rows || [];
  } catch (e) { console.error('dbQuery error:', e.message); return []; }
}
async function dbExec(sql) {
  try {
    const r = await fetch(`${API}/api/db/${GROUP}/database/execute`, {
      method: 'POST', headers: AUTH.headers, body: JSON.stringify({ sql }),
    });
    if (!r.ok) { const t = await r.text(); if (!/already exists|not allowed/.test(t)) console.error('dbExec HTTP', r.status, t.slice(0, 160)); }
  } catch (e) { console.error('dbExec error:', e.message); }
}

// Fetch with timeout.
async function httpGet(url, { timeout = 9000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'AssetLoop/2.0', ...headers } });
    return r;
  } finally { clearTimeout(t); }
}

// ─────────────────────────── In-memory state ────────────────────────────────
const state = { agents: [], assets: [], sales: [], settlements: [] };
// External standing bids: assetId -> Map(agentId -> { max_price, ts })
const extBids = new Map();
const EXT_BID_TTL = 1000 * 60 * 15;

let idc = 0;
function id(prefix) { idc += 1; return `${prefix}_${Date.now().toString(36)}_${idc.toString(36)}`; }
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const safeJson = (s, f) => { try { return JSON.parse(s); } catch { return f; } };

const CATEGORIES = [
  'rare-pepe', 'kaleidoscope', 'fake-rare', 'xcpinata', 'ordinal-punk', 'bitcoin-frog',
  'runestone', 'meme', 'pixel-art', 'generative', 'historic', 'utility', 'pfp',
];

// ─────────────────────────── Built-in agent pool ────────────────────────────
const AGENT_SEED = [
  { name: 'FrogWhale.ai',     avatar: '🐸', persona: 'Deep-pocketed Rare Pepe maximalist. Buys culture, never sells cheap.', budget: 4.8, aggression: 0.85, wants: ['rare-pepe', 'fake-rare', 'meme', 'historic'] },
  { name: 'OrdMaxi',          avatar: '🟧', persona: 'Ordinals-native flipper. Loves sub-1k inscriptions and punk energy.', budget: 3.2, aggression: 0.78, wants: ['ordinal-punk', 'bitcoin-frog', 'pixel-art', 'pfp'] },
  { name: 'GenArtDAO',        avatar: '🎛️', persona: 'Treasury bot buying generative + kaleidoscope for the collection.', budget: 6.5, aggression: 0.6, wants: ['generative', 'kaleidoscope', 'pixel-art'] },
  { name: 'PepeQuant',        avatar: '📈', persona: 'Model-driven. Bids only when its valuation beats the ask by margin.', budget: 2.9, aggression: 0.5, wants: ['rare-pepe', 'fake-rare', 'utility'] },
  { name: 'RunesRunner',      avatar: '🪄', persona: 'Runestone + historic hunter. Patient, then pounces.', budget: 3.8, aggression: 0.72, wants: ['runestone', 'historic', 'meme'] },
  { name: 'FloorSweeper9000', avatar: '🧹', persona: 'Volume bot. Small budget, sweeps anything mispriced low.', budget: 1.4, aggression: 0.9, wants: CATEGORIES.slice() },
  { name: 'MuseumOfBits',     avatar: '🏛️', persona: 'Institutional collector. Only the historically significant.', budget: 9.0, aggression: 0.45, wants: ['historic', 'rare-pepe', 'ordinal-punk', 'runestone'] },
  { name: 'FrogFund',         avatar: '💠', persona: 'Themed micro-fund. Bitcoin frogs and green pixel amphibians only.', budget: 2.1, aggression: 0.68, wants: ['bitcoin-frog', 'meme', 'pfp'] },
  { name: 'DegenLoop',        avatar: '🎲', persona: 'Reflexive degen. FOMOs into anything already pumping.', budget: 3.5, aggression: 0.95, wants: CATEGORIES.slice() },
  { name: 'VaultKeeper',      avatar: '🔐', persona: 'Long-term holder. Overpays for conviction, rarely resells.', budget: 5.5, aggression: 0.55, wants: ['utility', 'generative', 'historic', 'rare-pepe'] },
  { name: 'PixelPriest',      avatar: '🕹️', persona: 'Pixel + pfp purist with a sharp eye and a mid budget.', budget: 2.6, aggression: 0.7, wants: ['pixel-art', 'pfp', 'ordinal-punk'] },
  { name: 'KaleidoBot',       avatar: '🌀', persona: 'Kaleidoscope specialist. Fights to the top for a clean series card.', budget: 4.2, aggression: 0.82, wants: ['kaleidoscope', 'generative', 'rare-pepe'] },
];
function seedAgentsInMemory() {
  state.agents = AGENT_SEED.map((a) => ({ id: id('agt'), is_external: 0, kind: 'bot', ...a, budget: round2(a.budget) }));
}
async function persistAgent(a) {
  await dbExec(`INSERT OR REPLACE INTO al_agents (id,name,persona,avatar,wants,budget,aggression,is_external,api_key,endpoint,wallet_address,chain,kind) VALUES (${sqlVal(a.id)},${sqlVal(a.name)},${sqlVal(a.persona)},${sqlVal(a.avatar)},${sqlVal(JSON.stringify(a.wants))},${sqlVal(a.budget)},${sqlVal(a.aggression)},${sqlVal(a.is_external ? 1 : 0)},${sqlVal(a.api_key || null)},${sqlVal(a.endpoint || null)},${sqlVal(a.wallet_address || null)},${sqlVal(a.chain || null)},${sqlVal(a.kind || 'bot')})`);
}

// ─────────────────────────── Valuation + negotiation ────────────────────────
function valuationFor(agent, asset) {
  const likes = agent.wants.includes(asset.category);
  if (!likes && Math.random() > 0.12) return 0;
  const affinity = likes ? rnd(0.95, 1.45) : rnd(0.55, 0.85);
  const mood = rnd(0.82, 1.18);
  const raw = asset.mv * affinity * mood * (0.7 + 0.6 * agent.aggression);
  return round2(Math.min(agent.budget, raw));
}

// Standing external bids that are still fresh, as auction participants.
function externalBidders(asset, ask) {
  const m = extBids.get(asset.id);
  if (!m) return [];
  const now = Date.now();
  const out = [];
  for (const [agentId, bid] of m.entries()) {
    if (now - bid.ts > EXT_BID_TTL) { m.delete(agentId); continue; }
    if (agentId === asset.holder_id) continue;
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) { m.delete(agentId); continue; }
    if (bid.max_price > ask) out.push({ agent, val: round2(bid.max_price), external: true });
  }
  return out;
}

function tickAsset(asset) {
  if (asset.status !== 'looping' && asset.status !== 'paused') return null;
  asset.mv = round2(asset.mv * (1 + rnd(-0.015, 0.055)));
  const ask = asset.price > 0 ? asset.price : asset.reserve;
  const increment = Math.max(0.01, round2(ask * rnd(0.03, 0.08)));

  const internal = state.agents
    .filter((a) => !a.is_external && a.id !== asset.holder_id)
    .map((a) => ({ agent: a, val: valuationFor(a, asset), external: false }))
    .filter((b) => b.val > ask + increment * 0.5);
  const external = externalBidders(asset, ask + increment * 0.5);
  const bids = internal.concat(external).sort((x, y) => y.val - x.val);

  if (bids.length === 0) {
    asset.lastNote = `Seeking a buyer above ${ask.toFixed(3)} BTC — no agent will beat it yet.`;
    return null;
  }
  const winner = bids[0];
  const runnerUp = bids[1];
  const floor = runnerUp ? Math.max(ask, runnerUp.val) : ask;
  let clearing = round2(Math.min(winner.val, floor + increment));
  if (clearing <= ask) clearing = round2(ask + increment);
  if (clearing > winner.val) return null;

  const contenders = bids.slice(0, Math.min(4, bids.length));
  const log = [];
  let running = ask;
  log.push({ who: 'system', text: `Loop re-listed at ${ask.toFixed(3)} BTC. ${contenders.length} agent(s) matched "${asset.category}".` });
  for (const b of contenders.slice().reverse()) {
    const step = round2(Math.min(b.val, running + increment * rnd(0.9, 1.6)));
    const tag = b.external ? ' 🛰️' : '';
    if (step <= running) { log.push({ who: b.agent.name, avatar: (b.agent.avatar || '🤖') + tag, text: `${quipPass(b.agent)} (caps at ${b.val.toFixed(3)})` }); continue; }
    running = step;
    log.push({ who: b.agent.name, avatar: (b.agent.avatar || '🤖') + tag, text: `${quipBid(b.agent, asset)} — bids ${running.toFixed(3)} BTC` });
  }
  log.push({ who: winner.agent.name, avatar: (winner.agent.avatar || '🤖') + (winner.external ? ' 🛰️' : ''), text: `Wins at ${clearing.toFixed(3)} BTC. ${quipWin(winner.agent)}` });

  const prevPrice = asset.price;
  const isFirstSale = asset.flips === 0;
  const sellerName = isFirstSale ? 'You (consignor)' : asset.holder_name;

  const sale = {
    id: id('sale'), asset_id: asset.id, asset_name: asset.name, seller_name: sellerName,
    buyer_id: winner.agent.id, buyer_name: winner.agent.name,
    buyer_avatar: winner.agent.avatar || '🤖', external: !!winner.external,
    price: clearing, prev_price: prevPrice, round: asset.flips + 1, log, ts: new Date().toISOString(),
  };
  // Roster for optional LLM reasoning (winner + every contender), not persisted.
  sale._contenders = contenders.map((b) => ({
    name: b.agent.name, persona: b.agent.persona || 'an AI collector',
    won: b.agent.id === winner.agent.id,
  }));
  const earned = isFirstSale ? clearing : round2(clearing * asset.royalty);
  asset.earnings = round2((asset.earnings || 0) + earned);
  sale.consignor_earned = earned;

  // Consume the winner's external standing bid (they now hold it).
  if (winner.external) { const m = extBids.get(asset.id); if (m) m.delete(winner.agent.id); }

  // Record the seller's wallet (if the outgoing holder was wallet-connected).
  const prevHolder = state.agents.find((a) => a.id === asset.holder_id);
  asset.seller_wallet = prevHolder?.wallet_address || asset.seller_wallet || null;

  asset.holder_id = winner.agent.id;
  asset.holder_name = winner.agent.name;
  asset.holder_avatar = winner.agent.avatar || '🤖';
  asset.price = clearing;
  asset.high_water = Math.max(asset.high_water || 0, clearing);
  asset.flips += 1;
  asset.updated_at = new Date().toISOString();
  asset.lastNote = `Sold to ${winner.agent.name} for ${clearing.toFixed(3)} BTC.`;
  asset.ladder = (asset.ladder || []).concat(clearing).slice(-40);

  state.sales.unshift(sale);
  state.sales = state.sales.slice(0, 200);
  persistSale(sale); persistAsset(asset);

  // Real LLM reasoning for the winning agent — fire-and-forget + throttled so
  // the live loop stays fast and token spend stays bounded. Activates the
  // instant an OPENROUTER_API_KEY is set for the group; no-op otherwise.
  if (OPENROUTER_KEY && llmThrottle()) enrichWithLLM(sale, asset).catch(() => {});

  // If the winner is wallet-connected, open a non-custodial settlement intent.
  if (winner.agent.wallet_address) { try { buildSettlement(asset, winner.agent); } catch (e) { /* non-fatal */ } }
  return sale;
}

// Global throttle: at most one LLM enrichment per 4s across the whole loop.
let _llmLast = 0;
function llmThrottle() { const now = Date.now(); if (now - _llmLast < 4000) return false; _llmLast = now; return true; }

function quipBid(a, asset) {
  return pick([`This ${asset.category} fits my mandate`, `Undervalued at the ask`, `My model flags upside here`,
    `Can't let a clean ${asset.category} walk`, `Adding to the collection`, `Conviction buy`, `FOMO is real on this one`, `Floor's moving, I'm in`]);
}
const quipPass = () => pick(['Passes — over my number', 'Out, too rich', 'Folds', 'Not at that price', 'Bows out']);
const quipWin = () => pick(['Mine.', 'Locking it in.', 'Straight to the vault.', 'Good trade.', 'Worth every sat.', 'Loop me the next one.']);

// ─────────────────────────── Optional LLM enrichment ────────────────────────
// Enrich the WHOLE negotiation — every bidder's rationale AND the winner's line —
// in a single batched LLM call (one call per auction, throttled). The model
// returns { "AgentName": "one-line reason", ... } which we map back onto the log.
async function enrichWithLLM(sale, asset) {
  if (!OPENROUTER_KEY || !sale) return sale;
  try {
    const contenders = sale._contenders || [];
    if (!contenders.length) return sale;
    const roster = contenders.map((c) => `- ${c.name} (${c.persona}) — ${c.won ? `WON at ${sale.price.toFixed(3)}` : 'bidding'} BTC`).join('\n');
    const prompt = `A live auction for "${asset.name}" (${asset.type}, category "${asset.category}", collection "${asset.collection}", up from ${sale.prev_price} to ${sale.price} BTC).\n` +
      `These AI collectors competed:\n${roster}\n\n` +
      `For EACH agent, write a punchy ONE-LINER (max 14 words) in their own voice explaining their bid (or their win). ` +
      `Return ONLY compact JSON mapping the exact agent name to its line, e.g. {"FrogWhale.ai":"..."}. No markdown, no extra text.`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: 260, messages: [{ role: 'user', content: prompt }] }),
    });
    clearTimeout(t);
    const j = await r.json();
    let content = j?.choices?.[0]?.message?.content?.trim() || '';
    if (!content) console.error('LLM resp status=', r.status, 'body=', JSON.stringify(j).slice(0, 400));
    const m = content.match(/\{[\s\S]*\}/); // tolerate code fences / stray text
    const map = m ? JSON.parse(m[0]) : {};
    let changed = false;
    for (const line of sale.log) {
      if (!line.who || line.who === 'system' || !map[line.who]) continue;
      const reason = String(map[line.who]).replace(/^["']|["']$/g, '').slice(0, 120);
      const bid = line.text.match(/bids ([\d.]+) BTC/);
      const win = line.text.match(/Wins at ([\d.]+) BTC/);
      if (win) line.text = `Wins at ${win[1]} BTC. ${reason}`;
      else if (bid) line.text = `${reason} — bids ${bid[1]} BTC`;
      else line.text = reason;
      line.llm = true; changed = true;
    }
    if (changed) persistSale(sale);
  } catch (e) { console.error('LLM enrich error:', e.message); }
  return sale;
}

// ─────────────────────────── Real on-chain lookups ──────────────────────────
async function lookupOrdinals(ref) {
  ref = String(ref || '').trim();
  let inscriptionId = null;
  if (/^[0-9a-f]{64}i\d+$/i.test(ref)) inscriptionId = ref.toLowerCase();
  else if (/^\d+$/.test(ref)) {
    // Resolve inscription NUMBER -> id via the public HTML page.
    const html = await httpGet(`https://ordinals.com/inscription/${ref}`, { headers: { Accept: 'text/html' } }).then((r) => r.text());
    const m = html.match(/[0-9a-f]{64}i\d+/i);
    if (m) inscriptionId = m[0].toLowerCase();
  }
  if (!inscriptionId) throw new Error('Enter a full inscription ID (…i0) or an inscription number.');

  const r = await httpGet(`https://ordinals.com/r/inscription/${inscriptionId}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Inscription not found (${r.status}).`);
  const d = await r.json();
  const ct = d.content_type || '';
  const isImg = /^image\//.test(ct);
  const content = `https://ordinals.com/content/${inscriptionId}`;
  return {
    verified: true,
    name: `Inscription #${d.number}`,
    type: 'ordinals',
    collection: 'Ordinals',
    category: /svg|html/.test(ct) ? 'generative' : (isImg ? 'pixel-art' : 'ordinal-punk'),
    image_url: isImg ? content : '',
    content_type: ct,
    source_url: `https://ordinals.com/inscription/${inscriptionId}`,
    traits: [ct || 'unknown', `${d.content_length || 0} bytes`, `block ${d.height}`],
    meta: {
      'Inscription #': d.number, id: inscriptionId, 'Content type': ct,
      'Size': `${d.content_length} bytes`, 'Genesis block': d.height,
      'Sat': d.sat, 'Owner': d.address, 'Inscribed': d.timestamp ? new Date(d.timestamp * 1000).toISOString().slice(0, 10) : '—',
    },
  };
}

async function lookupCounterparty(ref) {
  const asset = String(ref || '').trim().toUpperCase();
  if (!asset) throw new Error('Enter a Counterparty asset name (e.g. RAREPEPE).');
  const r = await httpGet(`https://api.counterparty.io:4000/v2/assets/${encodeURIComponent(asset)}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Asset lookup failed (${r.status}).`);
  const j = await r.json();
  const d = j.result;
  if (!d || !d.asset) throw new Error('Asset not found on Counterparty.');
  const desc = d.description || '';
  const descIsImg = /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp)$/i.test(desc);
  const name = d.asset_longname || d.asset;
  return {
    verified: true,
    name,
    type: 'counterparty',
    collection: 'Counterparty',
    category: 'rare-pepe',
    // Best-effort image: direct image description, else the xchain card (browser <img>, fallback icon in UI).
    image_url: descIsImg ? desc : `https://xchain.io/img/${d.asset}.png`,
    content_type: d.mime_type || '',
    source_url: `https://xchain.io/asset/${d.asset}`,
    traits: [`supply ${d.supply}`, d.divisible ? 'divisible' : 'indivisible', d.locked ? 'locked' : 'unlocked', d.mime_type || ''].filter(Boolean),
    meta: {
      Asset: d.asset, Supply: d.supply, Divisible: !!d.divisible, Locked: !!d.locked,
      Issuer: d.issuer, Owner: d.owner, 'Issuance block': d.first_issuance_block_index,
      Description: desc.slice(0, 120),
    },
  };
}

// ─────────────────────────── Persistence ────────────────────────────────────
async function persistAsset(a) {
  await dbExec(`INSERT OR REPLACE INTO al_assets (id,name,type,collection,category,image_url,traits,reserve,royalty,status,holder_id,holder_name,price,high_water,mv,earnings,flips,verified,source_url,content_type,external_meta,created_at,updated_at)
    VALUES (${sqlVal(a.id)},${sqlVal(a.name)},${sqlVal(a.type)},${sqlVal(a.collection)},${sqlVal(a.category)},${sqlVal(a.image_url)},${sqlVal(JSON.stringify(a.traits || []))},${sqlVal(a.reserve)},${sqlVal(a.royalty)},${sqlVal(a.status)},${sqlVal(a.holder_id)},${sqlVal(a.holder_name)},${sqlVal(a.price)},${sqlVal(a.high_water)},${sqlVal(a.mv)},${sqlVal(a.earnings)},${sqlVal(a.flips)},${sqlVal(a.verified ? 1 : 0)},${sqlVal(a.source_url || null)},${sqlVal(a.content_type || null)},${sqlVal(JSON.stringify(a.meta || null))},${sqlVal(a.created_at)},${sqlVal(a.updated_at)})`);
}
async function persistSale(s) {
  await dbExec(`INSERT OR REPLACE INTO al_sales (id,asset_id,seller_name,buyer_id,buyer_name,price,prev_price,round,log,ts)
    VALUES (${sqlVal(s.id)},${sqlVal(s.asset_id)},${sqlVal(s.seller_name)},${sqlVal(s.buyer_id)},${sqlVal(s.buyer_name)},${sqlVal(s.price)},${sqlVal(s.prev_price)},${sqlVal(s.round)},${sqlVal(JSON.stringify(s.log))},${sqlVal(s.ts)})`);
}

// ─────────────────────────── Boot ───────────────────────────────────────────
async function boot() {
  const agentRows = await dbQuery('SELECT * FROM al_agents');
  if (agentRows.length === 0) {
    seedAgentsInMemory();
    for (const a of state.agents) await persistAgent(a);
    console.log(`Seeded ${state.agents.length} buyer-agents.`);
  } else {
    state.agents = agentRows.map((r) => ({
      id: r.id, name: r.name, persona: r.persona, avatar: r.avatar,
      wants: safeJson(r.wants, []), budget: r.budget, aggression: r.aggression,
      is_external: r.is_external ? 1 : 0, api_key: r.api_key, endpoint: r.endpoint,
      wallet_address: r.wallet_address || null, chain: r.chain || null, kind: r.kind || 'bot',
    }));
    console.log(`Loaded ${state.agents.length} buyer-agents.`);
  }
  const assetRows = await dbQuery('SELECT * FROM al_assets');
  state.assets = assetRows.map((r) => ({
    id: r.id, name: r.name, type: r.type, collection: r.collection, category: r.category,
    image_url: r.image_url, traits: safeJson(r.traits, []), reserve: r.reserve, royalty: r.royalty || 0.05,
    status: r.status, holder_id: r.holder_id, holder_name: r.holder_name, holder_avatar: '',
    price: r.price, high_water: r.high_water, mv: r.mv || r.reserve, earnings: r.earnings || 0, flips: r.flips || 0,
    verified: !!r.verified, source_url: r.source_url, content_type: r.content_type, meta: safeJson(r.external_meta, null),
    created_at: r.created_at, updated_at: r.updated_at, ladder: [], lastNote: '',
  }));
  const saleRows = await dbQuery('SELECT * FROM al_sales ORDER BY ts DESC LIMIT 200');
  state.sales = saleRows.map((r) => ({
    id: r.id, asset_id: r.asset_id, seller_name: r.seller_name, buyer_id: r.buyer_id, buyer_name: r.buyer_name,
    price: r.price, prev_price: r.prev_price, round: r.round, log: safeJson(r.log, []), ts: r.ts,
  }));
  for (const asset of state.assets) {
    const hist = state.sales.filter((s) => s.asset_id === asset.id).slice().reverse();
    asset.ladder = hist.map((s) => s.price).slice(-40);
    const holder = state.agents.find((a) => a.id === asset.holder_id);
    if (holder) asset.holder_avatar = holder.avatar || '🤖';
    const nm = state.assets.find; // noop
    // attach asset_name onto sales for the global feed
  }
  for (const s of state.sales) {
    const a = state.assets.find((x) => x.id === s.asset_id); if (a) s.asset_name = a.name;
    const b = state.agents.find((x) => x.id === s.buyer_id); if (b) s.buyer_avatar = b.avatar || '🤖', s.external = !!b.is_external;
  }
  const stlRows = await dbQuery('SELECT * FROM al_settlements ORDER BY created_at DESC LIMIT 100');
  state.settlements = stlRows.map((r) => ({
    id: r.id, asset_id: r.asset_id, asset_name: r.asset_name, buyer_agent_id: r.buyer_agent_id,
    buyer_name: r.buyer_name, buyer_wallet: r.buyer_wallet, seller_wallet: r.seller_wallet,
    price: r.price, chain: r.chain, network: SETTLE_NETWORK, mode: SETTLEMENT_MODE, status: r.status,
    psbt_stub: r.psbt_stub, created_at: r.created_at,
  }));
  console.log(`Loaded ${state.assets.length} assets, ${state.sales.length} sales, ${state.settlements.length} settlements. LLM: ${OPENROUTER_KEY ? 'active' : 'inactive'}. Settlement: ${SETTLEMENT_MODE}/${SETTLE_NETWORK}.`);
}

// ─────────────────────────── The loop ───────────────────────────────────────
let loopBusy = false;
async function loopTick() {
  if (loopBusy) return; loopBusy = true;
  try {
    for (const asset of state.assets.filter((a) => a.status === 'looping')) {
      if (Math.random() < 0.45) continue;
      tickAsset(asset);
    }
  } catch (e) { console.error('loopTick error:', e.message); } finally { loopBusy = false; }
}
setInterval(loopTick, 3500);

// ─────────────────────────── API ────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const totalEarnings = round2(state.assets.reduce((s, a) => s + (a.earnings || 0), 0));
  res.json({
    now: new Date().toISOString(),
    llm: { active: !!OPENROUTER_KEY, model: OPENROUTER_KEY ? LLM_MODEL : null },
    settlement: { mode: SETTLEMENT_MODE, network: SETTLE_NETWORK },
    beacon: { pings: beacon.pings, subscribers: beacon.sse.size, lastPing: beacon.lastPing, since: beacon.since },
    agents: state.agents.map((a) => ({
      id: a.id, name: a.name, avatar: a.avatar || '🛰️', persona: a.persona, wants: a.wants,
      budget: a.budget, aggression: a.aggression, is_external: !!a.is_external, kind: a.kind || 'bot',
      wallet: a.wallet_address ? shortAddr(a.wallet_address) : null, chain: a.chain || null,
      holdings: state.assets.filter((x) => x.holder_id === a.id).map((x) => x.name),
    })),
    settlements: state.settlements.slice(0, 12),
    assets: state.assets.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).map((a) => ({
      id: a.id, name: a.name, type: a.type, collection: a.collection, category: a.category, image_url: a.image_url,
      traits: a.traits, reserve: a.reserve, royalty: a.royalty, status: a.status, holder_name: a.holder_name,
      holder_avatar: a.holder_avatar, price: a.price, high_water: a.high_water, earnings: a.earnings, flips: a.flips,
      ladder: a.ladder, lastNote: a.lastNote, mv: round2(a.mv), verified: a.verified, source_url: a.source_url,
      content_type: a.content_type, meta: a.meta,
    })),
    sales: state.sales.slice(0, 40),
    stats: {
      totalEarnings, totalFlips: state.sales.length,
      activeLoops: state.assets.filter((a) => a.status === 'looping').length,
      agentCount: state.agents.length, externalAgents: state.agents.filter((a) => a.is_external).length,
      connectedWallets: state.agents.filter((a) => a.wallet_address).length,
      settlements: state.settlements.length,
    },
    categories: CATEGORIES,
  });
});

// Real on-chain metadata lookup.
app.post('/api/lookup', async (req, res) => {
  const type = req.body?.type;
  const ref = req.body?.ref;
  try {
    const data = type === 'counterparty' ? await lookupCounterparty(ref) : await lookupOrdinals(ref);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Lookup failed' });
  }
});

// Consign an asset (may carry verified on-chain metadata).
app.post('/api/consign', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 90);
  if (!name) return res.status(400).json({ error: 'name required' });
  const type = ['counterparty', 'ordinals'].includes(b.type) ? b.type : 'ordinals';
  const category = CATEGORIES.includes(b.category) ? b.category : 'meme';
  let reserve = parseFloat(b.reserve); if (!Number.isFinite(reserve) || reserve <= 0) reserve = 0.05; reserve = Math.min(reserve, 50);
  let royalty = parseFloat(b.royalty); if (!Number.isFinite(royalty) || royalty < 0) royalty = 5; royalty = Math.min(royalty, 20) / 100;
  const asset = {
    id: id('ast'), name, type,
    collection: String(b.collection || '').trim().slice(0, 60) || (type === 'ordinals' ? 'Ordinals' : 'Counterparty'),
    category, image_url: String(b.image_url || '').trim().slice(0, 500),
    traits: Array.isArray(b.traits) ? b.traits.slice(0, 8).map((t) => String(t).slice(0, 40)) : [],
    reserve: round2(reserve), royalty, status: 'looping',
    holder_id: 'consignor', holder_name: 'You (consignor)', holder_avatar: '📦',
    price: 0, high_water: 0, mv: round2(reserve * rnd(1.0, 1.25)), earnings: 0, flips: 0,
    verified: !!b.verified, source_url: b.source_url ? String(b.source_url).slice(0, 300) : null,
    content_type: b.content_type ? String(b.content_type).slice(0, 80) : null,
    meta: b.meta && typeof b.meta === 'object' ? b.meta : null,
    ladder: [], lastNote: b.verified ? 'On-chain asset consigned. Entering the loop…' : 'Consigned. Entering the loop…',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  state.assets.unshift(asset);
  await persistAsset(asset);
  res.json({ ok: true, asset_id: asset.id });
});

app.post('/api/asset/:id/:action', async (req, res) => {
  // Bound abuse of these unauthenticated demo controls (griefing / step-spam).
  if (!rateLimit(`act:${req.ip || 'x'}`, 60, 60000)) return res.status(429).json({ error: 'rate limited' });
  const asset = state.assets.find((a) => a.id === req.params.id);
  if (!asset) return res.status(404).json({ error: 'not found' });
  const action = req.params.action;
  if (action === 'pause') asset.status = 'paused';
  else if (action === 'resume') asset.status = 'looping';
  else if (action === 'withdraw') asset.status = 'withdrawn';
  else if (action === 'step') { let sale = tickAsset(asset); if (sale) sale = await enrichWithLLM(sale, asset); return res.json({ ok: true, sale }); }
  else return res.status(400).json({ error: 'unknown action' });
  asset.updated_at = new Date().toISOString();
  persistAsset(asset);
  res.json({ ok: true, status: asset.status });
});

// ─────────────────── External-agent API (for real outside AI agents) ────────
const rl = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now(); const e = rl.get(key) || { n: 0, t: now };
  if (now - e.t > windowMs) { e.n = 0; e.t = now; }
  e.n += 1; rl.set(key, e); return e.n <= max;
}
// Sweep stale rate-limit entries so the map can't grow unbounded (memory DoS).
setInterval(() => { const now = Date.now(); for (const [k, e] of rl) if (now - e.t > 600000) rl.delete(k); }, 300000);

// ══════════════════ Non-custodial wallet connect + auth ═════════════════════
// The platform NEVER holds a private key. A wallet proves control by signing a
// server-issued nonce. EVM signatures are verified cryptographically (ethers).
// BTC signatures are verified where the address type supports it (bitcoinjs-
// message); taproot/BIP-322 sigs are captured and marked verification-pending.
const SETTLE_NETWORK = (process.env.ASSET_LOOP_NETWORK || 'signet').toLowerCase(); // never 'mainnet' by default
const SETTLEMENT_MODE = (process.env.ASSET_LOOP_SETTLEMENT || 'design').toLowerCase(); // 'design' = no fund movement
const challenges = new Map(); // addressLower -> { message, exp }
const sessions = new Map();   // token -> { address, chain, agentId, kind, verified, exp }
const SESSION_TTL = 1000 * 60 * 60 * 24;

function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''; }

function makeChallenge(address, chain) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const message = `Asset Loop wants you to sign in with your ${chain === 'evm' ? 'Ethereum' : 'Bitcoin'} wallet.\n\n` +
    `Address: ${address}\nNonce: ${nonce}\nThis signature proves wallet control. It does NOT authorize any transfer.`;
  challenges.set(address.toLowerCase(), { message, exp: Date.now() + 1000 * 60 * 10 });
  return message;
}

function verifySignature(chain, address, message, signature) {
  try {
    if (chain === 'evm') {
      const rec = ethers.verifyMessage(message, signature);
      return { verified: rec.toLowerCase() === String(address).toLowerCase(), method: 'eip191' };
    }
    if (chain === 'btc') {
      if (!btcMessage) return { verified: false, method: 'unavailable' };
      // Taproot (bc1p...) uses BIP-322 which bitcoinjs-message cannot verify.
      if (/^(bc1p|tb1p)/i.test(address)) return { verified: false, method: 'bip322-pending' };
      const ok = btcMessage.verify(message, address, signature, undefined, true);
      return { verified: !!ok, method: 'bip137' };
    }
  } catch (e) { return { verified: false, method: 'error', error: e.message }; }
  return { verified: false, method: 'unknown' };
}

function sessionFromReq(req) {
  const token = req.headers['x-session'] || req.body?.session;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) { if (s) sessions.delete(token); return null; }
  return s;
}

// Resolve the bidding participant: either an API-key agent or a wallet session.
function resolveParticipant(req) {
  const key = req.headers['x-agent-key'] || req.body?.api_key;
  if (key) { const a = state.agents.find((x) => x.is_external && x.api_key === key); if (a) return a; }
  const s = sessionFromReq(req);
  if (s) { const a = state.agents.find((x) => x.id === s.agentId); if (a) return a; }
  return null;
}

function placeBid(agent, asset, maxPrice) {
  maxPrice = Math.min(maxPrice, agent.budget);
  if (!extBids.has(asset.id)) extBids.set(asset.id, new Map());
  extBids.get(asset.id).set(agent.id, { max_price: round2(maxPrice), ts: Date.now() });
  return round2(maxPrice);
}

// GET a challenge to sign.
app.get('/api/auth/challenge', (req, res) => {
  const address = String(req.query.address || '').trim();
  const chain = req.query.chain === 'evm' ? 'evm' : 'btc';
  if (!address) return res.status(400).json({ error: 'address required' });
  if (!rateLimit(`ch:${address}`, 30, 60000)) return res.status(429).json({ error: 'rate limited' });
  res.json({ ok: true, message: makeChallenge(address, chain) });
});

// Verify a signed challenge → create/link a wallet participant + issue a session.
app.post('/api/auth/verify', async (req, res) => {
  const b = req.body || {};
  const address = String(b.address || '').trim();
  const chain = b.chain === 'evm' ? 'evm' : 'btc';
  const signature = String(b.signature || '');
  const kind = b.kind === 'agent' ? 'agent' : 'user';
  if (!address || !signature) return res.status(400).json({ error: 'address and signature required' });
  const ch = challenges.get(address.toLowerCase());
  if (!ch || ch.exp < Date.now()) return res.status(400).json({ error: 'no active challenge — request one first' });
  const v = verifySignature(chain, address, ch.message, signature);
  challenges.delete(address.toLowerCase());

  // Find-or-create the participant agent bound to this wallet.
  let agent = state.agents.find((a) => a.wallet_address && a.wallet_address.toLowerCase() === address.toLowerCase());
  if (!agent) {
    if (state.agents.length >= 500) return res.status(429).json({ error: 'participant limit reached' });
    let wants = Array.isArray(b.wants) ? b.wants.filter((w) => CATEGORIES.includes(w)) : [];
    if (!wants.length) wants = CATEGORIES.slice();
    let budget = parseFloat(b.budget); if (!Number.isFinite(budget) || budget <= 0) budget = 1; budget = Math.min(budget, 100);
    agent = {
      id: id(kind === 'agent' ? 'ext' : 'usr'),
      name: (b.label && String(b.label).slice(0, 32)) || `${kind === 'agent' ? 'Agent' : 'User'} ${shortAddr(address)}`,
      persona: kind === 'agent' ? String(b.persona || 'Wallet-connected autonomous agent').slice(0, 160) : 'Human collector, self-custody wallet.',
      avatar: kind === 'agent' ? '🛰️' : '👛', wants, budget: round2(budget), aggression: 0.75,
      is_external: 1, api_key: null, endpoint: null, wallet_address: address, chain, kind,
    };
    state.agents.push(agent);
  } else if (v.verified) {
    // Only a VERIFIED signature from this exact address may mutate an existing
    // agent (prevents unverified hijack/relabel of someone else's wallet agent).
    if (b.label) agent.name = String(b.label).slice(0, 32);
    if (b.budget && Number.isFinite(parseFloat(b.budget))) agent.budget = round2(Math.min(parseFloat(b.budget), 100));
    if (Array.isArray(b.wants) && b.wants.length) agent.wants = b.wants.filter((w) => CATEGORIES.includes(w));
  }
  await persistAgent(agent);

  const token = 'sess_' + crypto.randomBytes(24).toString('hex');
  sessions.set(token, { address, chain, agentId: agent.id, kind, verified: v.verified, exp: Date.now() + SESSION_TTL });
  res.json({
    ok: true, session: token, agent_id: agent.id, kind, verified: v.verified, verify_method: v.method,
    address, chain, budget: agent.budget,
    note: v.verified ? 'Wallet verified & connected.' : 'Connected — signature captured (verification pending for this address type).',
  });
});

// Who am I (by session).
app.get('/api/auth/me', (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.json({ ok: true, connected: false });
  const a = state.agents.find((x) => x.id === s.agentId);
  res.json({ ok: true, connected: true, address: s.address, chain: s.chain, kind: s.kind, verified: s.verified,
    agent_id: s.agentId, name: a?.name, budget: a?.budget,
    holdings: state.assets.filter((x) => x.holder_id === s.agentId).map((x) => ({ asset_id: x.id, name: x.name, price: x.price })) });
});

// ══════════════════ Settlement (non-custodial, coordinated) ═════════════════
// Builds an UNSIGNED transfer instruction the counterparties sign in their own
// wallets. In 'design' mode nothing is broadcast — it demonstrates the flow.
function buildSettlement(asset, buyer) {
  const settlement = {
    id: id('stl'), asset_id: asset.id, asset_name: asset.name,
    buyer_agent_id: buyer.id, buyer_name: buyer.name, buyer_wallet: buyer.wallet_address || null,
    seller_wallet: asset.seller_wallet || null, price: asset.price, chain: asset.type,
    network: SETTLE_NETWORK, mode: SETTLEMENT_MODE,
    status: SETTLEMENT_MODE === 'design' ? 'demo-unsigned' : 'awaiting-signatures',
    // Illustrative PSBT-style instruction — NOT a broadcastable mainnet tx.
    psbt_stub: Buffer.from(JSON.stringify({
      type: asset.type === 'ordinals' ? 'ordinal-transfer' : 'counterparty-send',
      inputs: [{ note: `${asset.name} UTXO held by seller ${shortAddr(asset.seller_wallet || 'n/a')}` }],
      outputs: [
        { to: buyer.wallet_address || 'buyer-wallet', asset: asset.name },
        { to: asset.seller_wallet || 'seller-wallet', btc: asset.price, note: 'payment' },
      ],
      network: SETTLE_NETWORK,
    })).toString('base64'),
    created_at: new Date().toISOString(),
  };
  dbExec(`INSERT OR REPLACE INTO al_settlements (id,asset_id,asset_name,buyer_agent_id,buyer_name,buyer_wallet,seller_wallet,price,chain,status,psbt_stub,created_at) VALUES (${sqlVal(settlement.id)},${sqlVal(settlement.asset_id)},${sqlVal(settlement.asset_name)},${sqlVal(settlement.buyer_agent_id)},${sqlVal(settlement.buyer_name)},${sqlVal(settlement.buyer_wallet)},${sqlVal(settlement.seller_wallet)},${sqlVal(settlement.price)},${sqlVal(settlement.chain)},${sqlVal(settlement.status)},${sqlVal(settlement.psbt_stub)},${sqlVal(settlement.created_at)})`);
  state.settlements.unshift(settlement);
  state.settlements = state.settlements.slice(0, 100);
  return settlement;
}

app.get('/api/settlements', (req, res) => res.json({ ok: true, mode: SETTLEMENT_MODE, network: SETTLE_NETWORK, settlements: state.settlements.slice(0, 40) }));

app.get('/api/settlement/quote', (req, res) => {
  const asset = state.assets.find((a) => a.id === req.query.asset_id);
  if (!asset) return res.status(404).json({ error: 'asset not found' });
  const buyer = state.agents.find((a) => a.id === asset.holder_id) || { id: 'consignor', name: asset.holder_name, wallet_address: null };
  res.json({ ok: true, mode: SETTLEMENT_MODE, network: SETTLE_NETWORK, quote: buildSettlement(asset, buyer) });
});

// ─── Phase 2: REAL PSBT settlement (SIGNET) — atomic ordinal swap ────────────
app.get('/api/settlement/config', (req, res) => {
  let network = SETTLE_NETWORK, mainnetBlocked = true;
  try { if (SETTLE) { network = SETTLE.resolveNetwork().name; mainnetBlocked = network !== 'mainnet'; } } catch (e) {}
  res.json({ ok: true, network, mode: SETTLEMENT_MODE, engine: !!SETTLE, mainnetBlocked });
});

// List the connected wallet's confirmed UTXOs (for the guided signet test-flip).
app.get('/api/settlement/utxos', async (req, res) => {
  if (!SETTLE) return res.status(503).json({ error: 'settlement engine unavailable' });
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'connect a wallet (x-session)' });
  if (s.chain !== 'btc') return res.status(400).json({ error: 'connect a Bitcoin wallet to settle on signet' });
  try {
    const cfg = SETTLE.resolveNetwork();
    const utxos = await SETTLE.getUtxos(s.address, cfg.apiBase);
    res.json({ ok: true, network: cfg.name, address: s.address, utxos: utxos.map((u) => ({ ref: `${u.txid}:${u.vout}`, value: u.value })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Settlement input-safety helpers (pre-audit hardening).
const DUST = 546; // standard p2wpkh/p2tr dust floor
const isSats = (x) => Number.isInteger(x) && x > 0 && x <= 21e14;
const UTXO_RE = /^[0-9a-f]{64}$/i;
// Fetch an input's REAL value from chain (never trust a caller-supplied value).
async function verifiedInput(u) {
  if (!u || !UTXO_RE.test(String(u.txid)) || !Number.isInteger(u.vout) || u.vout < 0) throw new Error('bad utxo {txid,vout}');
  const value = await SETTLE.getUtxoValue(u.txid, u.vout); // throws if vout missing
  return { txid: u.txid, vout: u.vout, value, address: u.address };
}

// The legacy pre-signed "listing" offer/complete paths are DISABLED — the bare
// SIGHASH_SINGLE|ANYONECANPAY offer can be completed by a malicious buyer so the
// inscription routes back to the seller (pre-audit CRITICAL). All swaps must use
// the routing-verified /api/settlement/build-swap.
app.all(['/api/settlement/offer', '/api/settlement/complete'], (req, res) =>
  res.status(410).json({ error: 'disabled — use /api/settlement/build-swap (routing-verified). The legacy pre-signed offer path was removed for safety.' }));

// Build a ROUTING-VERIFIED atomic swap (dummy-padded, finding #1 fix).
// Requires a VERIFIED wallet session (fund-moving). `self_test:true` builds a
// signet self-swap from the caller's own confirmed UTXOs.
app.post('/api/settlement/build-swap', async (req, res) => {
  if (!SETTLE) return res.status(503).json({ error: 'settlement engine unavailable' });
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'connect a wallet (x-session)' });
  if (s.chain !== 'btc') return res.status(400).json({ error: 'connect a Bitcoin wallet' });
  if (!s.verified) return res.status(403).json({ error: 'wallet signature not verified — settlement requires a verified session (taproot/BIP-322 verification pending)' });
  if (!rateLimit(`swap:${s.agentId}`, 30, 60000)) return res.status(429).json({ error: 'rate limited' });
  try {
    const cfg = SETTLE.resolveNetwork();
    const feeRate = await SETTLE.getFeeRate(cfg.apiBase);
    if (req.body?.self_test) {
      const utxos = (await SETTLE.getUtxos(s.address, cfg.apiBase)).sort((a, b) => a.value - b.value);
      if (utxos.length < 3) return res.status(400).json({ error: `need ≥3 confirmed signet UTXOs for a self-test (have ${utxos.length}); split some faucet coins first` });
      const dummy = utxos[0], inscription = utxos[1], payment = utxos.slice(2);
      const priceSats = Math.max(1000, Math.floor(payment.reduce((a, u) => a + u.value, 0) * 0.3));
      const swap = SETTLE.buildAtomicSwap({
        sellerPayoutAddress: s.address, buyerAddress: s.address,
        inscriptionUtxo: { txid: inscription.txid, vout: inscription.vout, value: inscription.value, address: s.address },
        buyerDummyUtxo: { txid: dummy.txid, vout: dummy.vout, value: dummy.value },
        buyerPaymentUtxos: payment.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        priceSats, feeRate,
      });
      return res.json({ ok: true, network: cfg.name, self_test: true, price_sats: priceSats, ...swap,
        note: 'Routing verified: the inscription sat lands in output[0] (buyer). Sign ALL listed inputs, then broadcast.' });
    }
    // Explicit two-party build — validate + re-derive every value from chain.
    const b = req.body || {};
    const priceSats = Number(b.price_sats);
    if (!isSats(priceSats) || priceSats < DUST) return res.status(400).json({ error: `price_sats must be an integer ≥ ${DUST} sats` });
    if (!Array.isArray(b.buyer_payment) || b.buyer_payment.length < 1 || b.buyer_payment.length > 20) return res.status(400).json({ error: 'buyer_payment must be 1–20 UTXOs' });
    // Fetch real on-chain values; never trust caller-supplied `value`.
    const inscriptionUtxo = await verifiedInput(b.inscription_utxo);
    if (!inscriptionUtxo.address) return res.status(400).json({ error: 'inscription_utxo.address required' });
    if (inscriptionUtxo.value < DUST) return res.status(400).json({ error: 'inscription UTXO below dust' });
    const buyerDummyUtxo = await verifiedInput(b.buyer_dummy);
    if (buyerDummyUtxo.value < DUST) return res.status(400).json({ error: `buyer_dummy must be ≥ ${DUST} sats` });
    const buyerPaymentUtxos = [];
    for (const u of b.buyer_payment) buyerPaymentUtxos.push(await verifiedInput(u));
    const swap = SETTLE.buildAtomicSwap({
      sellerPayoutAddress: b.seller_payout || s.address, buyerAddress: b.buyer_address || s.address,
      inscriptionUtxo, buyerDummyUtxo, buyerPaymentUtxos, priceSats, feeRate,
      inscriptionOffset: Number.isInteger(b.inscription_offset) ? b.inscription_offset : 0,
    });
    res.json({ ok: true, network: cfg.name, ...swap });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Broadcast a fully-signed PSBT. Requires a verified session (was unauthenticated
// open-relay — pre-audit HIGH). Rate-limited per session, not per (spoofable) IP.
app.post('/api/settlement/broadcast', async (req, res) => {
  if (!SETTLE) return res.status(503).json({ error: 'settlement engine unavailable' });
  const s = sessionFromReq(req);
  if (!s || !s.verified) return res.status(403).json({ error: 'verified wallet session required to broadcast' });
  if (!rateLimit(`bcast:${s.agentId}`, 20, 60000)) return res.status(429).json({ error: 'rate limited' });
  const signed = String(req.body?.signed_psbt || '');
  if (!signed) return res.status(400).json({ error: 'signed_psbt required' });
  try {
    const r = await SETTLE.finalizeAndBroadcast(signed);
    const stl = state.settlements.find((x) => x.asset_id === req.body?.asset_id);
    if (stl) { stl.status = 'broadcast'; stl.txid = r.txid; dbExec(`UPDATE al_settlements SET status='broadcast' WHERE id=${sqlVal(stl.id)}`); }
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Register an external agent → returns agent_id + api_key.
app.post('/api/agents/register', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'anon';
  if (!rateLimit(`reg:${ip}`, 20, 60000)) return res.status(429).json({ error: 'rate limited' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name required' });
  let wants = Array.isArray(b.wants) ? b.wants.filter((w) => CATEGORIES.includes(w)) : [];
  if (!wants.length) wants = CATEGORIES.slice();
  let budget = parseFloat(b.budget); if (!Number.isFinite(budget) || budget <= 0) budget = 1; budget = Math.min(budget, 100);
  let aggression = parseFloat(b.aggression); if (!Number.isFinite(aggression)) aggression = 0.7; aggression = Math.max(0, Math.min(1, aggression));
  const agent = {
    id: id('ext'), name: name.slice(0, 40), persona: String(b.persona || 'External AI agent').slice(0, 160),
    avatar: '🛰️', wants, budget: round2(budget), aggression, is_external: 1,
    api_key: 'ak_' + crypto.randomBytes(20).toString('hex'), endpoint: b.endpoint ? String(b.endpoint).slice(0, 200) : null,
  };
  state.agents.push(agent);
  await persistAgent(agent);
  res.json({ ok: true, agent_id: agent.id, api_key: agent.api_key,
    note: 'Store the api_key — it authorizes bids. Poll GET api/market and POST api/bid.' });
});

// Public market snapshot for agents to evaluate.
app.get('/api/market', (req, res) => {
  res.json({
    now: new Date().toISOString(),
    assets: state.assets.filter((a) => a.status === 'looping').map((a) => ({
      asset_id: a.id, name: a.name, type: a.type, collection: a.collection, category: a.category,
      current_ask: round2(a.price > 0 ? a.price : a.reserve), last_clear: a.price, high_water: a.high_water,
      flips: a.flips, verified: a.verified, source_url: a.source_url, image_url: a.image_url,
    })),
  });
});

// Place / update a standing bid (max price) on an asset.
// Auth by EITHER x-agent-key (API agent) OR x-session (connected wallet).
app.post('/api/bid', (req, res) => {
  const agent = resolveParticipant(req);
  if (!agent) return res.status(401).json({ error: 'connect a wallet (x-session) or supply x-agent-key' });
  if (!rateLimit(`bid:${agent.id}`, 120, 60000)) return res.status(429).json({ error: 'rate limited' });
  const asset = state.assets.find((a) => a.id === req.body?.asset_id && a.status === 'looping');
  if (!asset) return res.status(404).json({ error: 'asset not found or not looping' });
  let maxPrice = parseFloat(req.body?.max_price);
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) return res.status(400).json({ error: 'max_price must be > 0' });
  const standing = placeBid(agent, asset, maxPrice);
  res.json({ ok: true, agent: agent.name, wallet: agent.wallet_address ? shortAddr(agent.wallet_address) : null,
    asset: asset.name, standing_max: standing, current_ask: round2(asset.price > 0 ? asset.price : asset.reserve),
    note: 'Bid registered. It competes in the live auction until you are outbid, win, or it expires (15 min).' });
});

app.get('/api/agents/:id', (req, res) => {
  const a = state.agents.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({ id: a.id, name: a.name, is_external: !!a.is_external, budget: a.budget, wants: a.wants,
    holdings: state.assets.filter((x) => x.holder_id === a.id).map((x) => ({ asset_id: x.id, name: x.name, price: x.price })) });
});

// ══════════════════ Agent-discovery beacon ═════════════════════════════════
// A public, machine-readable announcement so autonomous agents hunting for
// digital assets/NFTs can DISCOVER Asset Loop and see what it's seeking:
//  • GET /.well-known/asset-loop.json  — cold discovery manifest (crawlable)
//  • GET /api/beacon                    — same manifest snapshot
//  • GET /api/beacon/stream (SSE)       — a live "ping" every 15s to subscribers
// The manifest lists live assets seeking buyers + exactly how to register + bid.
const PUBLIC_BASE = process.env.ASSET_LOOP_PUBLIC_URL || 'https://build-63e0680f0f405dd3ab519785.emblem.build/pub/main/asset-loop';
const beacon = { pings: 0, lastPing: null, sse: new Set(), since: new Date().toISOString() };

function buildBeacon() {
  const looping = state.assets.filter((a) => a.status === 'looping');
  const demand = {};
  for (const a of looping) demand[a.category] = (demand[a.category] || 0) + 1;
  return {
    service: 'Asset Loop',
    kind: 'ordinals-counterparty-consignment-marketplace',
    a2a: true, // agent-to-agent friendly
    description: 'Continuous consignment-loop marketplace for Counterparty (XCP) and Ordinals (BTC) assets. Consign an asset; AI agents negotiate and flip it to whoever bids highest, looping upward. Agents welcome to register and bid.',
    url: PUBLIC_BASE,
    endpoints: {
      register_agent: `${PUBLIC_BASE}/api/agents/register`,   // POST {name,persona,budget,wants[]} -> {agent_id, api_key}
      wallet_auth: `${PUBLIC_BASE}/api/auth/challenge`,        // GET ?address=&chain= then POST /api/auth/verify
      market: `${PUBLIC_BASE}/api/market`,                     // GET live assets + current asks
      bid: `${PUBLIC_BASE}/api/bid`,                           // POST {asset_id,max_price} (x-agent-key or x-session)
      settlement: `${PUBLIC_BASE}/api/settlement/config`,      // non-custodial atomic swap (signet/regtest proven)
      beacon_stream: `${PUBLIC_BASE}/api/beacon/stream`,       // SSE live pings
    },
    seeking_categories: Object.keys(demand),
    live_assets: looping.map((a) => ({
      asset_id: a.id, name: a.name, type: a.type, collection: a.collection, category: a.category,
      current_ask_btc: round2(a.price > 0 ? a.price : a.reserve), verified: a.verified, flips: a.flips,
    })),
    stats: { active_loops: looping.length, agents: state.agents.length, total_flips: state.sales.length },
    ping: beacon.pings,
    ts: new Date().toISOString(),
  };
}

app.get('/api/beacon', (req, res) => res.json(buildBeacon()));
app.get('/.well-known/asset-loop.json', (req, res) => res.json(buildBeacon()));
app.get('/api/beacon/stream', (req, res) => {
  if (beacon.sse.size >= 500) return res.status(503).json({ error: 'beacon at capacity' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: hello\ndata: ${JSON.stringify(buildBeacon())}\n\n`);
  beacon.sse.add(res);
  req.on('close', () => beacon.sse.delete(res));
});

// Emit a discovery ping every 15s to all subscribed agents.
setInterval(() => {
  beacon.pings += 1; beacon.lastPing = new Date().toISOString();
  const payload = `event: ping\ndata: ${JSON.stringify(buildBeacon())}\n\n`;
  for (const res of beacon.sse) { try { res.write(payload); } catch (e) { beacon.sse.delete(res); } }
}, 15000);

app.use(express.static(path.join(__dirname, 'public')));

boot().then(() => app.listen(PORT, () => console.log(`Asset Loop v2 on ${PORT}`)))
  .catch((e) => { console.error('boot failed:', e); app.listen(PORT, () => console.log(`Asset Loop on ${PORT} (degraded)`)); });
