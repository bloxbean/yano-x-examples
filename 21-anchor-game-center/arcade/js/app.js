// UI wiring for the arcade. The game is sim.js and the verification is
// runs.js; this file runs the fixed 60 Hz loop, records your inputs, races
// ghosts, submits finished runs and keeps the leaderboard in step with the
// ledger.

import { CONFIG } from './config.js';
import { FIRE, FPS, H, LEFT, RIGHT, RUN_FRAMES, Run, THRUST, W } from './sim.js';
import { Arcade, encodeInputs, fieldOf, fieldTopic, inputsHash, runStatement } from './runs.js';
import { GHOST_COLORS, Renderer } from './render.js';
import { proveRun } from './proofs.js';
import { ACCOUNTS, applyProxy, withQuery } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { proveProfile } from '../../shared/proofs.js';
import { ProofPanel, esc, reportReachability, toast, txLink } from '../../shared/ui.js';
import { blake2b } from '../../shared/blake2b.js';
import { ed25519Supported, fromHex, toHex, utf8 } from '../../shared/crypto.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
const panel = new ProofPanel();
const renderer = new Renderer($('game'));
$('back').href = withQuery('../');

const DEMO_SEED = toHex(blake2b(utf8(`${CONFIG.app}|demo`), 16)); // attract mode before a field opens
const STEP_MS = 1000 / FPS;

const ui = {
  mode: 'attract', // attract | countdown | play | watch
  run: new Run(fromHex(DEMO_SEED)),
  frames: null,
  ghosts: [],
  ghostsOn: new Set(), // ids whose ghosts race
  ghostsChosen: false,
  watching: null,
  keys: new Set(),
  touch: 0,
  nonce: 0,
  status: null,
  anchor: null,
  seals: 0,
  pendingRun: null, // { messageId, score, submitted, resolve }
  opening: false,
};
let arcade = null;
let stopWatch = null;

// ---------------------------------------------------------------- fields

async function enterField(field) {
  stopWatch?.();
  arcade = new Arcade(CONFIG, field);
  ui.fieldReady = false; // quiet while replaying the field's history
  ui.ghostsChosen = false;
  ui.ghostsOn.clear();
  ui.seals = 0;
  stopWatch = ledger.watch(CONFIG.movesChain, fieldTopic(CONFIG, field), 0, sync);
  await sync();
  ui.fieldReady = true;
  restartAttract();
}

function tickField() {
  if (!arcade) return;
  const now = Date.now();
  if (fieldOf(CONFIG, now) !== arcade.field && ui.mode !== 'play' && ui.mode !== 'countdown' && !ui.pendingRun) {
    toast('A new field of rocks is open', 'info');
    enterField(fieldOf(CONFIG, now));
  }
  renderTop();
}

