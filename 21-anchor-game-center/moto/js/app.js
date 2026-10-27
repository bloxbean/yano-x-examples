// UI wiring for Neon Rush. The physics are sim.js and the verification is
// races.js; this file runs the fixed 60 Hz loop, records your inputs, posts a
// signed split at each checkpoint so rivals see you live, races the ghosts of
// the fastest rides, submits finished rides and keeps the leaderboard in step
// with the ledger.

import { loadTopicConfiguration, NeonTopicSession } from './topic-session.js';
import { CONFIG } from './config.js';
import { BRAKE, CHECKPOINTS, FPS, LAP, LAPS, LEFT, MAX_FRAMES, RIGHT, Run, THROTTLE, Track, autopilot, lapTime } from './sim.js';
import { Circuit, inputsHash, runStatement, seasonOf, seasonTopic, splitStatement } from './races.js';
import { Renderer } from './render.js';
import { proveRun } from './proofs.js';
import { encodeInputs } from '../../arcade/js/runs.js';
import { applyProxy, withQuery } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { ProofPanel, esc, reportReachability, toast, txLink } from '../../shared/ui.js';
import { blake2b } from '../../shared/blake2b.js';
import { ed25519Supported, toHex, utf8 } from '../../shared/crypto.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
let topicSession = null;
let topicSetupError = null;
try { topicSession = new NeonTopicSession(await loadTopicConfiguration(CONFIG)); }
catch (error) { topicSetupError = error.message; }
const submitMove = (season, body) => {
  if (!topicSession) throw new Error(topicSetupError);
  return topicSession.submit(ledger, session.relay, session.commander, seasonTopic(CONFIG, season), body);
};
const panel = new ProofPanel();
const renderer = new Renderer($('road'));
$('back').href = withQuery('../');

const STEP_MS = 1000 / FPS;
const GHOST_COLORS = ['#3ee6ff', '#ffb020', '#7dff6a', '#a78bff'];
const DEMO = new Track(blake2b(utf8(`${CONFIG.app}|demo`), 16)); // attract mode before a season opens
const CP = LAP / CHECKPOINTS;

const ui = {
  mode: 'attract', // attract | countdown | play | submitting | watch
  run: new Run(DEMO),
  frames: [],
  ghosts: [],
  ghostsOn: new Set(),
  ghostsChosen: false,
  watching: null,
  keys: new Set(),
  touch: 0,
  nonce: 0,
  rideId: 0,
  status: null,
  anchor: null,
  opening: false,
  pendingRun: null,
  lastSplit: 0,
};
let circuit = null;
let stopWatch = null;
const me = () => session.commander?.id ?? null;
const nextNonce = () => (ui.nonce = Math.max(Date.now(), ui.nonce + 1));

// ---------------------------------------------------------------- seasons

async function enterSeason(season) {
  stopWatch?.();
  circuit = new Circuit(CONFIG, season);
  ui.seasonReady = false;
  ui.ghostsChosen = false;
  ui.ghostsOn.clear();
  stopWatch = ledger.watch(CONFIG.movesChain, seasonTopic(CONFIG, season), 0, sync, 1000);
  await sync();
  ui.seasonReady = true;
  restartAttract();
}

let syncing = null;
let again = false;
async function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    do {
      again = false;
      const c = circuit;
      const entries = await ledger.entriesFrom(CONFIG.movesChain, seasonTopic(CONFIG, c.season), c.position.height);
      for (const entry of entries) {
        if (c !== circuit) return;
        let result;
        try { result = await c.apply(entry, session.profiles.check); } catch { setTimeout(sync, 800); break; }
        if (!result.skipped) onApplied(entry, result);
      }
    } while (again);
  })();
  try { await syncing; $('banner').hidden = true; } catch (error) { reportReachability($('banner'), error); } finally { syncing = null; }
  renderBoard();
  renderTop();
}

function onApplied(entry, result) {
  if (result.opened && ui.mode === 'attract') restartAttract();
  const pending = ui.pendingRun;
  if (pending && pending.messageId === entry.messageId) pending.resolve({ entry, result });
  if (ui.seasonReady && result.accepted && result.kind === 'run' && pending?.messageId !== entry.messageId && result.personalBest
      && circuit.leaderboard()[0]?.messageId === entry.messageId) {
    toast(`${result.run.id} takes the lead: ${lapTime(result.run.frames)}`, 'info');
  }
}

// ---------------------------------------------------------------- riding

