// UI wiring for Sealed Duels. The rules are duels.js; this file keeps the
// lobby and the open duel in step with the ledger, keeps your secrets on this
// device until you reveal them, and draws the arena.
//
// The plugin edition (?engine=plugin) plays the same game on duels-chain,
// where the members run the rules (plugin/). The page then asks the members'
// rules before sending a move, reads each duel's committed record, checks it
// against its own replay, and proves the record against the Cardano anchor.

import { CONFIG } from './config.js';
import { Duel, Lobby, duelTopic, lobbyOf, lobbyTopic, sealHash, statement } from './duels.js';
import { Arena } from './render.js';
import { proveDuel, proveRound } from './proofs.js';
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
const arena = new Arena($('arena'), CONFIG);
$('back').href = withQuery('../');
const PLUGIN = CONFIG.engine === 'plugin';
const COLORS = ['#3ee6ff', '#ff4fd8'];
const OTHER = '#ff4fd8';

const ui = {
  status: null,
  nonce: 0,
  chosen: null,
  pendingLobby: new Map(), // messageId → kind
  sent: new Set(), // "round:kind" already submitted in this duel
  sealSubmitted: null, // performance.now() of the last seal submission
  duelReady: false,
  ledger: null, // plugin edition: { record, committedHeight, stateRoot, agree: true | false | null, misses }
  refused: [], // plugin edition: moves the members refused before storing them
};
let lobby = new Lobby(CONFIG);
let duel = null;
let duelId = null;
let stopLobby = null;
let stopDuel = null;
const me = () => session.commander?.id ?? null;
const mySeat = () => (duel && me() ? duel.seat(me()) : -1);
const nextNonce = () => (ui.nonce = Math.max(Date.now(), ui.nonce + 1));
const secretKey = (round) => `${CONFIG.app}:${duelId}:${round}`;

// ---------------------------------------------------------------- submit

/**
 * Send a move. The plugin edition first asks the members' rules (the
 * read-only `admit` query on committed state): a refused move is never sent.
 * Hosts from Yano 0.1.0-pre17 also refuse at submit, with HTTP 400 and the
 * code; older hosts drop a refused move when building the block.
 */
async function submit(topic, body) {
  if (PLUGIN) {
    const verdict = JSON.parse((await ledger.query(CONFIG.movesChain, 'admit', `${topic}\n${body}`)).payload);
    if (!verdict.accepted) throw refusal(verdict.code, verdict.reason);
  }
  try {
    return await ledger.submit(CONFIG.movesChain, session.relay, topic, { body });
  } catch (error) {
    let answer = null;
    try { answer = error.status === 400 ? JSON.parse(error.body) : null; } catch { /* not JSON */ }
    if (PLUGIN && answer) throw refusal(answer.code ?? answer.reason ?? 'REFUSED', answer.error ?? answer.reason ?? '');
    throw error;
  }
}

function refusal(code, reason) {
  ui.refused.unshift({ code, reason });
  ui.refused.length = Math.min(ui.refused.length, 5);
  log(`<span class="bad">the members refused it: <code>${esc(code)}</code> — ${esc(reason)}</span>`, null); // never stored
  renderRules();
  return Object.assign(new Error(`the members refused it: ${code} (${reason})`), { refused: true });
}

// ---------------------------------------------------------------- lobby

const lobbyTopics = () => {
  const hour = lobbyOf(CONFIG, Date.now());
  return [lobbyTopic(CONFIG, hour - 1), lobbyTopic(CONFIG, hour)];
};

// The plugin edition's call-sign rule lives in the fold itself (keyBinding).
const firstSeen = async () => ({ ok: true });

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
        try {
          result = await lobby.apply(entry, PLUGIN ? firstSeen : session.profiles.check);
        } catch {
          setTimeout(syncLobby, 800); // waiting on the profile chain: retry, in order
          break;
        }
        if (!result.skipped) onLobby(entry, result);
      }
    } while (lobbyAgain);
  })();
  try {
    await syncingLobby;
    $('banner').hidden = true;
  } catch (error) {
    reportReachability($('banner'), error);
  } finally {
    syncingLobby = null;
  }
  renderLobby();
}