let syncing = null;
let again = false;
async function sync() {
  if (syncing) { again = true; return syncing; } // callers wait for the pass already running
  syncing = (async () => {
    do {
      again = false;
      const a = arcade;
      const entries = await ledger.entriesFrom(CONFIG.movesChain, fieldTopic(CONFIG, a.field), a.position.height);
      for (const entry of entries) {
        let result;
        try {
          result = await a.apply(entry, session.profiles.check);
        } catch {
          setTimeout(sync, 800); // a run waiting on the profile chain: retry, in order
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
  renderBoard();
  renderTop();
}

function onApplied(entry, result) {
  if (result.opened && ui.mode === 'attract') restartAttract();
  const pending = ui.pendingRun;
  if (pending && pending.messageId === entry.messageId) pending.resolve({ entry, result });
  if (ui.fieldReady && result.accepted && result.kind === 'run' && pending?.messageId !== entry.messageId
      && result.personalBest) {
    const leader = arcade.leaderboard()[0];
    if (leader?.messageId === entry.messageId) toast(`${result.run.id} takes the lead with ${result.run.score.toLocaleString()}`, 'info');
  }
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(CONFIG.movesChain), ledger.anchor(CONFIG.movesChain)]);
    if (anchor && ui.anchor && anchor.anchoredHeight > ui.anchor.anchoredHeight) ui.seals++;
    ui.status = status;
    ui.anchor = anchor ?? ui.anchor;
    renderSide();
  } catch (error) {
    reportReachability($('banner'), error);
  }
}

// ---------------------------------------------------------------- playing

function ghostsFor(seed) {
  if (!arcade?.seed || seed !== arcade.seed) return [];
  if (!ui.ghostsChosen) {
    ui.ghostsChosen = true;
    for (const r of arcade.leaderboard().filter((x) => x.id !== session.commander?.id).slice(0, CONFIG.ghosts)) {
      ui.ghostsOn.add(r.id);
    }
  }
  return arcade.leaderboard().filter((r) => ui.ghostsOn.has(r.id)).map((r, i) => ({
    name: r.id, color: GHOST_COLORS[i % GHOST_COLORS.length], inputs: r.inputs, run: new Run(fromHex(arcade.seed)),
  }));
}

function restartAttract() {
  ui.mode = 'attract';
  const seed = arcade?.seed ?? DEMO_SEED;
  ui.run = new Run(fromHex(seed));
  ui.ghosts = ghostsFor(seed);
  renderTop();
}

async function play() {
  const c = session.commander;
  if (!c) { session.open(); return; }
  const left = arcade.end - Date.now();
  if (left < (RUN_FRAMES / FPS) * 1000 + 15_000) {
    toast(`This field closes in ${Math.ceil(left / 1000)} s — wait for the next one`, 'info');
    return;
  }
  if (!arcade.seed) {
    if (ui.opening) return;
    ui.opening = true;
    $('prompt-note').textContent = 'Opening the field — its rocks come from the block that finalizes this…';
    try {
      await ledger.submit(CONFIG.movesChain, session.relay, fieldTopic(CONFIG, arcade.field), { body: '{"t":"open"}' });
      for (let i = 0; i < 60 && !arcade.seed; i++) { await new Promise((r) => setTimeout(r, 250)); await sync(); }
    } catch (error) {
      toast(`Could not open the field: ${error.message}`, 'info');
    } finally {
      ui.opening = false;
    }
    if (!arcade.seed) return;
  }
  ui.mode = 'countdown';
  ui.run = new Run(fromHex(arcade.seed));
  ui.ghosts = ghostsFor(arcade.seed);
  ui.frames = new Uint8Array(RUN_FRAMES);
  ui.playSeed = arcade.seed;
  ui.playField = arcade.field;
  renderTop();
  for (const n of ['3', '2', '1', 'GO']) {
    $('countdown').textContent = n;
    $('countdown').hidden = false;
    await new Promise((r) => setTimeout(r, n === 'GO' ? 400 : 700));
  }
  $('countdown').hidden = true;
  ui.mode = 'play';
  renderTop();
}

function watch(run) {
  panel.close();
  ui.mode = 'watch';
  ui.watching = run;
  ui.run = new Run(fromHex(arcade.seed));
  ui.ghosts = [];
  renderTop();
}

const inputBits = () => {
  const k = ui.keys;
  return ((k.has('ArrowLeft') || k.has('a') || k.has('A')) ? LEFT : 0)
    | ((k.has('ArrowRight') || k.has('d') || k.has('D')) ? RIGHT : 0)
    | ((k.has('ArrowUp') || k.has('w') || k.has('W')) ? THRUST : 0)
    | (k.has(' ') ? FIRE : 0)
    | ui.touch;
};

/** The attract-mode pilot: turn toward the nearest rock (across the wrap), fire when lined up. */
function autopilot(run) {
  const s = run.ship;
  let best = null;
  let bd = Infinity;
  for (const r of run.rocks) {
    const dx = wrapDelta(r.x - s.x, W * 256);
    const dy = wrapDelta(r.y - s.y, H * 256);
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = { dx, dy }; }
  }
  if (!best) return 0;
  const want = Math.round((Math.atan2(best.dy, best.dx) / (Math.PI * 2)) * 256) & 255;
  const diff = ((want - s.a + 384) & 255) - 128;
  const far = Math.sqrt(bd) / 256 > 260;
  return (diff < -3 ? LEFT : 0) | (diff > 3 ? RIGHT : 0) | (far ? THRUST : 0) | (Math.abs(diff) < 10 ? FIRE : 0);
}
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);

