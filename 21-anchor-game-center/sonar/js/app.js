// UI wiring for Deep Sonar. The rules are sonar.js; this file keeps the lobby
// and the open battle in step with the ledger, keeps your fleet and its secret
// on this device, answers shots at you with Merkle proofs automatically, and
// draws the two seas.

import { CONFIG } from './config.js';
import { Battle, DEPTH, Lobby, answerFor, battleTopic, climb, fleetRoot, lobbyOf, lobbyTopic, merkleLevels, randomFleet,
  statement } from './sonar.js';
import { Renderer } from './render.js';
import { coord, proveBattle, proveShot } from './proofs.js';
import { applyProxy, withQuery } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { ProofPanel, esc, reportReachability, toast } from '../../shared/ui.js';
import { ed25519Supported, randomBytes, toHex } from '../../shared/crypto.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
const panel = new ProofPanel();
const renderer = new Renderer($('sea'), CONFIG);
$('back').href = withQuery('../');

const cryptoInt = (n) => randomBytes(4).reduce((a, b) => a * 256 + b, 0) % n;
const fleetKey = (root) => `${CONFIG.app}:fleet:${root}`;
const ui = {
  draft: null, // { board, secret, root } shown in the lobby
  hover: null,
  aim: null,
  sent: new Set(),
  pendingLobby: new Map(),
  nonce: 0,
  status: null,
  ready: false,
};
let lobby = new Lobby(CONFIG);
let battle = null;
let battleId = null;
let myFleet = null; // { board, secret, levels } for the open battle, if you play in it
let stopLobby = null;
let stopBattle = null;
const me = () => session.commander?.id ?? null;
const mySeat = () => (battle && me() ? battle.seat(me()) : -1);
const nextNonce = () => (ui.nonce = Math.max(Date.now(), ui.nonce + 1));

function shuffle() {
  const board = randomFleet(CONFIG, cryptoInt);
  const secret = toHex(randomBytes(32));
  ui.draft = { board, secret, root: fleetRoot(CONFIG, board, secret) };
  $('root').textContent = `fleet root ${ui.draft.root.slice(0, 24)}…`;
}

function keepFleet(f) {
  try { localStorage.setItem(fleetKey(f.root), JSON.stringify({ board: f.board, secret: f.secret })); } catch { /* the battle needs this tab */ }
}

