// UI wiring. The rules live in galaxy.js; accounts, proofs and the ledger
// client are shared by every game in the center (../../shared). This file
// fetches finalized moves, feeds them to the simulation, and draws a copy of
// it run ahead to "now" every frame.

import { CONFIG } from './config.js';
import { Galaxy, moveStatement, roundOf, roundTopic } from './galaxy.js';
import { Renderer, playerColor } from './render.js';
import { proveMove } from './proofs.js';
import { ACCOUNTS, applyProxy, withQuery } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { proveProfile } from '../../shared/proofs.js';
import { ProofPanel, esc, reportReachability as showUnreachable, toast, txLink } from '../../shared/ui.js';
import { ed25519Supported } from '../../shared/crypto.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
const profiles = session.profiles;
const panel = new ProofPanel();
const renderer = new Renderer($('sky'), CONFIG);
$('back').href = withQuery('../');

const ui = {
  commander: null,
  profileHeight: null,
  relay: 0,
  ratio: 50,
  mode: 'command', // or 'inspect'
  selected: null,
  drag: null,
  pending: new Map(), // messageId → { kind, from, to, ships, owner, at, submitted }
  joining: false,
  nonce: 0,
  lastLatency: null,
  feed: [],
  fedCaptures: new Set(), // capture events already shown in the feed
  recentMoves: [], // block timestamps of accepted moves, for moves/s
  status: null,
  anchor: null,
  sealsThisRound: 0,
  movesAtSeal: 0,
};
let galaxy = null;
let stopWatch = null;

// ---------------------------------------------------------------- rounds

async function enterRound(round) {
  stopWatch?.();
  ui.roundReady = false; // no joining until this round's moves have been replayed
  galaxy = new Galaxy(CONFIG, round);
  ui.pending.clear();
  ui.selected = null;
  ui.joining = false;
  ui.sealsThisRound = 0;
  ui.feed = [];
  ui.fedCaptures.clear();
  pushFeed(`<span class="small">Round ${roundLabel(round)} — a new galaxy</span>`, '');
  stopWatch = ledger.watch(CONFIG.movesChain, roundTopic(CONFIG, round), 0, sync);
  await sync();
  ui.roundReady = true;
  maybeJoin();
}

function showResults(finished) {
  const end = finished.end;
  const view = finished.clone();
  view.advanceTo(end);
  const rows = view.standings(end);
  $('results-title').textContent = `Round ${roundLabel(finished.round)} complete`;
  $('podium').innerHTML = rows.length
    ? rows.map((r, i) => `<li>${i === 0 ? '🏆' : `${i + 1}.`} <span style="color:${playerColor(r.player.index, myIndex(finished))}">
        ${esc(r.player.id)}</span><span class="n">${r.planets} planets · ${r.ships} ships</span></li>`).join('')
    : '<li class="small">Nobody played this round.</li>';
  $('results-note').textContent = `Every browser computed this same result from ${finished.s.moves} finalized moves.`
    + (ui.sealsThisRound ? ` The round was sealed on Cardano ${ui.sealsThisRound} time(s).` : '');
  $('results').hidden = false;
}

let switching = false;
async function tickRound() {
  if (!galaxy || switching) return;
  const now = Date.now();
  const current = roundOf(CONFIG, now);
  if (current !== galaxy.round && now - galaxy.end > 2500) {
    // Give the last moves of the round time to finalize, then announce.
    switching = true;
    await sync();
    const finished = galaxy;
    if (finished.players.length) showResults(finished);
    await enterRound(current);
    switching = false;
  }
  renderTop();
}

// ---------------------------------------------------------------- the log

let syncing = null;
let again = false;
async function sync() {
  if (syncing) { again = true; return syncing; } // callers wait for the pass already running
  syncing = (async () => {
    do {
      again = false;
      const g = galaxy;
      const entries = await ledger.entriesFrom(CONFIG.movesChain, roundTopic(CONFIG, g.round), g.position.height);
      for (const entry of entries) {
        let result;
        try {
          result = await g.apply(entry, profiles.check);
        } catch {
          setTimeout(sync, 800); // a join waiting on the profile chain: retry, in order
          break;
        }
        if (!result.skipped) onApplied(g, entry, result);
      }
    } while (again);
  })();
  try {
    await syncing;
    $('banner').hidden = true;
  } catch (error) {
    reportReachability(error);
  } finally {
    syncing = null;
  }
}

