// UI wiring for Reef. The world rules are reef.js; this file keeps the season
// in step with the ledger, grows the world to "now" (or to any generation you
// travel back to), and places signed patterns where you click.

import { CONFIG } from './config.js';
import { PATTERNS, Reef, Timeline, census, seasonOf, seasonTopic, seedStatement, shape, worldHash } from './reef.js';
import { Renderer, drawChart } from './render.js';
import { provePlacement, proveWorld } from './proofs.js';
import { applyProxy, withQuery } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { ProofPanel, esc, reportReachability, toast } from '../../shared/ui.js';
import { ed25519Supported } from '../../shared/crypto.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
const panel = new ProofPanel();
const renderer = new Renderer($('world'), CONFIG);
$('back').href = withQuery('../');

const ORDER = Object.keys(PATTERNS);
const rgb = (s) => `rgb(${CONFIG.species[s].color.join(',')})`;
const ui = {
  pattern: 'glider',
  rot: 0,
  hover: null,
  viewGen: null, // null = live
  playing: false,
  playFrom: 0,
  pending: new Map(), // messageId → { x, y }
  nonce: 0,
  status: null,
  ready: false,
  shownGen: 0,
  shownCells: null,
  hashAt: -1,
  opening: false,
};
let reef = null;
let timeline = null;
let stopWatch = null;
const me = () => session.commander?.id ?? null;
const mySpecies = () => (reef && me() ? reef.speciesOf(me()) : null);
const nextNonce = () => (ui.nonce = Math.max(Date.now(), ui.nonce + 1));
const liveGen = (now = Date.now()) => (reef?.origin
  ? Math.max(0, Math.min(reef.lastGen, Math.floor((now - reef.origin.timestamp) / CONFIG.genMs))) : 0);

// ---------------------------------------------------------------- the season

async function enterSeason(season) {
  stopWatch?.();
  ui.ready = false;
  ui.viewGen = null;
  ui.playing = false;
  reef = new Reef(CONFIG, season);
  timeline = new Timeline(CONFIG, reef);
  stopWatch = ledger.watch(CONFIG.movesChain, seasonTopic(CONFIG, season), 0, sync, 1500);
  await sync();
  ui.ready = true;
  renderSide();
}

