// UI wiring for Land Rush. Ownership is the ledger's (land.js mirrors it);
// this file reads the authenticated-map chain's finalized commands, submits
// claims, and draws the map.

import { CONFIG } from './config.js';
import { Land, claimStatement, openKey, seasonOf, tileKey } from './land.js';
import { Renderer, ownerColor } from './render.js';
import { proveTile } from './proofs.js';
import { ACCOUNTS, applyProxy, withQuery } from '../../shared/config.js';
import { AUTHMAP_TOPIC, putIfAbsentEnvelope } from '../../shared/authmap.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { proveProfile } from '../../shared/proofs.js';
import { ProofPanel, esc, reportReachability, toast, txLink } from '../../shared/ui.js';
import { ed25519Supported, toHex, utf8 } from '../../shared/crypto.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
const panel = new ProofPanel();
const renderer = new Renderer($('map'), CONFIG);
$('back').href = withQuery('../');

const ui = {
  mode: 'claim',
  hover: null,
  pending: new Map(), // "c,r" → owner id, for the spinner
  pendingByMessage: new Map(), // messageId → { key, submitted }
  recent: [], // block timestamps of claims, for claims/s
  status: null,
  anchor: null,
  sealGlow: 0,
  ready: false, // quiet while replaying history
  opening: false,
};
let land = null;
let stopWatch = null;
const me = () => session.commander?.id ?? null;
const tileName = (c, r) => land.map[r * CONFIG.cols + c].name;

// ---------------------------------------------------------------- seasons

async function enterSeason(season) {
  stopWatch?.();
  ui.ready = false;
  land = new Land(CONFIG, ACCOUNTS, season);
  ui.pending.clear();
  ui.pendingByMessage.clear();
  $('feed').innerHTML = '';
  stopWatch = ledger.watch(CONFIG.chain, AUTHMAP_TOPIC, 0, sync);
  await sync();
  ui.ready = true;
  renderAll();
}

function showResults(finished) {
  const rows = finished.standings();
  $('results-title').textContent = `Season ${finished.season % 100000} complete`;
  $('podium').innerHTML = rows.length
    ? rows.slice(0, 8).map((r, i) => `<li>${i === 0 ? '🏆' : `${i + 1}.`} <span style="color:${ownerColor(r.id, me())}">${esc(r.id)}</span>
        <span class="n">${r.tiles} tiles · realm ${r.realm} · ${r.score}</span></li>`).join('')
    : '<li class="small">Nobody claimed land this season.</li>';
  $('results-note').textContent = `Every browser computed this from ${finished.claims} claims the ledger accepted first.`;
  $('results').hidden = false;
}

let switching = false;
async function tickSeason() {
  if (!land || switching) return;
  const now = Date.now();
  if (seasonOf(CONFIG, now) !== land.season && now - land.end > 2500) {
    switching = true;
    await sync();
    if (land.players.size) showResults(land);
    await enterSeason(seasonOf(CONFIG, now));
    switching = false;
  }
  renderTop();
}

// ---------------------------------------------------------------- the log

let syncing = null;
let again = false;
async function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    do {
      again = false;
      const l = land;
      const entries = await ledger.entriesFrom(CONFIG.chain, AUTHMAP_TOPIC, l.position.height);
      const receipt = (id) => ledger.authmapReceipt(CONFIG.chain, id).then((r) => r?.record ?? null);
      for (const entry of entries) {
        const result = await l.apply(entry, { receipt });
        if (!result.skipped) for (const o of result.outcomes) onOutcome(l, entry, o);
      }
    } while (again);
  })();
  try {
    await syncing;
    $('banner').hidden = true;
  } catch (error) {
    reportReachability($('banner'), error);
  } finally {
    syncing = null;
  }
  renderAll();
}