function onApplied(g, entry, result) {
  const mine = ui.pending.get(entry.messageId);
  if (mine) {
    ui.pending.delete(entry.messageId);
    if (result.accepted) {
      ui.lastLatency = Date.now() - mine.submitted;
      $('lat').textContent = `${(ui.lastLatency / 1000).toFixed(1)} s`;
    } else {
      toast(`Your ${mine.kind === 'join' ? 'join' : 'launch'} was refused: ${result.reason}`, 'info');
    }
    if (mine.kind === 'join') ui.joining = false;
  }
  if (result.accepted) ui.recentMoves.push(entry.timestamp);
  const ms = mine && result.accepted ? `${(ui.lastLatency / 1000).toFixed(1)} s` : '';
  if (result.accepted && result.kind === 'join') {
    const home = g.planets[result.player.home];
    pushFeed(`${who(result.player)} took ${esc(home.name)}`, entry.height, ms);
    if (mine) toast(`You command ${home.name}. Drag to attack!`, 'info');
  } else if (result.accepted && result.kind === 'go') {
    const f = result.fleet;
    pushFeed(`${who(result.player)} → ${esc(g.planets[f.to].name)} <b>${f.milli / 1000}</b>`, entry.height, ms);
  } else if (mine) {
    pushFeed(`<span class="rej">refused: ${esc(result.reason)}</span>`, entry.height);
  }
  for (const e of g.s.events.filter((x) => x.kind === 'capture' && !ui.fedCaptures.has(x.seq))) {
    ui.fedCaptures.add(e.seq);
    pushFeed(`${who(g.players[e.owner])} captured ${esc(g.planets[e.planet].name)}`, entry.height);
  }
}

const who = (p) => `<b style="color:${playerColor(p.index, myIndex())}">${esc(p.id)}</b>`;
const roundLabel = (round) => round % 100000;
function pushFeed(html, height, ms = '') {
  ui.feed.unshift({ html, height, ms });
  ui.feed.length = Math.min(ui.feed.length, 40);
  $('feed').innerHTML = ui.feed.map((f) => `<li><span class="h">${f.height === '' ? '' : `#${f.height}`}</span>
    <span>${f.html}</span><span class="ms">${f.ms}</span></li>`).join('');
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(CONFIG.movesChain), ledger.anchor(CONFIG.movesChain)]);
    if (anchor && ui.anchor && anchor.anchoredHeight > ui.anchor.anchoredHeight) {
      renderer.seal();
      ui.sealsThisRound++;
      toast(`⚓ Sealed on Cardano · block #${anchor.anchoredHeight} · tx ${anchor.transactionHash.slice(0, 10)}…`);
    }
    ui.status = status;
    ui.anchor = anchor ?? ui.anchor;
    renderSide();
  } catch (error) {
    reportReachability(error);
  }
}

const reportReachability = (error) => showUnreachable($('banner'), error);

// ---------------------------------------------------------------- moves

const nextNonce = () => (ui.nonce = Math.max(Date.now(), ui.nonce + 1));

async function maybeJoin() {
  const c = ui.commander;
  const g = galaxy;
  if (!c || !g || !ui.roundReady || ui.joining || g.player(c.id) || Date.now() > g.end - 5000) return;
  if (g.players.length >= CONFIG.game.homes) { renderTop(); return; }
  ui.joining = true;
  try {
    const n = nextNonce();
    const sig = await c.sign(moveStatement(CONFIG, g.round, 'join', c.id, n, [c.pub]));
    const body = JSON.stringify({ t: 'join', id: c.id, pub: c.pub, n, sig });
    const { messageId } = await ledger.submit(CONFIG.movesChain, ui.relay, roundTopic(CONFIG, g.round), { body });
    ui.pending.set(messageId, { kind: 'join', at: performance.now(), submitted: Date.now() });
  } catch (error) {
    ui.joining = false;
    toast(`Join failed: ${error.message}`, 'info');
  }
}