let syncing = null;
let again = false;
async function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    do {
      again = false;
      const r = reef;
      const entries = await ledger.entriesFrom(CONFIG.movesChain, seasonTopic(CONFIG, r.season), r.position.height);
      for (const entry of entries) {
        if (r !== reef) return;
        let result;
        try {
          result = await r.apply(entry, session.profiles.check);
        } catch {
          setTimeout(sync, 800); // waiting on the profile chain: retry, in order
          break;
        }
        if (!result.skipped) onApplied(entry, result);
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
  renderSide();
}

function onApplied(entry, result) {
  const mine = ui.pending.get(entry.messageId);
  if (mine) ui.pending.delete(entry.messageId);
  if (result.kind === 'seed' && result.accepted) {
    const p = result.placement;
    timeline.invalidateFrom(p.gen);
    if (ui.ready && ui.viewGen === null) renderer.ripple(p.x, p.y, p.species);
    if (mine) {
      const lag = liveGen() - p.gen;
      toast(`${PATTERNS[p.pattern].name} is final at block #${p.height} — it joined at generation ${p.gen}${lag > 0 ? ` (${lag} behind now)` : ''}`, 'info');
    }
  } else if (mine && !result.accepted) {
    toast(`Your placement was refused: ${result.reason}`, 'info');
  }
}

// ---------------------------------------------------------------- placing

async function place(x, y) {
  const c = session.commander;
  if (!c) { session.open(); return; }
  if (ui.viewGen !== null) { toast('You are looking at the past — press LIVE to place', 'info'); return; }
  if (!reef.origin) { await openSeason(); }
  const player = reef.players.get(c.id);
  const have = player ? reef.spores(player, Date.now()) : CONFIG.spores.start;
  if (PATTERNS[ui.pattern].cost > have - pendingCost()) { toast('Not enough spores — they regrow one every 3 s', 'info'); return; }
  if (!player && reef.players.size >= CONFIG.maxPlayers) { toast('This season’s reef already has six species', 'info'); return; }
  const n = nextNonce();
  const { pattern, rot } = ui;
  const sig = await c.sign(seedStatement(CONFIG, reef.season, c.id, n, pattern, x, y, rot));
  try {
    const body = JSON.stringify({ t: 'seed', id: c.id, pub: c.pub, n, pattern, x, y, rot, sig });
    const { messageId } = await ledger.submit(CONFIG.movesChain, session.relay, seasonTopic(CONFIG, reef.season), { body });
    ui.pending.set(messageId, { x, y, cost: PATTERNS[pattern].cost });
  } catch (error) {
    toast(`Could not place: ${error.message}`, 'info');
  }
}

const pendingCost = () => [...ui.pending.values()].reduce((s, p) => s + p.cost, 0);

async function openSeason() {
  if (ui.opening || reef.origin) return;
  ui.opening = true;
  try {
    await ledger.submit(CONFIG.movesChain, session.relay, seasonTopic(CONFIG, reef.season), { body: '{"t":"open"}' });
    for (let i = 0; i < 60 && !reef.origin; i++) { await new Promise((r) => setTimeout(r, 250)); await sync(); }
  } catch (error) {
    toast(`Could not open the season: ${error.message}`, 'info');
  } finally {
    ui.opening = false;
  }
}

// ---------------------------------------------------------------- drawing

let lastFrame = performance.now();
/** Grow (or rebuild) the world towards the generation on show. Runs per frame, and from a timer when frames pause. */
function advance(dt) {
  if (!reef?.origin) return null;
  const live = liveGen();
  if (ui.viewGen !== null && ui.playing) {
    ui.playFrom += dt / CONFIG.genMs * 4; // history plays at 4× speed
    ui.viewGen = Math.min(live, Math.floor(ui.playFrom));
    if (ui.viewGen >= live) { ui.viewGen = null; ui.playing = false; }
  }
  const target = ui.viewGen ?? live;
  let cells = timeline.at(target, 600);
  if (cells) {
    ui.shownGen = target;
    ui.shownCells = cells;
    $('catchup').hidden = true;
  } else {
    cells = timeline.head?.cells ?? ui.shownCells;
    ui.shownGen = timeline.head?.gen ?? ui.shownGen;
    $('catchup').hidden = false;
    $('catchup').textContent = `rebuilding the reef from the log… generation ${ui.shownGen.toLocaleString()} of ${target.toLocaleString()}`;
  }
  return cells;
}

function frame(t) {
  const dt = t - lastFrame;
  lastFrame = t;
  const cells = advance(dt);
  const species = mySpecies();
  const hover = ui.hover && ui.viewGen === null && reef?.origin
    ? { ...ui.hover, pattern: ui.pattern, rot: ui.rot, species: species ?? Math.min(reef.players.size + 1, 6) } : null;
  renderer.frame({ cells, now: t, hover, past: ui.viewGen !== null,
    pending: [...ui.pending.values()].map((p) => ({ ...p, species: species ?? 1 })) });
  requestAnimationFrame(frame);
}

function renderTop() {
  const now = Date.now();
  const end = reef ? reef.end : 0;
  const left = Math.max(0, end - now);
  $('season').innerHTML = reef ? `season <b>${reef.season % 10000}</b> · ends in <b>${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}</b>` : '';
  $('opening').hidden = !ui.ready || !!reef?.origin;
  if (!reef?.origin) return;
  const live = liveGen(now);
  $('gen').textContent = ui.shownGen.toLocaleString();
  if (ui.shownCells && ui.hashAt !== ui.shownGen) { ui.hashAt = ui.shownGen; $('hash').textContent = worldHash(ui.shownCells).slice(0, 10); }
  const scrub = $('scrub');
  scrub.max = String(live);
  if (document.activeElement !== scrub) scrub.value = String(ui.viewGen ?? live);
  $('live').classList.toggle('on', ui.viewGen === null);
  $('playpause').textContent = ui.playing ? '⏸' : '▶';
  const secs = (ui.shownGen * CONFIG.genMs) / 1000;
  $('when').textContent = `${Math.floor(secs / 60)}:${String(Math.floor(secs) % 60).padStart(2, '0')} into the season`;
  $('travel').hidden = ui.viewGen === null;
  $('travel').textContent = `◀ TIME TRAVEL · generation ${ui.shownGen.toLocaleString()} of ${live.toLocaleString()} · rebuilt from the log`;
  renderSpecies();
  drawChart($('chart'), CONFIG, timeline.populations, Math.max(1, reef.lastGen), ui.shownGen);
}

function renderSpecies() {
  const counts = ui.shownCells ? census(ui.shownCells) : new Array(8).fill(0);
  const rows = [...reef.players.values()].map((p) => ({ s: p.species, name: p.id, pop: counts[p.species], me: p.id === me() }))
    .sort((a, b) => b.pop - a.pop);
  rows.push({ s: 7, name: 'wild soup', pop: counts[7], me: false });
  $('species').innerHTML = rows.map((r) => `<li class="${r.me ? 'me' : ''}"><span class="sw" style="background:${rgb(r.s)}"></span>
    ${esc(r.name)}${r.me ? ' (you)' : ''}<span class="pop">${r.pop.toLocaleString()}</span></li>`).join('');
  const over = Date.now() >= reef.end && reef.players.size;
  if (over && !ui.toldWinner && ui.shownGen === reef.lastGen) {
    ui.toldWinner = true;
    toast(`Season over — ${rows[0].name}’s reef is the largest`);
  }
}

let lastSide = '';
function renderSide() {
  const c = session.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c) {
    $('avatar').textContent = c.id[0];
    $('avatar').style.background = mySpecies() ? rgb(mySpecies()) : '';
    $('me-name').textContent = c.id;
    $('me-key').textContent = `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`;
  }
  if (!reef) return;
  const player = c ? reef.players.get(c.id) : null;
  const have = Math.max(0, (player ? reef.spores(player, Date.now()) : CONFIG.spores.start) - pendingCost());
  $('meter').innerHTML = Array.from({ length: CONFIG.spores.max }, (_, i) => `<i class="${i < have ? 'full' : ''}"></i>`).join('');
  const key = JSON.stringify([ui.pattern, have, reef.placements.length, me()]);
  if (key === lastSide) return;
  lastSide = key;
  $('palette').innerHTML = ORDER.map((id) => `<button class="pat ${ui.pattern === id ? 'on' : ''} ${PATTERNS[id].cost > have ? 'off' : ''}" data-p="${id}" title="${PATTERNS[id].note}">
    <canvas data-mini="${id}" width="88" height="60"></canvas><span class="name">${PATTERNS[id].name}</span><span class="cost">${PATTERNS[id].cost} spore${PATTERNS[id].cost > 1 ? 's' : ''}</span></button>`).join('');
  for (const cv of document.querySelectorAll('[data-mini]')) mini(cv, cv.dataset.mini);
  $('placements').innerHTML = reef.placements.slice(-14).reverse().map((p, i) => `<li><span class="sw" style="background:${rgb(p.species)}"></span>
    ${esc(p.id)} · ${PATTERNS[p.pattern].name}<span class="g">gen ${p.gen}</span>
    <button class="link" data-go="${p.gen}">◷</button><button class="link" data-prove="${reef.placements.length - 1 - i}">prove</button></li>`).join('')
    || '<li class="small">Nothing placed yet this season. Click the reef to drop a pattern.</li>';
}

