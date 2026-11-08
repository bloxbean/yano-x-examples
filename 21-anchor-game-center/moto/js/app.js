// UI wiring for Neon Rush. The physics are sim.js and the verification is
// races.js; this file runs the fixed 60 Hz loop, records your inputs, posts a
// signed split at each checkpoint so rivals see you live, races the ghosts of
// the fastest rides, submits finished rides and keeps the leaderboard in step
// with the ledger. Race lobbies: it opens, joins, leaves and starts them, and
// holds your bike on the grid until the race's start in ledger time.

import { CONFIG } from './config.js';
import { BRAKE, CHECKPOINTS, FPS, LAP, LAPS, LEFT, MAX_FRAMES, RIGHT, Run, THROTTLE, Track, autopilot, lapTime } from './sim.js';
import { Circuit, lobbyPhase, raceStandings, seasonOf, seasonTopic } from './races.js';
import { Renderer } from './render.js';
import { proveRun } from './proofs.js';
import { encodeInputs } from '../../arcade/js/runs.js';
import { applyProxy, withQuery } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { ProofPanel, esc, reportReachability, toast, txLink } from '../../shared/ui.js';
import { blake2b } from '../../shared/blake2b.js';
import { ed25519Supported, toHex, utf8 } from '../../shared/crypto.js';
import { connectMoves, showSession } from '../../shared/sessions.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
const moves = await connectMoves(ledger, CONFIG, session, () => renderSide());
const panel = new ProofPanel();
const renderer = new Renderer($('road'));
$('back').href = withQuery('../');

const STEP_MS = 1000 / FPS;
const GHOST_COLORS = ['#3ee6ff', '#ffb020', '#7dff6a', '#a78bff'];
const DEMO = new Track(blake2b(utf8(`${CONFIG.app}|demo`), 16)); // attract mode before a season opens
const CP = LAP / CHECKPOINTS;
const RACE = CONFIG.race;

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
  race: null, // the race id of the ride in progress
  pendingLobby: new Map(), // messageId → what it was, until it is applied
  clockOffset: 0, // ledger time − this browser's clock, estimated from our own moves
  probes: new Map(), // messageId → local time it was sent
};
let circuit = null;
let stopWatch = null;
const me = () => session.commander?.id ?? null;
const nextNonce = () => (ui.nonce = Math.max(Date.now(), ui.nonce + 1));
/** Now, in ledger time: lobbies close and races start at block timestamps, not at this browser's clock. */
const ledgerNow = () => Date.now() + ui.clockOffset;
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const shortRace = (id) => id.slice(0, 6);

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
      const entries = await moves.entries(seasonTopic(CONFIG, c.season), c.position.height);
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
  renderLobbies();
}