function onLobby(entry, result) {
  const mine = ui.pendingLobby.get(entry.messageId);
  if (mine) ui.pendingLobby.delete(entry.messageId);
  if (!result.accepted) {
    if (mine) toast(`Your ${mine} was refused: ${result.reason}`, 'info');
    return;
  }
  if (result.kind !== 'accept') {
    if (mine) toast('Challenge posted — waiting for someone to accept', 'info');
    return;
  }
  const c = lobby.challenges.get(result.duelId);
  const amIn = me() && (c.id === me() || c.opponent.id === me());
  if (amIn && !duelId && (mine || Date.now() - entry.timestamp < 60_000)) {
    toast(`${c.id} vs ${c.opponent.id} — the duel begins`, 'info');
    location.hash = `duel=${result.duelId}`;
  }
}

function watchLobby() {
  stopLobby?.();
  const stops = lobbyTopics().map((t) => ledger.watch(CONFIG.movesChain, t, 0, syncLobby, 2000));
  stopLobby = () => stops.forEach((s) => s());
  stopLobby.hour = lobbyOf(CONFIG, Date.now());
}

async function postChallenge() {
  const c = session.commander;
  if (!c) { session.open(); return; }
  const rounds = Number($('rounds').value);
  try {
    const n = nextNonce();
    const sig = await c.sign(statement(CONFIG, 'lobby', 'challenge', c.id, n, rounds));
    const body = JSON.stringify({ t: 'challenge', id: c.id, pub: c.pub, n, rounds, sig });
    const { messageId } = await submit(lobbyTopic(CONFIG, lobbyOf(CONFIG, Date.now())), body);
    ui.pendingLobby.set(messageId, 'challenge');
  } catch (error) {
    toast(`Could not post the challenge: ${error.message}`, 'info');
  }
}

async function accept(id) {
  const c = session.commander;
  if (!c) { session.open(); return; }
  const challenge = lobby.challenges.get(id);
  try {
    const n = nextNonce();
    const sig = await c.sign(statement(CONFIG, 'lobby', 'accept', c.id, n, id));
    const body = JSON.stringify({ t: 'accept', id: c.id, pub: c.pub, n, challenge: id, sig });
    const { messageId } = await submit(lobbyTopic(CONFIG, lobbyOf(CONFIG, challenge.timestamp)), body);
    ui.pendingLobby.set(messageId, 'accept');
  } catch (error) {
    toast(`Could not accept: ${error.message}`, 'info');
  }
}

function renderLobby() {
  const now = Date.now();
  const open = lobby.open(now);
  $('open').innerHTML = open.map((c) => {
    const left = Math.max(0, Math.ceil((c.timestamp + CONFIG.challengeMs - now) / 60_000));
    return `<li><b>${esc(c.id)}</b><span class="small">best of ${c.rounds} · expires in ${left} min</span>
      ${c.id === me() ? '<span class="small">yours</span>' : `<button class="btn primary" data-accept="${c.duelId}">Accept</button>`}</li>`;
  }).join('') || '<li class="empty">No open challenges. Post one and wait for a rival.</li>';
  const live = [...lobby.challenges.entries()].filter(([, c]) => c.opponent)
    .sort(([, a], [, b]) => b.opponent.timestamp - a.opponent.timestamp).slice(0, 8);
  $('live').innerHTML = live.map(([id, c]) => {
    const mine = me() && (c.id === me() || c.opponent.id === me());
    return `<li><b>${esc(c.id)}</b> vs <b>${esc(c.opponent.id)}</b><span class="small">best of ${c.rounds}</span>
      <a class="btn ${mine ? 'primary' : ''}" href="#duel=${id}">${mine ? 'Play' : 'Watch'}</a></li>`;
  }).join('') || '<li class="empty">No duels yet this hour.</li>';
}

// ---------------------------------------------------------------- duel