function loadFleet(root) {
  try {
    const f = JSON.parse(localStorage.getItem(fleetKey(root)) ?? 'null');
    return f && fleetRoot(CONFIG, f.board, f.secret) === root ? { ...f, levels: merkleLevels(CONFIG, f.board, f.secret) } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- lobby

const lobbyTopics = () => {
  const hour = lobbyOf(CONFIG, Date.now());
  return [lobbyTopic(CONFIG, hour - 1), lobbyTopic(CONFIG, hour)];
};

let syncingLobby = null;
let lobbyAgain = false;
async function syncLobby() {
  if (syncingLobby) { lobbyAgain = true; return syncingLobby; }
  syncingLobby = (async () => {
    do {
      lobbyAgain = false;
      const from = lobby.position.height;
      const lists = await Promise.all(lobbyTopics().map((t) => ledger.entriesFrom(CONFIG.movesChain, t, from)));
      const entries = lists.flat().sort((a, b) => a.height - b.height || a.index - b.index);
      for (const entry of entries) {
        let result;
        try { result = await lobby.apply(entry, session.profiles.check); } catch { setTimeout(syncLobby, 800); break; }
        if (!result.skipped) onLobby(entry, result);
      }
    } while (lobbyAgain);
  })();
  try { await syncingLobby; $('banner').hidden = true; } catch (error) { reportReachability($('banner'), error); } finally { syncingLobby = null; }
  renderLobby();
}

function onLobby(entry, result) {
  const mine = ui.pendingLobby.get(entry.messageId);
  if (mine) ui.pendingLobby.delete(entry.messageId);
  if (!result.accepted) { if (mine) toast(`Your ${mine} was refused: ${result.reason}`, 'info'); return; }
  if (result.kind !== 'accept') { if (mine) toast('Challenge posted — your fleet root is on the ledger', 'info'); return; }
  const c = lobby.challenges.get(result.battleId);
  const amIn = me() && (c.id === me() || c.opponent.id === me());
  if (amIn && !battleId && (mine || Date.now() - entry.timestamp < 60_000)) {
    toast(`${c.id} vs ${c.opponent.id} — battle stations`, 'info');
    location.hash = `battle=${result.battleId}`;
  }
}

function watchLobby() {
  stopLobby?.();
  const stops = lobbyTopics().map((t) => ledger.watch(CONFIG.movesChain, t, 0, syncLobby, 2000));
  stopLobby = () => stops.forEach((s) => s());
  stopLobby.hour = lobbyOf(CONFIG, Date.now());
}

async function postLobby(kind, extra, topic) {
  const c = session.commander;
  if (!c) { session.open(); return; }
  const f = ui.draft;
  keepFleet(f);
  try {
    const n = nextNonce();
    const fields = kind === 'challenge' ? [n, f.root] : [n, extra.challenge, f.root];
    const sig = await c.sign(statement(CONFIG, 'lobby', kind, c.id, ...fields));
    const body = JSON.stringify({ t: kind, id: c.id, pub: c.pub, n, ...extra, root: f.root, sig });
    const { messageId } = await ledger.submit(CONFIG.movesChain, session.relay, topic, { body });
    ui.pendingLobby.set(messageId, kind);
  } catch (error) {
    toast(`Could not ${kind}: ${error.message}`, 'info');
  }
}

function renderLobby() {
  const now = Date.now();
  $('open').innerHTML = lobby.open(now).map((c) => {
    const left = Math.max(0, Math.ceil((c.timestamp + CONFIG.challengeMs - now) / 60_000));
    return `<li><b>${esc(c.id)}</b><span class="small">root ${c.root.slice(0, 8)}… · ${left} min left</span>
      ${c.id === me() ? '<span class="small">yours</span>' : `<button class="btn primary" data-accept="${c.battleId}">Accept</button>`}</li>`;
  }).join('') || '<li class="empty">No open challenges. Post one and wait for a rival.</li>';
  const live = [...lobby.challenges.entries()].filter(([, c]) => c.opponent)
    .sort(([, a], [, b]) => b.opponent.timestamp - a.opponent.timestamp).slice(0, 8);
  $('live').innerHTML = live.map(([id, c]) => {
    const mine = me() && (c.id === me() || c.opponent.id === me());
    return `<li><b>${esc(c.id)}</b> vs <b>${esc(c.opponent.id)}</b>
      <a class="btn ${mine ? 'primary' : ''}" href="#battle=${id}">${mine ? 'Play' : 'Watch'}</a></li>`;
  }).join('') || '<li class="empty">No battles yet this hour.</li>';
}

// ---------------------------------------------------------------- battle

async function enterBattle(id) {
  stopBattle?.();
  const challenge = lobby.challenges.get(id);
  if (!challenge?.opponent) { toast('That battle is not in this hour’s or last hour’s lobby', 'info'); location.hash = ''; return; }
  battleId = id;
  battle = new Battle(CONFIG, id, challenge);
  ui.sent.clear();
  ui.aim = null;
  ui.ready = false;
  $('log').innerHTML = '';
  $('merkle').innerHTML = '';
  const seat = mySeat();
  myFleet = seat >= 0 ? loadFleet(battle.players[seat].root) : null;
  if (seat >= 0 && !myFleet) toast('This browser does not hold your fleet for this battle — it cannot answer shots', 'info');
  stopBattle = ledger.watch(CONFIG.movesChain, battleTopic(CONFIG, id), 0, syncBattle, 1000);
  await syncBattle();
  ui.ready = true;
  render();
}

function leaveBattle() {
  stopBattle?.();
  stopBattle = null;
  battle = null;
  battleId = null;
  myFleet = null;
  render();
}

let syncingBattle = null;
let battleAgain = false;
async function syncBattle() {
  if (!battle) return null;
  if (syncingBattle) { battleAgain = true; return syncingBattle; }
  syncingBattle = (async () => {
    do {
      battleAgain = false;
      const b = battle;
      const entries = await ledger.entriesFrom(CONFIG.movesChain, battleTopic(CONFIG, b.battleId), b.position.height);
      for (const entry of entries) {
        if (b !== battle) return;
        const result = await b.apply(entry);
        if (!result.skipped) onBattle(entry, result);
      }
    } while (battleAgain);
  })();
  try { await syncingBattle; } catch (error) { reportReachability($('banner'), error); } finally { syncingBattle = null; }
  act();
  render();
}

/** The board a seat's waters are drawn on: your own on the left, the enemy's on the right. */
const boardOf = (seat) => (mySeat() >= 0 ? (seat === mySeat() ? 0 : 1) : seat);

function onBattle(entry, result) {
  const names = battle.players.map((p) => p.id);
  if (result.expired === 'timeout') log(`<span class="bad">${esc(battle.reason)}</span>`, entry.height);
  if (!result.accepted) {
    if (result.kind || result.reason?.includes('does not match')) log(`<span class="bad">refused: ${esc(result.reason)}</span>`, entry.height);
    return;
  }
  if (result.kind === 'shot') {
    if (ui.ready) renderer.fire(boardOf(1 - result.seat), result.cell);
    if (result.seat === mySeat()) ui.aim = result.cell;
    log(`${esc(names[result.seat])} fired at <b>${coord(CONFIG, result.cell)}</b>`, entry.height);
  } else if (result.kind === 'answer') {
    const r = result.record;
    const hit = r.ship > 0;
    if (r.by === mySeat()) ui.aim = null;
    if (ui.ready) renderer.impact(boardOf(result.seat), r.cell, hit, r.sunk);
    const what = hit ? `<span class="hit">HIT</span>${r.sunk ? ` — ${CONFIG.shipNames[r.sunk - 1]} sunk!` : ''}` : '<span class="miss">miss</span>';
    log(`${esc(names[result.seat])}: ${coord(CONFIG, r.cell)} ${what} · proof ✓ <button class="link" data-shot="${battle.shots.length - 1}">prove</button>`, entry.height);
    showMerkle(r, result.seat);
    if (ui.ready && r.sunk) toast(`${names[result.seat]}’s ${CONFIG.shipNames[r.sunk - 1]} is sunk`, r.by === mySeat() ? '' : 'info');
  } else if (result.kind === 'reveal') {
    log(`${esc(names[result.seat])} revealed their fleet: ${result.legal ? 'it matches the root and is legal ✓' : '<span class="bad">not legal ✗</span>'}`, entry.height);
  }
  if (battle.done && ui.ready && !ui.toldEnd) {
    ui.toldEnd = true;
    const text = battle.winner === -1 ? 'A draw' : battle.winner === mySeat() ? 'Victory!' : mySeat() < 0 ? `${names[battle.winner]} wins` : 'Defeat';
    toast(`${text} — ${battle.reason}`);
  }
}

function showMerkle(r, seat) {
  const steps = climb(CONFIG, r.cell, r.ship, r.salt, r.path);
  const root = battle.players[seat].root;
  $('merkle').innerHTML = [
    `<li>${coord(CONFIG, r.cell)}: <b>${r.ship ? `ship ${r.ship}` : 'water'}</b>, salt ${r.salt.slice(0, 8)}…</li>`,
    ...steps.slice(0, DEPTH).map((h, i) => `<li style="animation-delay:${i * 70}ms">${i ? `level ${i}` : 'leaf'} ${h.slice(0, 16)}…</li>`),
    `<li class="root" style="animation-delay:${DEPTH * 70}ms">root ${steps[DEPTH].slice(0, 16)}… ${steps[DEPTH] === root ? '= committed ✓' : '≠ committed ✗'}</li>`,
  ].join('');
}

/** Your page's automatic duties: answer shots at you, claim missed deadlines, reveal at the end. */
async function act() {
  const c = session.commander;
  const seat = mySeat();
  if (!battle || !c || seat < 0 || battle.done) return;
  const send = async (key, kind, fields, body) => {
    if (ui.sent.has(key)) return;
    ui.sent.add(key);
    try {
      const sig = await c.sign(statement(CONFIG, battleId, kind, c.id, ...fields));
      await ledger.submit(CONFIG.movesChain, session.relay, battleTopic(CONFIG, battleId),
        { body: JSON.stringify({ t: kind, id: c.id, ...body, sig }) });
    } catch (error) {
      ui.sent.delete(key);
      toast(`Could not send: ${error.message}`, 'info');
    }
  };
  if (battle.phase === 'answer' && battle.turn !== seat && myFleet) {
    const s = battle.pendingShot;
    const a = answerFor(CONFIG, myFleet.board, myFleet.secret, s.cell, myFleet.levels);
    await send(`answer:${s.k}`, 'answer', [s.k, a.cell, a.ship, a.salt], { k: s.k, cell: a.cell, ship: a.ship, salt: a.salt, path: a.path });
  }
  if (battle.phase === 'reveal' && !battle.reveals[seat] && myFleet) {
    const board = myFleet.board.join('');
    await send('reveal', 'reveal', [board, myFleet.secret], { board, secret: myFleet.secret });
  }
  const d = battle.deadline();
  const theirDuty = (battle.phase === 'shot' && battle.turn !== seat) || (battle.phase === 'answer' && battle.turn === seat)
    || (battle.phase === 'reveal' && !battle.reveals[1 - seat]);
  if (d && theirDuty && Date.now() > d + 1500) await send(`forfeit:${battle.k}:${battle.phase}`, 'forfeit', [battle.k], { k: battle.k });
}

async function fire(cell) {
  const c = session.commander;
  const seat = mySeat();
  if (!battle || seat < 0 || battle.phase !== 'shot' || battle.turn !== seat) return;
  if (battle.known[1 - seat].has(cell) || ui.sent.has(`shot:${battle.k}`)) return;
  const k = battle.k;
  ui.sent.add(`shot:${k}`);
  ui.aim = cell;
  try {
    const sig = await c.sign(statement(CONFIG, battleId, 'shot', c.id, k, cell));
    await ledger.submit(CONFIG.movesChain, session.relay, battleTopic(CONFIG, battleId),
      { body: JSON.stringify({ t: 'shot', id: c.id, k, cell, sig }) });
  } catch (error) {
    ui.sent.delete(`shot:${k}`);
    ui.aim = null;
    toast(`Could not fire: ${error.message}`, 'info');
  }
}

// ---------------------------------------------------------------- drawing

function frame(t) {
  const seat = mySeat();
  let view;
  if (!battle) {
    view = { now: t, mine: ui.draft?.board ?? null, enemy: { known: new Map(), sunk: new Set() }, incoming: { known: new Map() },
      labels: ['YOUR FLEET (only in this browser)', 'ENEMY WATERS'] };
  } else {
    const enemySeat = seat >= 0 ? 1 - seat : 1;
    const homeSeat = seat >= 0 ? seat : 0;
    const sunk = new Set(CONFIG.fleet.map((len, k) => (battle.shipHits[enemySeat][k + 1] === len ? k + 1 : 0)).filter(Boolean));
    const pending = battle.pendingShot;
    view = {
      now: t,
      mine: seat >= 0 ? myFleet?.board ?? null : battle.reveals[0]?.board ?? null,
      incoming: { known: battle.known[homeSeat] },
      enemy: { known: battle.known[enemySeat], sunk, board: battle.reveals[enemySeat]?.board ?? null },
      hover: ui.hover,
      canFire: seat >= 0 && battle.phase === 'shot' && battle.turn === seat,
      aim: pending && pending.by === (seat >= 0 ? seat : 0) ? pending.cell : ui.aim,
      incomingAim: pending && pending.by === enemySeat ? pending.cell : null,
      labels: seat >= 0 ? ['YOUR WATERS', `${battle.players[enemySeat].id.toUpperCase()}’S WATERS · SONAR`]
        : [`${battle.players[0].id.toUpperCase()}’S WATERS`, `${battle.players[1].id.toUpperCase()}’S WATERS`],
    };
  }
  renderer.frame(view);
  requestAnimationFrame(frame);
}

function log(html, height) {
  const el = $('log');
  el.insertAdjacentHTML('afterbegin', `<li><span class="h">#${height}</span><span>${html}</span></li>`);
  while (el.children.length > 80) el.lastElementChild.remove();
}

function render() {
  $('lobby').hidden = !!battle;
  $('battle-card').hidden = !battle;
  $('merkle-card').hidden = !battle || !battle.shots.length;
  $('log-card').hidden = !battle;
  const c = session.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c) {
    $('avatar').textContent = c.id[0];
    $('me-name').textContent = c.id;
    $('me-key').textContent = `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`;
  }
  renderStatus();
  if (!battle) { $('vs').textContent = 'Lobby'; return; }
  const names = battle.players.map((p) => p.id);
  $('vs').innerHTML = `<b>${esc(names[0])}</b> vs <b>${esc(names[1])}</b> · battle <b>#${battleId.slice(0, 6)}…</b>`;
  $('fleets').innerHTML = [0, 1].map((s) => {
    const ships = CONFIG.fleet.map((len, k) => (battle.shipHits[s][k + 1] === len ? `<s>${CONFIG.shipNames[k]}</s>` : CONFIG.shipNames[k])).join(' · ');
    return `<div class="fleet"><div class="who"><b>${esc(names[s])}</b><span class="small">${battle.hits[s]} / 17 hits taken</span></div>
      <div class="bar"><span style="width:${(battle.hits[s] / 17) * 100}%"></span></div><div class="ships">${ships}</div>
      <div class="small mono">root ${battle.players[s].root.slice(0, 16)}…</div></div>`;
  }).join('');
  $('prove-battle').hidden = !battle.done || !battle.reveals.some(Boolean);
}

function renderStatus() {
  if (!battle) {
    $('what').textContent = 'Choose your fleet, then challenge or accept';
    $('what').className = 'what';
    $('sub').textContent = ui.draft ? `only the root ${ui.draft.root.slice(0, 16)}… goes on the ledger` : '';
    return;
  }
  const seat = mySeat();
  const names = battle.players.map((p) => p.id);
  const d = battle.deadline();
  const left = d ? Math.max(0, Math.ceil((d - Date.now()) / 1000)) : null;
  let what;
  let sub = '';
  let mine = false;
  if (battle.done) {
    what = battle.winner === -1 ? 'Draw' : seat < 0 ? `${names[battle.winner]} wins` : battle.winner === seat ? 'Victory' : 'Defeat';
    sub = battle.reason;
  } else if (battle.phase === 'shot') {
    mine = battle.turn === seat;
    what = mine ? 'Your turn — fire at the sonar screen' : `${names[battle.turn]} is aiming…`;
    sub = `shot ${battle.k} · ${left} s to fire`;
  } else if (battle.phase === 'answer') {
    const def = 1 - battle.turn;
    what = def === seat ? 'Incoming! Answering with a Merkle proof…' : `Waiting for ${names[def]}’s answer`;
    sub = `${coord(CONFIG, battle.pendingShot.cell)} · ${left} s to answer`;
  } else {
    what = 'A fleet is sunk — both reveal their boards';
    sub = `${left} s to reveal · revealed: ${[0, 1].filter((s) => battle.reveals[s]).map((s) => names[s]).join(', ') || 'nobody yet'}`;
  }
  $('what').textContent = what;
  $('what').className = mine ? 'what turn' : 'what';
  $('sub').textContent = sub;
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(CONFIG.movesChain), ledger.anchor(CONFIG.movesChain)]);
    ui.status = status;
    $('blk').textContent = `#${status.tipHeight.toLocaleString()}`;
    $('fin').textContent = `${status.threshold} of ${status.members}`;
    $('sealed').textContent = anchor ? `#${anchor.anchoredHeight.toLocaleString()}` : '—';
  } catch (error) {
    reportReachability($('banner'), error);
  }
}