async function launch(from, to) {
  const c = ui.commander;
  const g = galaxy;
  const me = c && g.player(c.id);
  if (!me) return;
  const view = g.clone();
  view.advanceTo(Date.now());
  const ships = Math.floor((Math.floor(view.shipsAt(view.planets[from], Date.now()) / 1000) * ui.ratio) / 100);
  if (ships < 1) { toast('Not enough ships there yet', 'info'); return; }
  try {
    const n = nextNonce();
    const sig = await c.sign(moveStatement(CONFIG, g.round, 'go', c.id, n, [from, to, ui.ratio]));
    const body = JSON.stringify({ t: 'go', id: c.id, n, from, to, pct: ui.ratio, sig });
    const submitted = Date.now();
    const { messageId } = await ledger.submit(CONFIG.movesChain, ui.relay, roundTopic(CONFIG, g.round), { body });
    ui.pending.set(messageId, { kind: 'go', from, to, ships, owner: me.index, at: performance.now(), submitted });
  } catch (error) {
    toast(`Launch failed: ${error.message}`, 'info');
  }
}

// ---------------------------------------------------------------- drawing

function frame() {
  if (galaxy) {
    const t = Math.max(galaxy.time, Math.min(Date.now(), galaxy.end));
    const view = galaxy.clone();
    view.advanceTo(t);
    const me = ui.commander ? (galaxy.player(ui.commander.id)?.index ?? -1) : -1;
    for (const [id, p] of ui.pending) if (performance.now() - p.at > 30_000) ui.pending.delete(id);
    renderer.frame(view, t, {
      me,
      selected: ui.selected,
      drag: ui.drag,
      pending: [...ui.pending.values()].filter((p) => p.kind === 'go'),
    });
    if (performance.now() - (frame.board ?? 0) > 500) {
      frame.board = performance.now();
      renderBoard(view, t, me);
    }
  }
  requestAnimationFrame(frame);
}

function renderBoard(view, t, me) {
  const rows = view.standings(t);
  $('board').innerHTML = rows.map((r) => `<li class="${r.player.index === me ? 'mine' : ''}">
      <span class="dot" style="background:${playerColor(r.player.index, me)};box-shadow:0 0 8px ${playerColor(r.player.index, me)}"></span>
      <span>${esc(r.player.id)}</span><span class="n">${r.planets} ◉</span><span class="n">${r.ships}</span></li>`).join('')
    || '<li class="small empty">No commanders yet — join to claim a home planet.</li>';
}