async function enterDuel(id) {
  stopDuel?.();
  duelId = id;
  duel = null;
  ui.sent.clear();
  ui.chosen = null;
  ui.duelReady = false;
  ui.ledger = null;
  $('log').innerHTML = '';
  const challenge = lobby.challenges.get(id);
  if (!challenge?.opponent) {
    toast('That duel is not in this hour’s or last hour’s lobby', 'info');
    location.hash = '';
    return;
  }
  duel = new Duel(CONFIG, id, challenge);
  log(`Duel: <b>${esc(challenge.id)}</b> challenged, <b>${esc(challenge.opponent.id)}</b> accepted · best of ${challenge.rounds}`,
    challenge.opponent.height);
  stopDuel = ledger.watch(CONFIG.movesChain, duelTopic(CONFIG, id), 0, syncDuel, 1000);
  await syncDuel();
  ui.duelReady = true;
  render();
}

function leaveDuel() {
  stopDuel?.();
  stopDuel = null;
  duel = null;
  duelId = null;
  render();
}

let syncingDuel = null;
let duelAgain = false;
async function syncDuel() {
  if (!duel) return null;
  if (syncingDuel) { duelAgain = true; return syncingDuel; }
  syncingDuel = (async () => {
    do {
      duelAgain = false;
      const d = duel;
      const entries = await ledger.entriesFrom(CONFIG.movesChain, duelTopic(CONFIG, d.duelId), d.position.height);
      for (const entry of entries) {
        if (d !== duel) return;
        const result = await d.apply(entry);
        if (!result.skipped) onDuel(entry, result);
      }
    } while (duelAgain);
  })();
  try {
    await syncingDuel;
  } catch (error) {
    reportReachability($('banner'), error);
  } finally {
    syncingDuel = null;
  }
  act();
  render();
  checkLedger();
}

function onDuel(entry, result) {
  const name = (seat) => `<b style="color:${seat === mySeat() || (mySeat() < 0 && seat === 0) ? COLORS[0] : OTHER}">${esc(duel.players[seat].id)}</b>`;
  if (result.accepted) message(entry, result, name);
  for (const r of result.settled) settled(r, entry.height);
}

function message(entry, result, name) {
  if (result.kind === 'seal') {
    log(`${name(result.seat)} sealed <code>${duel.seals[result.seat]?.hash.slice(0, 10) ?? '…'}…</code>`, entry.height);
    if (result.seat === mySeat() && ui.sealSubmitted) {
      $('lat').textContent = `${((performance.now() - ui.sealSubmitted) / 1000).toFixed(1)} s`;
      ui.sealSubmitted = null;
    }
  } else if (result.kind === 'reveal') {
    const r = duel.reveals[result.seat] ?? duel.history.at(-1)?.reveals[result.seat];
    log(`${name(result.seat)} revealed ${esc(r?.move ?? '?')} · <span class="ok">matches the seal ✓</span>`, entry.height);
  } else if (result.kind === 'forfeit' && result.settled.length) {
    log('<span class="bad">a deadline passed — the missing move forfeits</span>', entry.height);
  }
}

function settled(r, height) {
  const p = duel.players.map((x) => x.id);
  const move = (seat) => (r.forfeited[seat] ? 'forfeit' : r.moves[seat] ?? 'sealed in time');
  log(`<span class="round-row">Round ${r.round}: ${esc(p[0])} ${move(0)} vs ${esc(p[1])} ${move(1)} → ${r.dealt[0]} / ${r.dealt[1]} damage
    ${r.die ? `· die ${r.die}${r.die === 6 ? ' CRIT' : ''}` : ''}</span> <button class="link" data-prove="${r.round}">prove</button>`, height);
  if (r.die) {
    $('die').textContent = r.die;
    $('dice-note').textContent = `Round ${r.round}: BLAKE2b of both secrets gives ${r.die}. ${r.die === 6 ? 'Critical — damage ×1.5!' : 'No critical this time.'}`;
  }
  if (ui.duelReady) {
    arena.play(r);
    const seat = Math.max(0, mySeat());
    outcome(`${CONFIG.moves.find((m) => m.id === r.moves[seat])?.name ?? 'Forfeit'} vs ${CONFIG.moves.find((m) => m.id === r.moves[1 - seat])?.name ?? 'forfeit'} — ${p[seat]} deals ${r.dealt[seat]}, takes ${r.dealt[1 - seat]}`);
    if (duel.done) setTimeout(() => toast(duel.winner === -1 ? 'A draw!' : `${p[duel.winner]} wins the duel`, 'info'), 1500);
  }
}