function ghostsFor() {
  if (!circuit?.seed) return [];
  if (!ui.ghostsChosen) {
    ui.ghostsChosen = true;
    for (const r of circuit.leaderboard().filter((x) => x.id !== me()).slice(0, CONFIG.ghosts)) ui.ghostsOn.add(r.id);
  }
  return circuit.leaderboard().filter((r) => ui.ghostsOn.has(r.id)).map((r, i) => ({
    name: r.id, color: GHOST_COLORS[i % GHOST_COLORS.length], inputs: r.inputs, run: new Run(circuit.track),
  }));
}

function restartAttract() {
  ui.mode = 'attract';
  ui.run = new Run(circuit?.track ?? DEMO);
  ui.ghosts = circuit?.track ? ghostsFor() : [];
  renderTop();
}

async function play() {
  const c = session.commander;
  if (!c) { session.open(); return; }
  if (!topicSession) { toast(topicSetupError, 'info'); return; }
  if (circuit.end - Date.now() < 160_000) { toast('This season ends too soon for a full ride — wait for the next circuit', 'info'); return; }
  if (!circuit.seed) {
    if (ui.opening) return;
    ui.opening = true;
    $('prompt-note').textContent = 'Opening the season — the circuit comes from the block that finalizes this…';
    try {
      await submitMove(circuit.season, { t: 'open' });
      for (let i = 0; i < 60 && !circuit.seed; i++) { await new Promise((r) => setTimeout(r, 250)); await sync(); }
    } catch (error) {
      toast(`Could not open the season: ${error.message}`, 'info');
    } finally {
      ui.opening = false;
    }
    if (!circuit.seed) return;
  }
  $('end').hidden = true;
  ui.mode = 'countdown';
  ui.run = new Run(circuit.track);
  ui.ghosts = ghostsFor();
  ui.frames = [];
  ui.rideId = nextNonce();
  ui.lastSplit = 0;
  ui.playSeason = circuit.season;
  ui.playSeed = circuit.seed;
  renderTop();
  for (const n of ['3', '2', '1', 'GO']) {
    $('countdown').textContent = n;
    $('countdown').hidden = false;
    await new Promise((r) => setTimeout(r, n === 'GO' ? 400 : 700));
  }
  $('countdown').hidden = true;
  ui.mode = 'play';
}

function watch(run) {
  panel.close();
  $('end').hidden = true;
  ui.mode = 'watch';
  ui.watching = run;
  ui.run = new Run(circuit.track);
  ui.ghosts = [];
}

const inputBits = () => {
  const k = ui.keys;
  return ((k.has('ArrowLeft') || k.has('a') || k.has('A')) ? LEFT : 0)
    | ((k.has('ArrowRight') || k.has('d') || k.has('D')) ? RIGHT : 0)
    | ((k.has('ArrowUp') || k.has('w') || k.has('W')) ? THROTTLE : 0)
    | ((k.has('ArrowDown') || k.has('s') || k.has('S') || k.has(' ')) ? BRAKE : 0)
    | ui.touch;
};

function stepGhosts() {
  for (const g of ui.ghosts) if (!g.run.over && g.run.frame < g.inputs.length) g.run.step(g.inputs[g.run.frame]);
}

function stepOnce() {
  if (ui.mode === 'play') {
    const bits = inputBits();
    ui.frames.push(bits);
    ui.run.step(bits);
    stepGhosts();
    if (ui.run.splits.length > ui.lastSplit) onSplit(ui.run.splits.length);
    if (ui.run.over) finish();
  } else if (ui.mode === 'watch') {
    const inputs = ui.watching.inputs;
    ui.run.step(ui.run.frame < inputs.length ? inputs[ui.run.frame] : 0);
    if (ui.run.over || ui.run.frame >= inputs.length) restartAttract();
  } else if (ui.mode === 'attract' || ui.mode === 'countdown' || ui.mode === 'submitting') {
    if (ui.mode === 'countdown') return;
    ui.run.step(autopilot(ui.run));
    stepGhosts();
    if (ui.run.over) restartAttract();
  }
}