function renderTop() {
  if (!galaxy) return;
  const left = Math.max(0, galaxy.end - Date.now());
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  $('round').innerHTML = `Round <b>${roundLabel(galaxy.round)}</b> · <b>${m}:${String(s).padStart(2, '0')}</b> left · `
    + `${galaxy.players.length}/${CONFIG.game.homes} commanders`;
  const inRound = ui.commander && galaxy.player(ui.commander.id);
  $('join').hidden = !ui.commander || !!inRound || ui.joining || galaxy.players.length >= CONFIG.game.homes;
  $('hint').textContent = ui.mode === 'inspect' ? 'Click any planet to see who took it — and prove it against Cardano'
    : !ui.commander ? 'Sign in to play — or just watch the battle'
    : inRound ? 'Drag from your planet to any planet to launch a fleet'
      : ui.joining ? 'Joining… waiting for finality' : 'Join to claim a home planet';
  // moves per second, by certified block time over the last 10 seconds
  const since = Date.now() - 10_000;
  const recent = ui.recentMoves.filter((ts) => ts > since);
  ui.recentMoves = recent;
  $('mps').textContent = (recent.length / 10).toFixed(1);
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
      <b>${galaxy?.s.moves ?? 0}</b> moves this round → <b>${ui.sealsThisRound}</b> Cardano seal${ui.sealsThisRound === 1 ? '' : 's'}`;
    const behind = Math.max(0, (s?.tipHeight ?? a.anchoredHeight) - a.anchoredHeight);
    $('seal-bar').style.width = `${Math.min(100, behind * 10)}%`;
  }
  const c = ui.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c) {
    $('avatar').textContent = c.id[0];
    $('me-name').textContent = c.id;
    $('me-key').textContent = `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`
      + (ui.profileHeight ? ` · profile at height ${ui.profileHeight}` : '');
  }
}

// ---------------------------------------------------------------- input

const sky = $('sky');
function pointer(event) {
  const r = sky.getBoundingClientRect();
  return { x: event.clientX - r.left, y: event.clientY - r.top };
}
function myIndex(g = galaxy) {
  return ui.commander ? (g?.player(ui.commander.id)?.index ?? -1) : -1;
}
sky.addEventListener('pointerdown', (event) => {
  if (!galaxy) return;
  const { x, y } = pointer(event);
  const p = renderer.planetAt(galaxy.planets, x, y);
  const me = myIndex();
  if (p && (ui.mode === 'inspect' || (ui.selected === null && p.owner !== me))) {
    openPlanet(p.id); // inspecting, or tapping a planet you cannot launch from
    return;
  }
  if (p && me >= 0 && ui.selected !== null && ui.selected !== p.id && !ui.drag) {
    // tap-tap: a selected planet, then a target
    launch(ui.selected, p.id);
    ui.selected = null;
    return;
  }
  if (p && me >= 0 && p.owner === me) {
    sky.setPointerCapture(event.pointerId);
    const view = galaxy.clone();
    view.advanceTo(Date.now());
    ui.drag = { from: p.id, x, y, ships: Math.floor((Math.floor(view.shipsAt(view.planets[p.id], Date.now()) / 1000) * ui.ratio) / 100), moved: false };
  } else {
    ui.selected = null;
  }
});
sky.addEventListener('pointermove', (event) => {
  if (!ui.drag) return;
  const { x, y } = pointer(event);
  ui.drag.moved ||= Math.hypot(x - ui.drag.x, y - ui.drag.y) > 6;
  Object.assign(ui.drag, { x, y });
});
sky.addEventListener('pointerup', (event) => {
  if (!ui.drag) return;
  const { x, y } = pointer(event);
  const target = renderer.planetAt(galaxy.planets, x, y);
  if (target && target.id !== ui.drag.from) launch(ui.drag.from, target.id);
  else if (!ui.drag.moved) ui.selected = ui.drag.from; // a tap selects; tap a target next
  ui.drag = null;
});

$('ratio').innerHTML = CONFIG.game.ratios.map((r) =>
  `<button data-r="${r}" role="radio" aria-checked="${r === ui.ratio}" class="${r === ui.ratio ? 'on' : ''}">${r}%</button>`).join('');
function setRatio(r) {
  ui.ratio = r;
  document.querySelectorAll('#ratio button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.r) === r);
    b.setAttribute('aria-checked', String(Number(b.dataset.r) === r));
  });
}
$('ratio').addEventListener('click', (event) => { if (event.target.dataset.r) setRatio(Number(event.target.dataset.r)); });
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select')) return;
  const i = ['1', '2', '3', '4'].indexOf(event.key);
  if (i >= 0) setRatio(CONFIG.game.ratios[i]);
  if (event.key === 'Escape') ui.selected = null;
  if (event.key === 'i') setMode(ui.mode === 'inspect' ? 'command' : 'inspect');
});

$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (event) => { ui.relay = session.relay = Number(event.target.value); });
$('open-auth').addEventListener('click', () => session.open());
$('join').addEventListener('click', maybeJoin);
$('results-close').addEventListener('click', () => { $('results').hidden = true; });
$('signout').addEventListener('click', () => { session.signOut(); session.open('signin'); });

// ---------------------------------------------------------------- proofs

function setMode(mode) {
  ui.mode = mode;
  ui.selected = null;
  document.querySelectorAll('#mode button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  });
  sky.style.cursor = mode === 'inspect' ? 'help' : 'crosshair';
  renderTop();
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function openPlanet(id) {
  const g = galaxy;
  const p = g.planets[id];
  const now = Math.min(Date.now(), g.end);
  const view = g.clone();
  view.advanceTo(now);
  const vp = view.planets[id];
  const owner = vp.owner >= 0 ? view.players[vp.owner] : null;
  const taken = vp.taken;
  const final = p.taken && taken && p.taken.messageId === taken.messageId; // not just predicted
  const color = (i) => playerColor(i, myIndex());
  let how = 'Neutral — nobody has taken it this round.';
  if (taken?.kind === 'join') {
    how = `Claimed as a home planet by ${owner ? `<b style="color:${color(owner.index)}">${esc(owner.id)}</b>` : '?'}
      when they joined, in block #${taken.height} at ${fmtTime(taken.time)}.`;
  } else if (taken?.kind === 'capture') {
    const by = view.players[taken.owner];
    how = `Captured by <b style="color:${color(by.index)}">${esc(by.id)}</b>’s fleet from
      ${esc(view.planets[taken.from].name)}, launched in block #${taken.height} and arriving at ${fmtTime(taken.time)}.`;
  }
  const holder = taken ? view.players[taken.owner] : null;
  const body = panel.open(vp.name, `
    <dl class="facts">
      <dt>Held by</dt><dd>${owner ? `<b style="color:${color(owner.index)}">${esc(owner.id)}</b>` : 'nobody'}</dd>
      <dt>Ships now</dt><dd>${Math.floor(view.shipsAt(vp, now) / 1000)} · size ${vp.size}</dd>
      <dt>How</dt><dd>${how}</dd>
      ${taken ? `<dt>Move</dt><dd class="mono">${taken.messageId}</dd>` : ''}
    </dl>
    ${taken && !final ? '<div class="sealed wait">This capture is still in flight on your screen — wait for the next block to prove it.</div>' : ''}
    <div class="row">
      ${taken && final ? `<button class="btn primary" id="prove-move">Prove the ${taken.kind === 'join' ? 'join' : 'launch'}</button>` : ''}
      ${holder ? `<button class="btn" id="prove-holder">Prove ${esc(holder.id)}’s profile</button>` : ''}
    </div>
    <div class="proof-out"></div>`);
  if (taken && final) {
    body.querySelector('#prove-move').onclick = () => panel.run(() => proveMove(CONFIG, ledger, g, p.taken,
      g.players[p.taken.owner], { threshold: ui.status?.threshold ?? 1 }),
      `${taken.kind === 'join' ? 'join' : 'launch'} by ${g.players[p.taken.owner].id}`);
  }
  if (holder) body.querySelector('#prove-holder').onclick = () => runProfile(holder.id, holder.pub);
}