/** The player's automatic steps: reveal once both seals are final, claim missed deadlines. */
async function act() {
  const c = session.commander;
  const seat = mySeat();
  if (!duel || !c || seat < 0 || duel.done) return;
  const r = duel.round;
  const sign = (kind, ...fields) => c.sign(statement(CONFIG, duelId, kind, c.id, r, ...fields));
  const send = async (key, body) => {
    if (ui.sent.has(key)) return;
    ui.sent.add(key);
    try {
      await submit(duelTopic(CONFIG, duelId), JSON.stringify(body));
    } catch (error) {
      if (!error.refused) ui.sent.delete(key); // a refusal is final: do not resend it
      toast(`Could not send: ${error.message}`, 'info');
    }
  };
  if (duel.phase === 'reveal' && !duel.reveals[seat]) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(secretKey(r)) ?? 'null'); } catch { /* none */ }
    if (saved) await send(`${r}:reveal`, { t: 'reveal', id: c.id, round: r, move: saved.move, secret: saved.secret, sig: await sign('reveal', saved.move, saved.secret) });
  }
  const deadline = duel.deadline();
  if (deadline && Date.now() > deadline + 1500) {
    await send(`${r}:${duel.phase}:forfeit`, { t: 'forfeit', id: c.id, round: r, sig: await sign('forfeit') });
  }
}

async function seal() {
  const c = session.commander;
  const seat = mySeat();
  if (!duel || seat < 0 || !ui.chosen || duel.seals[seat]) return;
  const r = duel.round;
  const secret = toHex(randomBytes(16));
  try { localStorage.setItem(secretKey(r), JSON.stringify({ move: ui.chosen, secret })); } catch { /* reveal needs this tab */ }
  const hash = sealHash(CONFIG, duelId, r, c.id, ui.chosen, secret);
  const sig = await c.sign(statement(CONFIG, duelId, 'seal', c.id, r, hash));
  ui.sent.add(`${r}:seal`);
  ui.sealSubmitted = performance.now();
  try {
    await submit(duelTopic(CONFIG, duelId), JSON.stringify({ t: 'seal', id: c.id, round: r, hash, sig }));
  } catch (error) {
    ui.sent.delete(`${r}:seal`);
    toast(`Could not seal: ${error.message}`, 'info');
  }
  render();
}

// ---------------------------------------------------------------- ledger check

const comparable = (d) => JSON.stringify([d.hp, d.energy, d.round, d.phase, d.winner ?? null, d.history?.length ?? 0]);

/**
 * Plugin edition: read the duel record the members committed and compare it
 * with this browser's replay of the same finalized moves. A short mismatch is
 * just one side being a block ahead; a lasting one would be a real divergence.
 */
let checking = null;
async function checkLedger() {
  if (!PLUGIN || !duel || checking) return;
  const d = duel;
  checking = (async () => {
    const r = await ledger.query(CONFIG.movesChain, 'duel', d.duelId);
    if (d !== duel || !r) return;
    const record = JSON.parse(r.payload);
    const same = !!record && comparable(record) === comparable(d);
    const misses = same ? 0 : (ui.ledger?.misses ?? 0) + 1;
    ui.ledger = { record, committedHeight: r.committedHeight, stateRoot: r.stateRoot, misses,
      agree: same ? true : misses >= 4 ? false : null };
    renderRules();
  })();
  try { await checking; } catch { /* the next tick retries */ } finally { checking = null; }
}