/** Passing a checkpoint: show the gap to your best, and post a signed split so rivals see you live. */
function onSplit(count) {
  ui.lastSplit = count;
  const frame = ui.run.splits[count - 1];
  const best = circuit.best.get(me());
  if (best && best.splits[count - 1]) {
    const gap = (frame - best.splits[count - 1]) / FPS;
    const el = $('split');
    el.textContent = `${gap <= 0 ? '−' : '+'}${Math.abs(gap).toFixed(2)} s`;
    el.className = `split show ${gap <= 0 ? 'up' : 'down'}`;
    clearTimeout(onSplit.timer);
    onSplit.timer = setTimeout(() => { el.className = 'split'; }, 1600);
  }
  if (count >= LAPS * CHECKPOINTS) return; // the finish is the run itself
  const c = session.commander;
  const n = nextNonce();
  c.sign(splitStatement(CONFIG, ui.playSeason, c.id, n, ui.rideId, count, frame)).then((sig) =>
    submitMove(ui.playSeason, { t: 'split', id: c.id, pub: c.pub, n, run: ui.rideId, cp: count, frame, sig }))
    .catch(() => {});
}

/** Where a live rival probably is now, from their last signed split. */
function liveRiders() {
  if (!circuit?.seed) return [];
  const now = Date.now();
  return circuit.liveRiders(now, me()).map((r) => {
    const perFrame = r.frame ? (r.cp * CP) / r.frame : 0;
    const since = Math.max(0, (now - r.timestamp - 600) / STEP_MS);
    const z = Math.min((r.cp + 1) * CP - 1, r.cp * CP + perFrame * since);
    return { name: r.id, z, x: 0, cp: r.cp, frame: r.frame, at: r.timestamp };
  });
}