function onOutcome(l, entry, o) {
  const color = (id) => ownerColor(id, me());
  const who = (id) => `<b style="color:${color(id)}">${esc(id)}</b>`;
  if (o.kind === 'opened') {
    feed(`Season ${l.season % 100000} opened — its land comes from block #${entry.height}`, entry.height);
    return;
  }
  const mine = ui.pendingByMessage.get(entry.messageId);
  if (mine) {
    ui.pendingByMessage.delete(entry.messageId);
    ui.pending.delete(mine.key);
  }
  const ms = mine ? `${((Date.now() - mine.submitted) / 1000).toFixed(1)} s` : '';
  if (o.kind === 'claimed') {
    ui.recent.push(entry.timestamp);
    if (ui.ready) renderer.plant(o.c, o.r);
    feed(`${who(o.id)} ${o.capital ? 'founded a capital at' : 'claimed'} ${esc(tileName(o.c, o.r))}
      <span class="small">${CONFIG.terrain[l.map[o.r * CONFIG.cols + o.c].terrain].name.toLowerCase()}</span>`, entry.height, ms);
    if (mine) {
      $('lat').textContent = ms;
      toast(`Flag planted on ${tileName(o.c, o.r)} — final in ${ms}`, 'win');
    }
  } else if (o.kind === 'lost') {
    const holder = o.holder?.owner ?? 'a scorched claim';
    if (mine) toast(`${holder} reached ${tileName(o.c, o.r)} first — the ledger refused your claim (ALREADY_EXISTS)`, 'lost');
    if (mine || ui.ready) feed(`${o.id ? who(o.id) : 'someone'} lost the race for ${esc(tileName(o.c, o.r))} to ${esc(holder)}`, entry.height, '', 'lost');
  } else if (o.kind === 'scorched') {
    feed(`${esc(tileName(o.c, o.r))} scorched: ${esc(o.reason)}`, entry.height, '', 'lost');
    if (mine) toast(`Your claim on ${tileName(o.c, o.r)} doesn’t count: ${o.reason}`, 'lost');
  }
}

function feed(html, height, ms = '', cls = '') {
  const list = $('feed');
  list.insertAdjacentHTML('afterbegin',
    `<li class="${cls}"><span class="h">#${height}</span><span>${html}</span><span class="ms">${ms}</span></li>`);
  while (list.children.length > 16) list.lastElementChild.remove();
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(CONFIG.chain), ledger.anchor(CONFIG.chain)]);
    if (anchor && ui.anchor && anchor.anchoredHeight > ui.anchor.anchoredHeight) {
      ui.sealGlow = 1;
      toast(`⚓ The map is sealed on Cardano · block #${anchor.anchoredHeight}`);
    }
    ui.status = status;
    ui.anchor = anchor ?? ui.anchor;
    renderSide();
  } catch (error) {
    reportReachability($('banner'), error);
  }
}

// ---------------------------------------------------------------- claiming

const minePending = () => [...ui.pending.values()].filter((id) => id === me()).length;

async function openSeason() {
  if (ui.opening || land.seed) return;
  if (!session.commander) { session.open(); return; }
  ui.opening = true;
  renderTop();
  try {
    const envelope = putIfAbsentEnvelope(CONFIG.collection, utf8(openKey(CONFIG, land.season)), utf8('open'));
    await ledger.submit(CONFIG.chain, session.relay, AUTHMAP_TOPIC, { bodyHex: toHex(envelope) });
    for (let i = 0; i < 60 && !land.seed; i++) { await new Promise((r) => setTimeout(r, 250)); await sync(); }
  } catch (error) {
    toast(`Could not open the season: ${error.message}`, 'info');
  } finally {
    ui.opening = false;
    renderAll();
  }
}

async function claim(c, r) {
  const c0 = session.commander;
  if (!c0) { session.open(); return; }
  const key = `${c},${r}`;
  if (land.tiles.has(key) || ui.pending.has(key)) { inspect(c, r); return; }
  if (!land.claimable(c0.id, c, r)) { toast('After your capital, claims must touch your land', 'info'); return; }
  if (land.staminaAt(c0.id, Date.now()) - minePending() < 1) { toast('Out of stamina — it refills every 4 s', 'info'); return; }
  if (Date.now() >= land.end) { toast('This season has ended', 'info'); return; }
  try {
    const sig = await c0.sign(claimStatement(CONFIG, land.season, land.seed, c, r, c0.id));
    const value = utf8(JSON.stringify({ v: 1, id: c0.id, pub: c0.pub, sig }));
    const envelope = putIfAbsentEnvelope(CONFIG.collection, utf8(tileKey(CONFIG, land.season, land.seed, c, r)), value);
    ui.pending.set(key, c0.id);
    const submitted = Date.now();
    const { messageId } = await ledger.submit(CONFIG.chain, session.relay, AUTHMAP_TOPIC, { bodyHex: toHex(envelope) });
    ui.pendingByMessage.set(messageId, { key, submitted });
  } catch (error) {
    ui.pending.delete(key);
    toast(`Claim failed: ${error.message}`, 'info');
  }
}