function renderRules() {
  const el = $('rules');
  $('edition').classList.toggle('plugin', PLUGIN);
  if (!PLUGIN) {
    $('edition').innerHTML = 'rules: <b>your browser</b>';
    el.innerHTML = `<p>The members only order and finalize the moves on <code>${esc(CONFIG.movesChain)}</code>.
      Every browser runs the duel rules over them, so every browser reaches the same result.</p>
      <p><a href="${withQuery('./?engine=plugin')}">Play the plugin edition</a> — the same game, with the rules run by the members.</p>`;
    return;
  }
  $('edition').innerHTML = 'rules: <b>the members</b>';
  $('prove-row').hidden = !(duel && ui.ledger?.record);
  const l = ui.ledger;
  const refused = ui.refused.length
    ? `<p>Refused before storing: ${ui.refused.map((x) => `<code>${esc(x.code)}</code>`).join(' ')}</p>` : '';
  const intro = `<p>The members run <code>sealed-duels</code> on <code>${esc(CONFIG.movesChain)}</code>: a broken move is refused
    before it is stored, and each duel is a record in the state root. <a href="${withQuery('./')}">Browser edition</a></p>`;
  if (!duel) { el.innerHTML = intro + refused; return; }
  if (!l?.record) { el.innerHTML = `${intro}<p>Reading the committed duel record…</p>${refused}`; return; }
  const p = duel.players.map((x) => x.id);
  const rec = l.record;
  const verdict = l.agree === true ? '<span class="verdict ok">your browser’s replay agrees ✓</span>'
    : l.agree === false ? '<span class="verdict bad">your browser’s replay disagrees ✗</span>'
      : '<span class="verdict wait">your browser is a block apart — checking…</span>';
  el.innerHTML = `${intro}
    <dl><dt>${esc(p[0])}</dt><dd>${rec.hp[0]} HP · ${rec.energy[0]} energy</dd>
      <dt>${esc(p[1])}</dt><dd>${rec.hp[1]} HP · ${rec.energy[1]} energy</dd>
      <dt>Round</dt><dd>${rec.phase === 'done' ? `over after ${rec.history.length}` : `${rec.round} · ${rec.phase}`}</dd>
      <dt>Committed</dt><dd>height ${l.committedHeight} · root <code>${esc(l.stateRoot.slice(0, 12))}…</code></dd></dl>
    ${verdict}${refused}`;
}

async function openDuelProof() {
  if (!duel) return;
  const p = duel.players.map((x) => x.id);
  panel.open(`Duel #${duelId.slice(0, 6)}…`, `
    <dl class="facts">
      <dt>State key</dt><dd class="mono">duel/${esc(duelId.slice(0, 16))}…</dd>
      <dt>Players</dt><dd>${esc(p[0])} vs ${esc(p[1])} · best of ${duel.rounds}</dd>
      <dt>Rules</dt><dd>run by the members (<code>sealed-duels</code>), not replayed here</dd>
    </dl>
    <div class="proof-out"></div>`);
  panel.run(() => proveDuel(CONFIG, ledger, duel, { threshold: ui.status?.threshold ?? 1 }), `Duel #${duelId.slice(0, 6)}…`);
}

// ---------------------------------------------------------------- panels