let last = performance.now();
let acc = 0;
function loop(t) {
  acc += Math.min(250, t - last);
  last = t;
  let steps = 0;
  while (acc >= STEP_MS && steps < 8) { stepOnce(); acc -= STEP_MS; steps++; }
  if (steps === 8) acc = 0;
  const live = ui.mode === 'play' || ui.mode === 'attract' ? liveRiders() : [];
  renderer.frame({ run: ui.run, ghosts: ui.mode === 'watch' ? [] : ui.ghosts, live, now: t });
  renderHud();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- submitting

async function finish() {
  const run = ui.run;
  if (run.finished === null) {
    ui.mode = 'attract';
    toast(`No finish within ${MAX_FRAMES / FPS} s — that ride does not count`, 'info');
    restartAttract();
    return;
  }
  ui.mode = 'submitting';
  const c = session.commander;
  const frames = Uint8Array.from(ui.frames);
  const encoded = encodeInputs(frames);
  const steps = [
    { title: 'Inputs recorded', sub: `${frames.length.toLocaleString()} frames · ${encoded.length.toLocaleString()} bytes`, ms: '' },
    { title: 'Signed by your rider session and commander', sub: `Ed25519 · ${c.id}`, ms: '' },
    { title: `Finalized on ${CONFIG.movesChain}`, sub: 'waiting for the members…', ms: '' },
    { title: 'Replayed by this browser', sub: 'the time must come out of your inputs', ms: '' },
    { title: 'Sealed on Cardano', sub: 'at the next anchor', ms: '' },
  ];
  let at = 1;
  const draw = (failed = false) => {
    $('steps').innerHTML = steps.map((s, i) => `<li class="${i < at ? 'done' : i === at ? (failed ? 'fail' : 'run') : ''}">
      <span class="ic">${i < at ? '✓' : failed && i === at ? '!' : i + 1}</span><div>${s.title}<small>${s.sub}</small></div>
      <span class="ms">${i < at ? s.ms : ''}</span></li>`).join('');
  };
  $('final').textContent = lapTime(run.finished);
  $('rank').hidden = true;
  $('rank').className = 'rank';
  $('end').hidden = false;
  draw();
  ui.mode = 'attract';
  ui.run = new Run(circuit.track);
  try {
    const t0 = performance.now();
    const n = nextNonce();
    const sig = await c.sign(runStatement(CONFIG, ui.playSeason, ui.playSeed, c.id, n, inputsHash(encoded), run.finished));
    steps[1].ms = `${Math.max(1, Math.round(performance.now() - t0))} ms`;
    at = 2; draw();
    const body = { t: 'run', id: c.id, pub: c.pub, n, seed: ui.playSeed, inputs: toHex(encoded), frames: run.finished, sig };
    const submitted = performance.now();
    const outcome = new Promise((resolve) => { ui.pendingRun = { resolve }; });
    const { messageId } = await submitMove(ui.playSeason, body);
    ui.pendingRun.messageId = messageId;
    let message = null;
    for (let i = 0; i < 120 && !message; i++) {
      message = await ledger.message(CONFIG.movesChain, messageId).catch(() => null);
      if (!message) await new Promise((r) => setTimeout(r, 200));
    }
    if (!message) throw new Error('not finalized in time');
    steps[2].sub = `block #${message.height} · ${ui.status ? `${ui.status.threshold} of ${ui.status.members} members` : 'certified'}`;
    steps[2].ms = `${((performance.now() - submitted) / 1000).toFixed(1)} s`;
    at = 3; draw();
    sync();
    const replayStart = performance.now();
    const { result } = await outcome;
    ui.pendingRun = null;
    if (!result.accepted) {
      steps[3].sub = esc(result.reason);
      draw(true);
      $('rank').textContent = `Not counted: ${result.reason}.`;
      $('rank').className = 'rank bad';
      $('rank').hidden = false;
      return;
    }
    steps[3].sub = `crosses the line at ${lapTime(result.run.frames)} ✓ exactly what you rode`;
    steps[3].ms = `${Math.max(1, Math.round(performance.now() - replayStart))} ms`;
    at = 4; draw();
    const rank = circuit.leaderboard().findIndex((r) => r.id === c.id) + 1;
    $('rank').textContent = result.personalBest
      ? `#${rank} this season — verified by replay, not by trust.`
      : `Verified. Your best this season is still ${lapTime(circuit.best.get(c.id).frames)} (#${rank}).`;
    $('rank').hidden = false;
    renderBoard();
    for (let i = 0; i < 90; i++) {
      const anchor = await ledger.anchor(CONFIG.movesChain).catch(() => null);
      if (anchor && anchor.anchoredHeight >= message.height) {
        steps[4].sub = `tx ${txLink(anchor.transactionHash)}`;
        steps[4].ms = '⚓';
        at = 5; draw();
        return;
      }
      steps[4].sub = `waiting for the next anchor · sealed through #${anchor?.anchoredHeight ?? '—'}`;
      draw();
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (error) {
    ui.pendingRun = null;
    steps[at].sub = esc(error.message);
    draw(true);
  }
}

// ---------------------------------------------------------------- panels

function renderHud() {
  const riding = ui.mode === 'play' || ui.mode === 'countdown' || ui.mode === 'watch';
  $('hud').hidden = !riding;
  $('prompt').hidden = ui.mode !== 'attract' || !$('end').hidden;
  $('watching').hidden = ui.mode !== 'watch';
  if (ui.mode === 'watch') $('watching').textContent = `▶ replaying ${ui.watching.id}’s ride from the ledger`;
  $('touch').hidden = ui.mode !== 'play' || !matchMedia('(pointer: coarse)').matches;
  const r = ui.run;
  $('kmh').textContent = String((r.v >> 4) * 2);
  $('time').textContent = lapTime(r.frame);
  $('lap').textContent = `LAP ${r.lap}/${LAPS}`;
  $('crashes').textContent = r.crashes;
  $('draft').hidden = !r.draft || ui.mode !== 'play';
}

function renderTop() {
  if (!circuit) return;
  const left = Math.max(0, circuit.end - Date.now());
  const mm = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  const label = circuit.season % 100000;
  $('season').innerHTML = circuit.seed
    ? `Season <b>${label}</b> · circuit from block <b>#${circuit.seededBy.height}</b> · seed <b>${circuit.seed.slice(0, 8)}…</b> · next circuit in <b>${mm}</b>`
    : `Season <b>${label}</b> · not opened yet · next circuit in <b>${mm}</b>`;
  $('prompt-field').innerHTML = circuit.seed
    ? `Season <b>${label}</b> · streets drawn from block <b>#${circuit.seededBy.height}</b> · the same city for everyone`
    : 'Tonight’s circuit isn’t open yet — the first rider opens it, and the block that finalizes that draws the streets.';
  $('play').textContent = !session.commander ? 'Sign in to ride' : circuit.seed ? 'Ride this circuit' : 'Open the circuit and ride';
  if (!ui.opening) $('prompt-note').textContent = '2 laps · ↑ throttle · ↓ brake · ← → lean · ride in a car’s slipstream for top speed';
  $('rides').textContent = circuit.runs.length;
  const mine = me() && circuit.best.get(me());
  $('best').textContent = mine ? lapTime(mine.frames) : '—';
}

function renderBoard() {
  if (!circuit) return;
  const rows = circuit.leaderboard();
  $('board').innerHTML = rows.slice(0, 12).map((r, i) => `<li class="${r.id === me() ? 'me' : ''}">
      <span class="r">${i + 1}</span>
      <button class="name" data-prove="${i}">${esc(r.id)}</button>
      <span class="s">${lapTime(r.frames)} <span class="v">✓</span></span>
      ${r.id === me() ? '<span></span>' : `<button class="ic ${ui.ghostsOn.has(r.id) ? 'on' : ''}" data-ghost="${esc(r.id)}" title="Race this ghost">◐</button>`}
      <button class="ic" data-watch="${i}" title="Watch this ride">▶</button>
    </li>`).join('') || '<li class="small empty">No verified rides this season. Be the first.</li>';
}

function renderLive() {
  const riders = liveRiders();
  $('live').innerHTML = riders.map((r) => `<li><span class="dot"></span><b>${esc(r.name)}</b>
    lap ${Math.min(LAPS, Math.floor(r.cp / CHECKPOINTS) + 1)} · split ${r.cp}<span class="at">${lapTime(r.frame)}</span></li>`).join('')
    || '<li class="small">Nobody on the circuit right now. Splits appear here about a second after a rider passes a checkpoint.</li>';
}

function renderSide() {
  const c = session.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c) {
    $('avatar').textContent = c.id[0];
    $('me-name').textContent = c.id;
    $('me-key').textContent = `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`;
  }
}

function openRun(run) {
  panel.open(`${run.id}’s ride`, `
    <dl class="facts">
      <dt>Time</dt><dd>${lapTime(run.frames)} · ${run.crashes} crash${run.crashes === 1 ? '' : 'es'}</dd>
      <dt>Splits</dt><dd class="mono">${run.splits.map((f) => lapTime(f)).join(' · ')}</dd>
      <dt>Block</dt><dd>#${run.height}</dd>
    </dl>
    <div class="row"><button class="btn" id="watch-run">▶ Watch it replayed</button></div>
    <div class="proof-out"></div>`);
  $('watch-run').onclick = () => watch(run);
  panel.run(() => proveRun(CONFIG, ledger, circuit, run, { threshold: ui.status?.threshold ?? 1 }), `${run.id}’s ride`);
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(CONFIG.movesChain), ledger.anchor(CONFIG.movesChain)]);
    ui.status = status;
    ui.anchor = anchor;
    $('blk').textContent = `#${status.tipHeight.toLocaleString()}`;
    $('sealed').textContent = anchor ? `#${anchor.anchoredHeight.toLocaleString()}` : '—';
  } catch (error) {
    reportReachability($('banner'), error);
  }
}