function stepOnce() {
  if (ui.mode === 'play') {
    const f = ui.run.frame;
    const bits = inputBits();
    ui.frames[f] = bits;
    ui.run.step(bits);
    for (const g of ui.ghosts) if (g.run.frame < RUN_FRAMES) g.run.step(g.inputs[g.run.frame]);
    if (ui.run.frame >= RUN_FRAMES) finish();
  } else if (ui.mode === 'watch') {
    ui.run.step(ui.watching.inputs[ui.run.frame]);
    if (ui.run.frame >= RUN_FRAMES) restartAttract();
  } else if (ui.mode === 'attract') {
    ui.run.step(autopilot(ui.run));
    for (const g of ui.ghosts) if (g.run.frame < RUN_FRAMES) g.run.step(g.inputs[g.run.frame]);
    if (ui.run.frame >= RUN_FRAMES) restartAttract();
  }
}

let last = performance.now();
let acc = 0;
function loop(now) {
  acc += Math.min(250, now - last);
  last = now;
  let steps = 0;
  while (acc >= STEP_MS && steps < 8) { stepOnce(); acc -= STEP_MS; steps++; }
  if (steps === 8) acc = 0;
  renderer.frame(ui.run, ui.mode === 'watch' ? [] : ui.ghosts);
  renderHud();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- submitting

async function finish() {
  ui.mode = 'submitting';
  const c = session.commander;
  const run = ui.run;
  const frames = ui.frames;
  const encoded = encodeInputs(frames);
  const steps = [
    { title: 'Inputs recorded', sub: `${RUN_FRAMES.toLocaleString()} frames · ${encoded.length.toLocaleString()} bytes`, ms: '' },
    { title: 'Signed with your commander key', sub: `Ed25519 · ${c.id}`, ms: '' },
    { title: `Finalized on ${CONFIG.movesChain}`, sub: 'waiting for the members…', ms: '' },
    { title: 'Replayed by this browser', sub: 'the score must come out of your inputs', ms: '' },
    { title: 'Sealed on Cardano', sub: 'at the next anchor', ms: '' },
  ];
  let at = 1;
  const draw = (failed = false) => {
    $('steps').innerHTML = steps.map((s, i) => `<li class="${i < at ? 'done' : i === at ? (failed ? 'fail' : 'run') : ''}">
      <span class="ic">${i < at ? '✓' : failed && i === at ? '!' : i + 1}</span><div>${s.title}<small>${s.sub}</small></div>
      <span class="ms">${i < at ? s.ms : ''}</span></li>`).join('');
  };
  $('final').textContent = run.score.toLocaleString();
  $('rank').hidden = true;
  $('rank').className = 'rank';
  $('end').hidden = false;
  draw();
  ui.lastRun = { inputs: frames };
  try {
    const t0 = performance.now();
    const n = ui.nonce = Math.max(Date.now(), ui.nonce + 1);
    const statement = runStatement(CONFIG, ui.playField, ui.playSeed, c.id, n, inputsHash(encoded), run.score);
    const sig = await c.sign(statement);
    steps[1].ms = `${Math.max(1, Math.round(performance.now() - t0))} ms`;
    at = 2; draw();
    const body = JSON.stringify({ t: 'run', id: c.id, pub: c.pub, n, seed: ui.playSeed, inputs: toHex(encoded), score: run.score, sig });
    const submitted = performance.now();
    const outcome = new Promise((resolve) => { ui.pendingRun = { resolve }; });
    const { messageId } = await ledger.submit(CONFIG.movesChain, session.relay, fieldTopic(CONFIG, ui.playField), { body });
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
      steps[3].sub = result.reason;
      draw(true);
      $('rank').textContent = `Not counted: ${result.reason}.`;
      $('rank').className = 'rank bad';
      $('rank').hidden = false;
      return;
    }
    steps[3].sub = `score ${result.run.score.toLocaleString()} ✓ matches what you saw`;
    steps[3].ms = `${Math.max(1, Math.round(performance.now() - replayStart))} ms`;
    at = 4; draw();
    ui.lastRun = result.run;
    const rank = arcade.leaderboard().findIndex((r) => r.id === c.id) + 1;
    $('rank').textContent = result.personalBest
      ? `#${rank} on this field — verified by replay, not by trust.`
      : `Verified. Your best on this field is still ${arcade.best.get(c.id).score.toLocaleString()} (#${rank}).`;
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
  const playing = ui.mode === 'play' || ui.mode === 'countdown';
  $('hud').hidden = !(playing || ui.mode === 'watch');
  $('timer').hidden = !playing;
  $('prompt').hidden = ui.mode !== 'attract';
  $('watching').hidden = ui.mode !== 'watch';
  if (ui.mode === 'watch') $('watching').textContent = `▶ replaying ${ui.watching.id}’s run from the ledger`;
  const r = ui.run;
  $('score').textContent = r.score.toLocaleString();
  $('combo').textContent = `×${r.combo}`;
  $('crashes').textContent = r.crashes;
  const left = Math.max(0, RUN_FRAMES - r.frame) / FPS;
  $('time').textContent = `${Math.floor(left / 60)}:${String(Math.ceil(left % 60) === 60 ? 0 : Math.ceil(left % 60)).padStart(2, '0')}`;
}

function renderTop() {
  if (!arcade) return;
  const left = Math.max(0, arcade.end - Date.now());
  const mm = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  const label = arcade.field % 100000;
  $('field').innerHTML = arcade.seed
    ? `Field <b>${label}</b> · rocks from block <b>#${arcade.seededBy.height}</b> · seed <b>${arcade.seed.slice(0, 8)}…</b> · new field in <b>${mm}</b>`
    : `Field <b>${label}</b> · not opened yet · new field in <b>${mm}</b>`;
  $('prompt-field').innerHTML = arcade.seed
    ? `Field <b>${label}</b> · seeded by block <b>#${arcade.seededBy.height}</b> · the same rocks for everyone`
    : 'This field isn’t open yet — the first player opens it, and the block that finalizes that seeds the rocks.';
  $('play').textContent = !session.commander ? 'Sign in to play' : arcade.seed ? 'Play this field' : 'Open the field and play';
  if (!ui.opening) $('prompt-note').textContent = '60 seconds · ← → turn · ↑ thrust · space fire · ghosts of the best runs race you';
  $('runs').textContent = arcade.runs.length;
  const mine = session.commander && arcade.best.get(session.commander.id);
  $('best').textContent = mine ? mine.score.toLocaleString() : '—';
}

function renderBoard() {
  if (!arcade) return;
  const me = session.commander?.id;
  const rows = arcade.leaderboard();
  $('board').innerHTML = rows.slice(0, 12).map((r, i) => `<li class="${r.id === me ? 'me' : ''}">
      <span class="r">${i + 1}</span>
      <button class="name" data-run="${i}" style="color:${r.id === me ? 'var(--me)' : 'var(--text)'}">${esc(r.id)}</button>
      <span class="s">${r.score.toLocaleString()} <span class="v">✓</span></span>
      ${r.id === me ? '<span></span>' : `<button class="ghost-btn ${ui.ghostsOn.has(r.id) ? 'on' : ''}" data-ghost="${esc(r.id)}" title="Race this ghost">▶</button>`}
    </li>`).join('') || '<li class="small empty">No verified runs on this field yet. Be the first.</li>';
}

function renderSide() {
  const s = ui.status;
  if (s) {
    $('blk').textContent = `#${s.tipHeight.toLocaleString()}`;
    $('fin').textContent = `${s.threshold} of ${s.members}`;
  }
  const a = ui.anchor;
  if (a) {
    $('anchor').innerHTML = `Sealed through block <b>#${a.anchoredHeight.toLocaleString()}</b> · tx ${txLink(a.transactionHash)}<br>
      <b>${arcade?.runs.length ?? 0}</b> verified runs this field → <b>${ui.seals}</b> Cardano seal${ui.seals === 1 ? '' : 's'} seen`;
  }
  const c = session.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c) {
    $('avatar').textContent = c.id[0];
    $('me-name').textContent = c.id;
    $('me-key').textContent = `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`
      + (session.profileHeight ? ` · profile at height ${session.profileHeight}` : '');
  }
}