function log(html, height) {
  const el = $('log');
  el.insertAdjacentHTML('afterbegin', `<li><span class="h">${height === null ? '✗' : `#${height}`}</span><span>${html}</span></li>`);
  while (el.children.length > 60) el.lastElementChild.remove();
}

let outcomeTimer;
function outcome(text) {
  $('outcome').textContent = text;
  $('outcome').classList.add('show');
  clearTimeout(outcomeTimer);
  outcomeTimer = setTimeout(() => $('outcome').classList.remove('show'), 3200);
}

function view() {
  if (!duel) return null;
  const seat = mySeat();
  const colors = seat === 1 ? [OTHER, COLORS[0]] : [COLORS[0], OTHER];
  return { names: duel.players.map((p) => p.id), colors, hp: duel.hp, energy: duel.energy,
    sealed: duel.seals.map(Boolean), revealed: duel.reveals.map(Boolean), done: duel.done };
}

function renderPhase() {
  renderRules();
  $('phase').hidden = !duel;
  $('lobby').hidden = !!duel;
  $('hand').hidden = !duel;
  $('duel-card').hidden = !duel;
  if (!duel) { $('vs').textContent = 'Lobby'; return; }
  const p = duel.players.map((x) => x.id);
  const seat = mySeat();
  $('vs').innerHTML = `<b>${esc(p[0])}</b> vs <b style="color:var(--pink)">${esc(p[1])}</b> · best of ${duel.rounds} · duel <b>#${duelId.slice(0, 6)}…</b>`;
  $('round').textContent = duel.done ? `After ${duel.history.length} rounds` : `Round ${duel.round} of ${duel.rounds}`;
  const left = duel.deadline() ? Math.max(0, Math.ceil((duel.deadline() - Date.now()) / 1000)) : null;
  let what;
  let sub;
  if (duel.done) {
    what = duel.winner === -1 ? 'Draw' : seat < 0 ? `${p[duel.winner]} wins` : duel.winner === seat ? 'Victory' : 'Defeat';
    sub = `${p[0]} ${duel.hp[0]} HP · ${p[1]} ${duel.hp[1]} HP — every move was sealed before it was revealed`;
  } else if (duel.phase === 'seal') {
    const mine = seat >= 0 && duel.seals[seat];
    const pending = seat >= 0 && !mine && ui.sent.has(`${duel.round}:seal`);
    what = seat < 0 ? 'Both are choosing…' : mine ? `Sealed — waiting for ${p[1 - seat]}` : pending ? 'Sealing your move…' : 'Choose your move';
    sub = mine ? `your seal is final at block #${duel.seals[seat].height} · ${p[1 - seat]} has ${left} s`
      : `nobody — not even the members — can see a move until it is revealed · ${left} s to seal`;
  } else {
    what = 'Both sealed — revealing';
    sub = `seals final at #${duel.seals[0].height} and #${duel.seals[1].height}: neither move can change now · ${left} s to reveal`;
  }
  $('what').textContent = what;
  $('sub').textContent = sub;
  $('duel-info').innerHTML = `${esc(p[0])} challenged ${esc(p[1])} · best of ${duel.rounds}<br>
    ${seat < 0 ? 'You are watching.' : `You are ${seat === 0 ? 'the challenger' : 'the challenged'}.`}
    Settled rounds: ${duel.history.length}.`;
}

function renderHand() {
  if (!duel) return;
  const seat = mySeat();
  const hand = $('hand');
  if (duel.done) {
    hand.innerHTML = `<div class="note">The duel is over. ${seat >= 0 ? '<button class="btn primary" id="rematch">Post a new challenge</button>' : ''}</div>`;
    $('rematch')?.addEventListener('click', () => { location.hash = ''; postChallenge(); });
    return;
  }
  if (seat < 0) {
    hand.innerHTML = '<div class="note">You are watching. Seals appear as locks; moves stay hidden until both are final.</div>';
    return;
  }
  const opp = 1 - seat;
  const sealedMine = duel.seals[seat] || ui.sent.has(`${duel.round}:seal`);
  if (sealedMine) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(secretKey(duel.round)) ?? 'null'); } catch { /* none */ }
    const name = CONFIG.moves.find((m) => m.id === saved?.move)?.name ?? 'Move';
    hand.innerHTML = `<div class="sealed-card"><div><div class="lock">🔒</div>${esc(name)} sealed<br>
      <code>${duel.seals[seat]?.hash.slice(0, 10) ?? 'finalizing'}…</code></div></div>
      <div class="sealed-card op"><div><div class="lock">${duel.seals[opp] ? '🔒' : '⏳'}</div>
      ${esc(duel.players[opp].id)} ${duel.seals[opp] ? 'sealed' : 'is choosing…'}<br><code>${duel.seals[opp]?.hash.slice(0, 10) ?? '········'}…</code></div></div>`;
    return;
  }
  hand.innerHTML = CONFIG.moves.map((m) => {
    const off = m.cost > duel.energy[seat];
    return `<button class="move ${ui.chosen === m.id ? 'on' : ''} ${off ? 'off' : ''}" data-m="${m.id}" style="--c:${m.color}">
      <span class="icon">${m.icon}</span><span class="name">${m.name}</span>
      <span class="cost">${m.cost > 0 ? `${m.cost} energy` : m.cost < 0 ? '+2 energy' : 'free'}</span><span class="fx">${m.fx}</span></button>`;
  }).join('') + `<button class="btn primary seal" id="seal" ${ui.chosen ? '' : 'disabled'}>Seal move</button>`;
}