function inspect(c, r) {
  const t = land.map[r * CONFIG.cols + c];
  const tile = land.tiles.get(`${c},${r}`);
  const terrain = CONFIG.terrain[t.terrain];
  const status = tile?.owner
    ? `claimed by <b style="color:${ownerColor(tile.owner, me())}">${esc(tile.owner)}</b> at block #${tile.height}`
      + (land.players.get(tile.owner)?.capital === `${c},${r}` ? ' — their capital' : '')
    : tile?.scorched ? `scorched at block #${tile.height}: ${esc(tile.reason)}` : 'free';
  const body = panel.open(t.name, `
    <dl class="facts">
      <dt>Terrain</dt><dd>${terrain.name} · worth ${terrain.value}</dd>
      <dt>Status</dt><dd>${status}</dd>
      <dt>Ledger key</dt><dd class="mono">${esc(CONFIG.collection)} / ${esc(tileKey(CONFIG, land.season, land.seed, c, r))}</dd>
    </dl>
    <div class="row">
      <button class="btn primary" id="prove-tile">${tile?.owner ? `Prove ${esc(tile.owner)} holds it` : tile ? 'Prove the scorched claim' : 'Prove it is still free'}</button>
      ${tile?.owner ? `<button class="btn" id="prove-owner">Prove ${esc(tile.owner)}’s profile</button>` : ''}
    </div>
    <div class="proof-out"></div>`);
  const threshold = ui.status?.threshold ?? 1;
  body.querySelector('#prove-tile').onclick = () => panel.run(
    () => proveTile(CONFIG, ledger, land, c, r, { threshold }),
    tile?.owner ? `${tile.owner}’s claim on ${t.name}` : tile ? `the scorched claim on ${t.name}` : `That ${t.name} was unclaimed`);
  if (tile?.owner) {
    body.querySelector('#prove-owner').onclick = () => panel.run(
      () => proveProfile(ledger, session.profiles, tile.owner, { threshold, expectPub: land.players.get(tile.owner)?.pub }),
      `${tile.owner}’s profile`);
  }
}

// ---------------------------------------------------------------- panels

function renderTop() {
  if (!land) return;
  const left = Math.max(0, land.end - Date.now());
  const hms = `${Math.floor(left / 3_600_000)}:${String(Math.floor((left % 3_600_000) / 60_000)).padStart(2, '0')}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  const free = land.map ? land.map.length - land.tiles.size : 0;
  $('season').innerHTML = land.seed
    ? `Season <b>${land.season % 100000}</b> · land from block <b>#${land.seededBy.height}</b> · <b>${free}</b> free tiles · ends in <b>${hms}</b>`
    : `Season <b>${land.season % 100000}</b> · not opened yet · ends in <b>${hms}</b>`;
  const id = me();
  const hint = !land.seed
    ? (ui.opening ? 'Opening the season — its land comes from the block that finalizes this…'
      : 'This season isn’t open yet. Open it: the block that finalizes your opening seeds the land, so nobody could plan it.')
    : ui.mode === 'inspect' ? 'Click any tile: prove who holds it — or prove that nobody does — against the Cardano anchor.'
      : !id ? 'Sign in to claim land — or watch the rush.'
        : !land.players.has(id) ? 'Your first claim is your capital: pick any free tile. Crystal is worth 5.'
          : 'Click a glowing tile next to your land. First claim wins — the ledger refuses the second.';
  $('hint').innerHTML = esc(hint) + (!land.seed && !ui.opening ? ' <button class="btn primary" id="open">Open the season</button>' : '');
  $('open')?.addEventListener('click', openSeason);
  const since = Date.now() - 10_000;
  ui.recent = ui.recent.filter((t) => t > since);
  $('cps').textContent = (ui.recent.length / 10).toFixed(1);
}