function mini(canvas, id) {
  const ctx = canvas.getContext('2d');
  const cells = shape(id, 0);
  const w = Math.max(...cells.map((c) => c[0])) + 1;
  const h = Math.max(...cells.map((c) => c[1])) + 1;
  const s = Math.min(canvas.width / (w + 1), canvas.height / (h + 1));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = mySpecies() ? rgb(mySpecies()) : '#3ee6ff';
  for (const [x, y] of cells) ctx.fillRect((canvas.width - w * s) / 2 + x * s, (canvas.height - h * s) / 2 + y * s, s - 0.6, s - 0.6);
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(CONFIG.movesChain), ledger.anchor(CONFIG.movesChain)]);
    ui.status = status;
    $('blk').textContent = `#${status.tipHeight.toLocaleString()}`;
    $('sealed').textContent = anchor ? `#${anchor.anchoredHeight.toLocaleString()}` : '—';
  } catch (error) {
    reportReachability($('banner'), error);
  }
}

function travelTo(gen) {
  const live = liveGen();
  ui.viewGen = gen >= live ? null : Math.max(0, gen);
  ui.playing = false;
}

// ---------------------------------------------------------------- input

const world = $('world');
world.addEventListener('mousemove', (e) => {
  const cell = renderer.cellAt(e.clientX, e.clientY);
  ui.hover = cell ? { x: cell[0], y: cell[1] } : null;
});
world.addEventListener('mouseleave', () => { ui.hover = null; });
world.addEventListener('click', (e) => {
  const cell = renderer.cellAt(e.clientX, e.clientY);
  if (cell && reef) place(cell[0], cell[1]);
});
$('palette').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (b) { ui.pattern = b.dataset.p; lastSide = ''; renderSide(); }
});
$('rotate').addEventListener('click', () => { ui.rot = (ui.rot + 1) % 4; });
$('scrub').addEventListener('input', (e) => travelTo(Number(e.target.value)));
$('live').addEventListener('click', () => travelTo(Infinity));
$('rewind').addEventListener('click', () => travelTo(0));
$('playpause').addEventListener('click', () => {
  if (ui.playing) { ui.playing = false; return; }
  if (ui.viewGen === null) ui.viewGen = 0;
  ui.playFrom = ui.viewGen;
  ui.playing = true;
});
$('placements').addEventListener('click', (e) => {
  const g = e.target.dataset?.go;
  const i = e.target.dataset?.prove;
  if (g !== undefined) travelTo(Number(g));
  if (i !== undefined) {
    const p = reef.placements[Number(i)];
    panel.open(`${PATTERNS[p.pattern].name} by ${p.id}`, `
      <dl class="facts"><dt>Where</dt><dd>${p.x}, ${p.y} · rotated ${p.rot * 90}°</dd>
        <dt>When</dt><dd>generation ${p.gen} · block #${p.height}</dd></dl><div class="proof-out"></div>`);
    panel.run(() => provePlacement(CONFIG, ledger, reef, p, { threshold: ui.status?.threshold ?? 1 }), 'This placement');
  }
});
$('prove-world').addEventListener('click', () => {
  if (!reef?.origin || !ui.shownCells) return;
  const gen = ui.shownGen;
  const cells = ui.shownCells.slice();
  panel.open(`The reef at generation ${gen.toLocaleString()}`, `
    <dl class="facts"><dt>Season</dt><dd>${reef.season} · opened at block #${reef.origin.height}</dd>
      <dt>World hash</dt><dd class="mono">${worldHash(cells)}</dd></dl><div class="proof-out"></div>`);
  panel.run(() => proveWorld(CONFIG, ledger, reef, gen, cells, { threshold: ui.status?.threshold ?? 1 }), 'This world');
});
$('open-season').addEventListener('click', () => (session.commander ? openSeason() : session.open()));
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.key === 'r' || e.key === 'R') ui.rot = (ui.rot + 1) % 4;
  else if (e.key === 'l' || e.key === 'L') travelTo(Infinity);
  else if (e.key === ' ') { e.preventDefault(); $('playpause').click(); }
  else if (/^[1-6]$/.test(e.key)) { ui.pattern = ORDER[Number(e.key) - 1]; lastSide = ''; renderSide(); }
});
$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (e) => { session.relay = Number(e.target.value); });
$('open-auth').addEventListener('click', () => session.open());
$('signout').addEventListener('click', () => { session.signOut(); session.open('signin'); });

// ---------------------------------------------------------------- start

if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
session.onChange(() => { lastSide = ''; renderSide(); });
await session.restore();
requestAnimationFrame(frame);
await Promise.all([refreshMeta(), enterSeason(seasonOf(CONFIG, Date.now()))]);
setInterval(() => {
  if (seasonOf(CONFIG, Date.now()) !== reef.season && ui.viewGen === null && Date.now() > reef.end + 15_000) {
    toast('A new reef season begins', 'info');
    enterSeason(seasonOf(CONFIG, Date.now()));
    return;
  }
  renderSide();
}, 1000);
setInterval(() => {
  if (performance.now() - lastFrame > 500) advance(250); // frames are paused (a background tab): keep growing the world
  renderTop();
}, 250);
setInterval(refreshMeta, 5000);