// ---------------------------------------------------------------- input

const GAME_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ']);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (GAME_KEYS.has(e.key)) e.preventDefault();
  ui.keys.add(e.key);
  if (e.key === 'Enter' && ui.mode === 'attract' && $('end').hidden) play();
});
addEventListener('keyup', (e) => ui.keys.delete(e.key));
addEventListener('blur', () => ui.keys.clear());
for (const b of document.querySelectorAll('#touch button')) {
  const bit = Number(b.dataset.bit);
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); ui.touch |= bit; });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { ui.touch &= ~bit; });
}
$('play').addEventListener('click', play);
$('again').addEventListener('click', () => { $('end').hidden = true; play(); });
$('close-end').addEventListener('click', () => { $('end').hidden = true; restartAttract(); });
$('board').addEventListener('click', (e) => {
  const rows = circuit.leaderboard();
  const p = e.target.dataset?.prove;
  const w = e.target.dataset?.watch;
  const g = e.target.dataset?.ghost;
  if (p !== undefined) openRun(rows[Number(p)]);
  if (w !== undefined) watch(rows[Number(w)]);
  if (g !== undefined) {
    if (ui.ghostsOn.has(g)) ui.ghostsOn.delete(g); else ui.ghostsOn.add(g);
    ui.ghostsChosen = true;
    if (ui.mode === 'attract') restartAttract();
    renderBoard();
  }
});
$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (e) => { session.relay = Number(e.target.value); });
$('open-auth').addEventListener('click', () => session.open());
$('signout').addEventListener('click', async () => { await topicSession?.clear(); session.signOut(); session.open('signin'); });

// ---------------------------------------------------------------- start

if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
session.onChange(() => {
  if (!session.commander) topicSession?.clear().catch(() => {});
  renderSide(); renderTop(); renderBoard();
});
await session.restore();
renderSide();
requestAnimationFrame(loop);
await Promise.all([refreshMeta(), enterSeason(seasonOf(CONFIG, Date.now()))]);
setInterval(() => {
  const now = Date.now();
  if (seasonOf(CONFIG, now) !== circuit.season && ui.mode === 'attract' && !ui.pendingRun) {
    toast('A new city circuit is open', 'info');
    enterSeason(seasonOf(CONFIG, now));
  }
  renderTop();
  renderLive();
}, 1000);
setInterval(refreshMeta, 5000);