function renderSide() {
  const s = ui.status;
  if (s) $('fin').textContent = `${s.threshold} of ${s.members}`;
  const a = ui.anchor;
  if (a) {
    $('anchor').innerHTML = `The map is sealed through block <b>#${a.anchoredHeight.toLocaleString()}</b> of
      <code>${esc(CONFIG.chain)}</code> · tx ${txLink(a.transactionHash)}`;
  }
  const c = session.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c && land) {
    const p = land.players.get(c.id);
    $('avatar').textContent = c.id[0];
    $('me-name').textContent = c.id;
    $('me-sub').textContent = p
      ? `capital at ${land.map ? tileName(...p.capital.split(',').map(Number)) : '—'} · ${p.tiles} tiles`
      : 'no capital yet — your first claim can be anywhere';
  }
}

function renderBoard() {
  if (!land?.map) { $('board').innerHTML = '<li class="small empty">The season hasn’t opened.</li>'; return; }
  const rows = land.standings();
  $('board').innerHTML = rows.slice(0, 10).map((r) => `<li class="${r.id === me() ? 'me' : ''}">
      <span class="dot" style="background:${ownerColor(r.id, me())}"></span><span>${esc(r.id)}</span>
      <span class="n">${r.tiles} tiles</span><span class="n">${r.score}</span></li>`).join('')
    || '<li class="small empty">No land claimed yet. Found a capital!</li>';
}

function renderStamina() {
  const c = session.commander;
  if (!c || !land) return;
  const st = CONFIG.stamina;
  const n = Math.max(0, land.staminaAt(c.id, Date.now()) - minePending());
  $('stamina-label').textContent = `Stamina — one claim every ${st.regenMs / 1000} s, bank up to ${st.max}`;
  $('stamina').innerHTML = Array.from({ length: st.max }, (_, i) => `<i class="${i < n ? 'full' : ''}"></i>`).join('');
}

function renderAll() { renderTop(); renderSide(); renderBoard(); renderStamina(); }

function frame() {
  renderer.frame(land, { me: me(), mode: ui.mode, hover: ui.hover, pending: ui.pending, sealGlow: ui.sealGlow });
  ui.sealGlow = Math.max(0, ui.sealGlow - 0.008);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- input

const map = $('map');
const point = (e) => { const r = map.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
map.addEventListener('mousemove', (e) => { ui.hover = land?.map ? renderer.tileAt(...point(e)) : null; });
map.addEventListener('mouseleave', () => { ui.hover = null; });
map.addEventListener('click', (e) => {
  if (!land?.map) return;
  const at = renderer.tileAt(...point(e));
  if (!at) return;
  if (ui.mode === 'inspect') inspect(...at); else claim(...at);
});
document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
function setMode(mode) {
  ui.mode = mode;
  document.querySelectorAll('#modes button').forEach((x) => {
    x.classList.toggle('on', x.dataset.m === mode);
    x.setAttribute('aria-checked', String(x.dataset.m === mode));
  });
  renderTop();
}
addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, select, textarea')) return;
  if (e.key === 'i') setMode(ui.mode === 'inspect' ? 'claim' : 'inspect');
});
$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (e) => { session.relay = Number(e.target.value); });
$('open-auth').addEventListener('click', () => session.open());
$('signout').addEventListener('click', () => { session.signOut(); session.open('signin'); });
$('results-close').addEventListener('click', () => { $('results').hidden = true; });
$('legend').innerHTML = CONFIG.terrain.map((t) => `<span style="--c:${t.color}">${t.name} ${t.value}</span>`).join('');
$('score-rule').textContent = `score = land value + ${CONFIG.realmBonus} × your largest connected realm`;

// ---------------------------------------------------------------- start

if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
session.onChange(renderAll);
await session.restore();
requestAnimationFrame(frame);
await Promise.all([refreshMeta(), enterSeason(seasonOf(CONFIG, Date.now()))]);
setInterval(tickSeason, 1000);
setInterval(refreshMeta, 3000);
setInterval(() => { renderStamina(); renderBoard(); renderSide(); }, 500);