function commitOf(seat) {
  const c = lobby.challenges.get(battleId);
  return seat === 0 ? c : c.opponent;
}

// ---------------------------------------------------------------- input

const sea = $('sea');
sea.addEventListener('mousemove', (e) => {
  const at = renderer.cellAt(e.clientX, e.clientY);
  ui.hover = at && at.board === 1 ? at.cell : null;
});
sea.addEventListener('mouseleave', () => { ui.hover = null; });
sea.addEventListener('click', (e) => {
  const at = renderer.cellAt(e.clientX, e.clientY);
  if (at?.board === 1) fire(at.cell);
});
$('shuffle').addEventListener('click', () => { shuffle(); renderStatus(); });
$('challenge').addEventListener('click', () => postLobby('challenge', {}, lobbyTopic(CONFIG, lobbyOf(CONFIG, Date.now()))));
$('open').addEventListener('click', (e) => {
  const id = e.target.dataset?.accept;
  if (id) postLobby('accept', { challenge: id }, lobbyTopic(CONFIG, lobbyOf(CONFIG, lobby.challenges.get(id).timestamp)));
});
$('log').addEventListener('click', (e) => {
  const i = e.target.dataset?.shot;
  if (i === undefined) return;
  const r = battle.shots[Number(i)];
  const def = 1 - r.by;
  panel.open(`Shot ${r.k}: ${coord(CONFIG, r.cell)}`, `
    <dl class="facts"><dt>Fired by</dt><dd>${esc(battle.players[r.by].id)} · block #${r.shot.height}</dd>
      <dt>Answer</dt><dd>${r.ship ? `hit — ${CONFIG.shipNames[r.ship - 1]}` : 'miss'} · block #${r.answer.height}</dd>
      <dt>Committed root</dt><dd class="mono">${battle.players[def].root}</dd></dl><div class="proof-out"></div>`);
  panel.run(() => proveShot(CONFIG, ledger, battle, r, commitOf(def), { threshold: ui.status?.threshold ?? 1 }), `Shot ${r.k}`);
});
$('prove-battle').addEventListener('click', () => {
  panel.open(`Battle #${battleId.slice(0, 6)}…`, '<div class="proof-out"></div>');
  panel.run(() => proveBattle(CONFIG, ledger, battle, { threshold: ui.status?.threshold ?? 1 }), 'The result');
});
$('to-lobby').addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (e) => { session.relay = Number(e.target.value); });
$('open-auth').addEventListener('click', () => session.open());
$('signout').addEventListener('click', () => { session.signOut(); session.open('signin'); });

function route() {
  const m = /^#battle=([0-9a-f]{64})$/.exec(location.hash);
  if (m && m[1] !== battleId) enterBattle(m[1]);
  else if (!m && battle) leaveBattle();
}
addEventListener('hashchange', route);

// ---------------------------------------------------------------- start

if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
shuffle();
session.onChange(() => { render(); renderLobby(); });
await session.restore();
requestAnimationFrame(frame);
render();
watchLobby();
await Promise.all([refreshMeta(), syncLobby()]);
route();
setInterval(() => {
  if (stopLobby?.hour !== lobbyOf(CONFIG, Date.now())) watchLobby();
  renderLobby();
  if (battle) act();
  render();
}, 1000);
setInterval(refreshMeta, 5000);