function openRun(run) {
  const when = new Date(run.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const body = panel.open(`${run.id} · ${run.score.toLocaleString()}`, `
    <dl class="facts">
      <dt>Commander</dt><dd><b>${esc(run.id)}</b></dd>
      <dt>Score</dt><dd>${run.score.toLocaleString()} · ${run.kills} rocks · ${run.crashes} crashes</dd>
      <dt>Finalized</dt><dd>block #${run.height} at ${when}</dd>
      <dt>Move</dt><dd class="mono">${run.messageId}</dd>
    </dl>
    <div class="row">
      <button class="btn primary" id="prove-run">Prove this run</button>
      <button class="btn" id="prove-profile">Prove ${esc(run.id)}’s profile</button>
      <button class="btn" id="watch-run">▶ Watch it</button>
    </div>
    <div class="proof-out"></div>`);
  body.querySelector('#prove-run').onclick = () => panel.run(
    () => proveRun(CONFIG, ledger, arcade, run, { threshold: ui.status?.threshold ?? 1 }), `${run.id}’s run`);
  body.querySelector('#prove-profile').onclick = () => panel.run(
    () => proveProfile(ledger, session.profiles, run.id, { threshold: ui.status?.threshold ?? 1, expectPub: run.pub }),
    `${run.id}’s profile`);
  body.querySelector('#watch-run').onclick = () => watch(run);
}

function openProfile() {
  const c = session.commander;
  panel.open(`Commander ${c.id}`, `
    <dl class="facts">
      <dt>Call sign</dt><dd><b>${esc(c.id)}</b></dd>
      <dt>Stored at</dt><dd class="mono">${esc(ACCOUNTS.profilesChain)} · ${esc(ACCOUNTS.profilesCollection)}</dd>
      <dt>Holds</dt><dd>public key, PBKDF2 salt and the password-locked signing key — never the password</dd>
    </dl>
    <div class="proof-out"></div>`);
  panel.run(() => proveProfile(ledger, session.profiles, c.id, { threshold: ui.status?.threshold ?? 1, expectPub: c.pub }),
    `${c.id}’s profile`);
}

// ---------------------------------------------------------------- input

const GAME_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'a', 'd', 'w', 'A', 'D', 'W']);
addEventListener('keydown', (event) => {
  if (event.target.matches?.('input, select, textarea')) return;
  if (GAME_KEYS.has(event.key)) {
    ui.keys.add(event.key);
    if (ui.mode === 'play' || ui.mode === 'countdown') event.preventDefault();
  }
  if (event.key === 'Enter' && ui.mode === 'attract' && $('end').hidden) play();
});
addEventListener('keyup', (event) => ui.keys.delete(event.key));
addEventListener('blur', () => ui.keys.clear());