function onApplied(entry, result) {
  if (result.opened && ui.mode === 'attract') restartAttract();
  // A block is final only once its timestamp has passed in ledger time: every block we
  // see is a lower bound on the clock, for spectators too.
  ui.clockOffset = Math.max(ui.clockOffset, entry.timestamp - Date.now());
  const sent = ui.probes.get(entry.messageId);
  if (sent !== undefined) {
    // Our move's block timestamp lies between sending it and seeing it final, in ledger
    // time; keep the clock offset inside that window (it starts at zero).
    ui.probes.delete(entry.messageId);
    const lo = entry.timestamp - Date.now();
    const hi = entry.timestamp - sent;
    ui.clockOffset = Math.min(hi, Math.max(lo, ui.clockOffset));
  }
  const lobbyMove = ui.pendingLobby.get(entry.messageId);
  if (lobbyMove) {
    ui.pendingLobby.delete(entry.messageId);
    if (!result.accepted) toast(`Your ${lobbyMove} was refused: ${result.reason}`, 'info');
    else if (lobbyMove === 'race') toast('Race open — share the page; riders join from “Race together”', 'info');
  }
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

/** The season's circuit exists once its first message is final; open it if nobody has. */
async function ensureOpen() {
  if (circuit.seed) return true;
  if (ui.opening) return false;
  ui.opening = true;
  $('prompt-note').textContent = 'Opening the season — the circuit comes from the block that finalizes this…';
  try {
    await moves.submit(session.commander, session.relay, seasonTopic(CONFIG, circuit.season), { t: 'open' });
    for (let i = 0; i < 60 && !circuit.seed; i++) { await new Promise((r) => setTimeout(r, 250)); await sync(); }
  } catch (error) {
    toast(`Could not open the season: ${error.message}`, 'info');
  } finally {
    ui.opening = false;
  }
  return !!circuit.seed;
}

/** Ride now, or — with a race id — wait on the grid for that race's start. */
async function play(race = null) {
  const c = session.commander;
  if (!c) { session.open(); return; }
  if (!race && circuit.end - Date.now() < 160_000) { toast('This season ends too soon for a full ride — wait for the next circuit', 'info'); return; }
  // A race's season is open already; without an await here, joining the grid is immediate.
  if (!race && !(await ensureOpen())) return;
  $('end').hidden = true;
  ui.run = new Run(circuit.track);
  ui.ghosts = race ? [] : ghostsFor(); // in a race your rivals are the riders, not the ghosts
  ui.frames = [];
  ui.rideId = nextNonce();
  ui.lastSplit = 0;
  ui.playSeason = circuit.season;
  ui.playSeed = circuit.seed;
  ui.race = race;
  if (race) {
    ui.mode = 'grid'; // loop() lets go at the start
    renderTop();
    return;
  }
  ui.mode = 'countdown';
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

// ?autopilot: the attract mode's rider steers for you — for demos, and for trying a race
// with two browsers at one desk. Its rides are ordinary: signed, replayed, verified.
const AUTOPILOT = new URLSearchParams(location.search).has('autopilot');
const inputBits = () => {
  if (AUTOPILOT) return autopilot(ui.run);
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

/** On the grid: hold the bike until the race's start in ledger time, counting down the last seconds. */
function holdGrid() {
  const mine = circuit.lobbies.get(ui.race);
  const phase = mine && lobbyPhase(CONFIG, mine, ledgerNow());
  if (!phase || phase.state === 'cancelled' || phase.state === 'finished') { ui.race = null; restartAttract(); return; }
  const left = phase.startAt - ledgerNow();
  const cd = $('countdown');
  if (left > 0) {
    cd.textContent = left <= 3000 ? String(Math.ceil(left / 1000)) : '';
    cd.hidden = left > 3000;
    const others = mine.members.filter((m) => m.id !== me()).map((m) => esc(m.id));
    $('grid-card').innerHTML = `Race <b>${shortRace(mine.id)}</b> · starts in <b>${mmss(left)}</b><br>`
      + (others.length ? `on the grid with ${others.join(', ')}` : 'riding alone — the clock is your rival');
    $('grid-card').hidden = false;
    return;
  }
  $('grid-card').hidden = true;
  cd.textContent = 'GO';
  cd.hidden = false;
  setTimeout(() => { if (cd.textContent === 'GO') cd.hidden = true; }, 500);
  ui.mode = 'play';
  if (left < -1500) toast(`You started ${(-left / 1000).toFixed(1)} s after the gun`, 'info');
}

function stepOnce() {
  if (ui.mode === 'grid') return;
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
  moves.submit(c, session.relay, seasonTopic(CONFIG, ui.playSeason),
    { t: 'split', id: c.id, pub: c.pub, n, run: ui.rideId, cp: count, frame, ...(ui.race ? { race: ui.race } : {}) }).catch(() => {});
}

/** Where a live rival probably is now, from their last signed split. Estimates, never frame-exact. */
function liveRiders() {
  if (!circuit?.seed) return [];
  const now = ledgerNow();
  const riders = circuit.liveRiders(now, me()).map((r) => {
    const perFrame = r.frame ? (r.cp * CP) / r.frame : 0;
    const since = Math.max(0, (now - r.timestamp - 600) / STEP_MS);
    const z = Math.min((r.cp + 1) * CP - 1, r.cp * CP + perFrame * since);
    return { name: r.id, z, x: 0, cp: r.cp, frame: r.frame, at: r.timestamp, race: r.race };
  });
  // In a race: rivals on the grid who have not reached a checkpoint yet ride at
  // your pace from the start, until their first split says where they are.
  const lobby = ui.race && circuit.lobbies.get(ui.race);
  if (lobby) {
    const phase = lobbyPhase(CONFIG, lobby, now);
    const pace = ui.run.frame ? ui.run.z / ui.run.frame : 0;
    lobby.members.forEach((m, i) => {
      if (m.id === me() || riders.some((r) => r.name === m.id) || lobby.results.has(m.id)) return;
      const z = ui.mode === 'grid' ? 0 : Math.min(CP - 1, Math.max(0, (now - phase.startAt) / STEP_MS) * pace);
      riders.push({ name: m.id, z, x: [-650, 650, -220, 220][i % 4], cp: 0, frame: 0, at: phase.startAt, race: lobby.id, guess: true });
    });
  }
  return riders;
}

let last = performance.now();
let acc = 0;
function loop(t) {
  acc += Math.min(250, t - last);
  last = t;
  let steps = 0;
  while (acc >= STEP_MS && steps < 8) { stepOnce(); acc -= STEP_MS; steps++; }
  if (steps === 8) acc = 0;
  if (ui.mode === 'grid') holdGrid();
  const live = ui.mode === 'play' || ui.mode === 'attract' || ui.mode === 'grid' ? liveRiders() : [];
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
  const race = ui.race;
  ui.race = null;
  const c = session.commander;
  const frames = Uint8Array.from(ui.frames);
  const encoded = encodeInputs(frames);
  const steps = [
    { title: 'Inputs recorded', sub: `${frames.length.toLocaleString()} frames · ${encoded.length.toLocaleString()} bytes`, ms: '' },
    { title: 'Signed with your session key', sub: `Ed25519 · ${CONFIG.scope} · ${c.id}`, ms: '' },
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
    const move = { t: 'run', id: c.id, pub: c.pub, n, seed: ui.playSeed, inputs: toHex(encoded), frames: run.finished,
      ...(race ? { race } : {}) };
    const outcome = new Promise((resolve) => { ui.pendingRun = { resolve }; });
    const submitted = performance.now();
    // A race ride must be final within the grace after the start plus its own time: keep
    // trying through a dropped connection until then. Other rides try once.
    const until = Date.now() + (race ? RACE.graceMs - 2000 : 0);
    let messageId;
    for (;;) {
      try {
        ({ messageId } = await moves.submit(c, session.relay, seasonTopic(CONFIG, ui.playSeason), move));
        break;
      } catch (error) {
        if (Date.now() > until) throw error;
        steps[1].sub = `retrying: ${esc(error.message)}`;
        draw();
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    steps[1].ms = `${Math.max(1, Math.round(submitted - t0))} ms`;
    at = 2; draw();
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
    if (result.race) {
      const lobby = circuit.lobbies.get(result.race.id);
      const place = lobby && raceStandings(CONFIG, lobby, ledgerNow()).find((r) => r.id === c.id)?.place;
      $('rank').textContent += result.race.counted
        ? ` Race ${shortRace(result.race.id)}: ${place ? `#${place} so far of ${lobby.members.length}` : 'counted'} — the grid’s results fill in as their rides finalize.`
        : ` Not counted for race ${shortRace(result.race.id)}: ${result.race.reason}.`;
    }
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

// ---------------------------------------------------------------- race lobbies

/** Post a lobby event: 'lobby' (open a race), 'join', 'leave' or 'start'. */
async function lobbyAction(t, fields) {
  const c = session.commander;
  if (!c) { session.open(); return; }
  if (!(await ensureOpen())) return;
  const sent = Date.now();
  try {
    const { messageId } = await moves.submit(c, session.relay, seasonTopic(CONFIG, circuit.season),
      { t, id: c.id, pub: c.pub, n: nextNonce(), ...fields });
    ui.probes.set(messageId, sent);
    ui.pendingLobby.set(messageId, t === 'lobby' ? 'race' : t);
    sync();
  } catch (error) {
    toast(`Could not ${t === 'lobby' ? 'open the race' : t}: ${error.message}`, 'info');
  }
}

/** The race you are on the grid of and have not finished: { lobby, phase } or null. */
const myRace = () => (circuit?.seed && me() ? circuit.raceOf(me(), ledgerNow()) : null);

function phaseText(lobby, phase, now) {
  switch (phase.state) {
    case 'open': return `open · closes in ${mmss(phase.closesAt - now)}${phase.extended ? ' (waiting once more)' : ''}`;
    case 'countdown': return `starts in ${mmss(phase.startAt - now)}`;
    case 'racing': return lobby.results.size === lobby.members.length ? 'all finished' : `racing · ${mmss(now - phase.startAt)}`;
    case 'finished': return 'finished';
    default: return `cancelled: ${phase.reason}`;
  }
}

function renderLobbies() {
  if (!circuit) return;
  const now = ledgerNow();
  const mine = myRace();
  const c = session.commander;
  const fits = circuit.end - now >= RACE.waits[0] + RACE.leadMs + 150_000 + RACE.graceMs;
  const idle = ui.mode === 'attract' || ui.mode === 'watch';
  $('lobby-create').disabled = !c || !!mine || !fits || !idle;
  $('lobby-note').textContent = !c ? 'Sign in to open or join a race.'
    : mine ? `You are on the grid of race ${shortRace(mine.lobby.id)}.`
    : !fits ? 'Too close to the season change for a race — the next circuit opens soon.' : '';
  // Races still to come or under way, then the last few that ended in the past five minutes.
  const shown = circuit.races(now).filter(({ phase }) => phase.state !== 'finished' && phase.state !== 'cancelled'
    || now - phase.endsAt < 300_000).slice(0, 8);
  $('lobbies').innerHTML = shown.map(({ lobby, phase }) => {
    const onGrid = lobby.members.some((m) => m.id === me());
    const acts = [];
    if (phase.state === 'open' && c) {
      if (!onGrid && lobby.members.length < lobby.max && !mine && idle) acts.push(`<button class="btn primary" data-act="join" data-race="${lobby.id}">Join</button>`);
      if (onGrid && lobby.host === me()) acts.push(`<button class="btn" data-act="start" data-race="${lobby.id}">Start now</button>`);
      if (onGrid) acts.push(`<button class="btn" data-act="leave" data-race="${lobby.id}">${lobby.host === me() ? 'Cancel race' : 'Leave'}</button>`);
    }
    const results = phase.state === 'racing' || phase.state === 'finished'
      ? `<ol class="result">${raceStandings(CONFIG, lobby, now).map((r) => `<li>
          <span>${r.place ?? '–'}</span><span class="${r.status === 'dnf' ? 'dnf' : ''}">${esc(r.id)}</span>
          <span class="t">${r.run ? lapTime(r.run.frames) : r.status === 'dnf' ? 'DNF' : '…'}</span>
          ${r.run ? `<button data-race-run="${lobby.id}:${esc(r.id)}" title="Watch this ride">▶</button>` : '<span></span>'}</li>`).join('')}</ol>`
      : `<div class="riders">${lobby.members.map((m) => `<span class="rider ${m.id === me() ? 'me' : ''}">${esc(m.id)}${m.id === lobby.host ? ' ★' : ''}</span>`).join('')}
          <span class="small">${lobby.members.length}/${lobby.max}</span></div>`;
    return `<li class="${onGrid ? 'mine' : ''}">
      <div class="head"><b>Race ${shortRace(lobby.id)}</b><span class="small">by ${esc(lobby.host)}</span>
        <span class="state ${phase.state}">${phaseText(lobby, phase, now)}</span></div>
      ${results}${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}</li>`;
  }).join('') || '<li class="small">No races this season yet. Open one and others can join until it closes.</li>';
  const off = ui.clockOffset;
  $('lobby-clock').textContent = `Times are ledger time, from finalized block timestamps${Math.abs(off) >= 100
    ? ` (this browser’s clock is ${off > 0 ? 'behind' : 'ahead'} by ${(Math.abs(off) / 1000).toFixed(1)} s)` : ''}.`;
}

/** The prompt while you are on a race's grid; the race's own countdown takes over at the close. */
function renderPromptRace() {
  const mine = myRace();
  const box = $('prompt-race');
  const now = ledgerNow();
  if (!mine || ui.mode !== 'attract') { box.hidden = true; $('play').hidden = false; return; }
  const { lobby, phase } = mine;
  if (phase.state === 'countdown') { play(lobby.id); return; }
  const others = lobby.members.filter((m) => m.id !== me()).map((m) => esc(m.id));
  if (phase.state === 'open') {
    $('play').hidden = true;
    box.innerHTML = `On the grid of race <b>${shortRace(lobby.id)}</b> · closes in <b>${mmss(phase.closesAt - now)}</b><br>
      ${others.length ? `with ${others.join(', ')}` : 'nobody else yet'} · the start is ${RACE.leadMs / 1000} s after the close, for everyone`;
  } else {
    const late = now - phase.startAt;
    const counts = late < RACE.graceMs - 5000;
    $('play').hidden = !counts;
    $('play').textContent = `Ride race ${shortRace(lobby.id)} now`;
    box.innerHTML = counts
      ? `Race <b>${shortRace(lobby.id)}</b> started <b>${(late / 1000).toFixed(0)} s</b> ago — ride now and it still counts, if you finish within ${RACE.graceMs / 1000} s of your own time after the start.`
      : `You missed the start of race <b>${shortRace(lobby.id)}</b>. Your place is a DNF; rides now count for the season only.`;
  }
  box.hidden = false;
}

// ---------------------------------------------------------------- panels

function renderHud() {
  const riding = ui.mode === 'play' || ui.mode === 'countdown' || ui.mode === 'watch' || ui.mode === 'grid';
  if (ui.mode !== 'grid') $('grid-card').hidden = true;
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
  renderPromptRace();
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
    ${r.guess ? (ui.mode === 'grid' ? 'on the grid with you' : 'racing you · first split soon')
      : `lap ${Math.min(LAPS, Math.floor(r.cp / CHECKPOINTS) + 1)} · split ${r.cp}${r.race ? ` · race ${shortRace(r.race)}` : ''}<span class="at">${lapTime(r.frame)}</span>`}</li>`).join('')
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
    showSession($('me-key'), moves);
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
  panel.run(() => proveRun(CONFIG, ledger, moves, circuit, run, { threshold: ui.status?.threshold ?? 1 }), `${run.id}’s ride`);
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
$('play').addEventListener('click', () => {
  const mine = myRace();
  play(mine && mine.phase.state === 'racing' ? mine.lobby.id : null);
});
$('lobby-wait').innerHTML = RACE.waits.map((w) => `<option value="${w}" ${w === 30_000 ? 'selected' : ''}>${w / 1000} s</option>`).join('');
$('lobby-max').innerHTML = Array.from({ length: RACE.maxRiders - 1 }, (_, i) => i + 2)
  .map((n) => `<option value="${n}" ${n === 4 ? 'selected' : ''}>${n}</option>`).join('');
$('lobby-create').addEventListener('click', () => lobbyAction('lobby', {
  wait: Number($('lobby-wait').value), max: Number($('lobby-max').value), alone: $('lobby-alone').value,
}));
$('lobbies').addEventListener('click', (e) => {
  const { act, race, raceRun } = e.target.dataset ?? {};
  if (act) lobbyAction(act, { race });
  if (raceRun) {
    const [id, rider] = raceRun.split(':');
    const run = circuit.lobbies.get(id)?.results.get(rider);
    if (run) openRun(run);
  }
});
$('again').addEventListener('click', () => { $('end').hidden = true; play(); });
$('end').addEventListener('click', (e) => { if (e.target.id === 'close-end') renderPromptRace(); });
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
$('signout').addEventListener('click', () => { session.signOut(); session.open('signin'); });

// ---------------------------------------------------------------- start

if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
session.onChange(() => { renderSide(); renderTop(); renderBoard(); renderLobbies(); });
await session.restore();
renderSide();
requestAnimationFrame(loop);
await Promise.all([refreshMeta(), enterSeason(seasonOf(CONFIG, Date.now()))]);
setInterval(() => {
  const now = Date.now();
  if (seasonOf(CONFIG, now) !== circuit.season && ui.mode === 'attract' && !ui.pendingRun && !myRace()) {
    toast('A new city circuit is open', 'info');
    enterSeason(seasonOf(CONFIG, now));
  }
  renderTop();
  renderLive();
  renderLobbies();
}, 1000);
setInterval(refreshMeta, 5000);