function openProfile(id, pub) {
  panel.open(`Commander ${id}`, `
    <dl class="facts">
      <dt>Call sign</dt><dd><b>${esc(id)}</b></dd>
      <dt>Stored at</dt><dd class="mono">${esc(ACCOUNTS.profilesChain)} · ${esc(ACCOUNTS.profilesCollection)}</dd>
      <dt>Holds</dt><dd>public key, PBKDF2 salt and the password-locked signing key — never the password</dd>
    </dl>
    <div class="proof-out"></div>`);
  runProfile(id, pub);
}

function runProfile(id, pub) {
  return panel.run(() => proveProfile(ledger, profiles, id, { threshold: ui.status?.threshold ?? 1, expectPub: pub }),
    `${id}’s profile`);
}

document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('prove-me').addEventListener('click', () => openProfile(ui.commander.id, ui.commander.pub));

// ---------------------------------------------------------------- start

if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
session.onChange((commander) => {
  ui.commander = commander;
  ui.profileHeight = session.profileHeight;
  renderSide();
  maybeJoin();
});
if (!(await session.restore())) session.open();
requestAnimationFrame(frame);
await Promise.all([refreshMeta(), enterRound(roundOf(CONFIG, Date.now()))]);
setInterval(tickRound, 500);
setInterval(refreshMeta, 3000);