function renderSide() {
  const s = ui.status;
  if (s) $('fin').textContent = `${s.threshold} of ${s.members}`;
  const c = session.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c) {
    $('avatar').textContent = c.id[0];
    $('me-name').textContent = c.id;
    $('me-key').textContent = `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`;
  }
}

let lastHand = '';
function render() {
  renderPhase();
  const key = duel ? `${duel.round}:${duel.phase}:${duel.seals.map(Boolean)}:${ui.chosen}:${[...ui.sent].join()}:${duel.done}:${mySeat()}` : 'lobby';
  if (key !== lastHand) { lastHand = key; renderHand(); }
  renderSide();
}

function frame() {
  arena.frame(view());
  requestAnimationFrame(frame);
}

function openRound(n) {
  const record = duel.history.find((r) => r.round === n);
  if (!record) return;
  const p = duel.players.map((x) => x.id);
  const line = (seat) => (record.forfeited[seat] ? 'forfeited' : record.moves[seat] ?? 'sealed in time (no reveal needed)');
  panel.open(`Round ${n}`, `
    <dl class="facts">
      <dt>${esc(p[0])}</dt><dd>${line(0)} · dealt ${record.dealt[0]}</dd>
      <dt>${esc(p[1])}</dt><dd>${line(1)} · dealt ${record.dealt[1]}</dd>
      <dt>Die</dt><dd>${record.die ?? '— (a forfeit means no shared die)'}</dd>
    </dl>
    <div class="proof-out"></div>`);
  panel.run(() => proveRound(CONFIG, ledger, duel, record, { threshold: ui.status?.threshold ?? 1 }), `Round ${n}`);
}

// ---------------------------------------------------------------- input

$('rounds').innerHTML = CONFIG.roundOptions.map((r) => `<option value="${r}" ${r === 7 ? 'selected' : ''}>${r}</option>`).join('');
$('challenge').addEventListener('click', postChallenge);
$('open').addEventListener('click', (e) => { const id = e.target.dataset?.accept; if (id) accept(id); });
$('hand').addEventListener('click', (e) => {
  const m = e.target.closest('[data-m]')?.dataset.m;
  const seat = mySeat();
  if (m && duel && seat >= 0 && CONFIG.moves.find((x) => x.id === m).cost <= duel.energy[seat]) { ui.chosen = m; render(); }
  if (e.target.id === 'seal') seal();
});
$('log').addEventListener('click', (e) => { const n = e.target.dataset?.prove; if (n) openRound(Number(n)); });
$('prove-duel').addEventListener('click', openDuelProof);
$('to-lobby').addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (e) => { session.relay = Number(e.target.value); });
$('open-auth').addEventListener('click', () => session.open());
$('signout').addEventListener('click', () => { session.signOut(); session.open('signin'); });

function route() {
  const m = /^#duel=([0-9a-f]{64})$/.exec(location.hash);
  if (m && m[1] !== duelId) enterDuel(m[1]);
  else if (!m && duel) leaveDuel();
}
addEventListener('hashchange', route);

async function refreshMeta() {
  try { ui.status = await ledger.status(CONFIG.movesChain); renderSide(); } catch (error) { reportReachability($('banner'), error); }
}

// ---------------------------------------------------------------- start

if (PLUGIN) document.title = 'Sealed Duels · plugin edition';
if (!(await ed25519Supported())) {
  $('banner').textContent = 'This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.';
  $('banner').hidden = false;
}
session.onChange(() => { lastHand = ''; render(); renderLobby(); });
await session.restore();
requestAnimationFrame(frame);
render();
watchLobby();
await Promise.all([refreshMeta(), syncLobby()]);
route();
setInterval(() => {
  if (stopLobby?.hour !== lobbyOf(CONFIG, Date.now())) watchLobby();
  renderLobby();
  if (duel) { renderPhase(); act(); }
}, 1000);
setInterval(checkLedger, 3000);
setInterval(refreshMeta, 5000);