if (matchMedia('(pointer: coarse)').matches) {
  $('touch').hidden = false;
  for (const b of $('touch').querySelectorAll('button')) {
    const bit = Number(b.dataset.bit);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); ui.touch |= bit; });
    for (const end of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(end, () => { ui.touch &= ~bit; });
  }
}

$('play').addEventListener('click', play);
$('again').addEventListener('click', () => { $('end').hidden = true; restartAttract(); play(); });
$('close-end').addEventListener('click', () => { $('end').hidden = true; restartAttract(); });
$('watch-mine').addEventListener('click', () => {
  $('end').hidden = true;
  watch({ id: session.commander.id, inputs: ui.lastRun.inputs });
});
$('board').addEventListener('click', (event) => {
  const ghost = event.target.dataset?.ghost;
  if (ghost) {
    if (ui.ghostsOn.has(ghost)) ui.ghostsOn.delete(ghost); else ui.ghostsOn.add(ghost);
    ui.ghostsChosen = true;
    if (ui.mode === 'attract') restartAttract();
    renderBoard();
    return;
  }
  const i = event.target.dataset?.run;
  if (i !== undefined) openRun(arcade.leaderboard()[Number(i)]);
});
$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (event) => { session.relay = Number(event.target.value); });
$('open-auth').addEventListener('click', () => session.open());
$('signout').addEventListener('click', () => { session.signOut(); session.open('signin'); });
$('prove-me').addEventListener('click', openProfile);

// ---------------------------------------------------------------- start

if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
session.onChange(() => { renderSide(); renderTop(); renderBoard(); });
await session.restore();
requestAnimationFrame(loop);
await Promise.all([refreshMeta(), enterField(fieldOf(CONFIG, Date.now()))]);
setInterval(tickField, 500);
setInterval(refreshMeta, 3000);
