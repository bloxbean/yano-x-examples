// UI wiring for Comet Derby. The rules are derby.js; this file keeps the hour
// in step with the ledger, places signed bets, posts the "go" message that
// becomes a race's beacon, and plays each race from its seed in sync with
// every other browser (start = the beacon block's certified time + 2 s).

import { CONFIG } from './config.js';
import { Derby, Race, TICKS_PER_SECOND, betStatement, hourOf, hourTopic, raceClose, raceOf, raceStart } from './derby.js';
import { Renderer } from './render.js';
import { proveRace } from './proofs.js';
import { applyProxy, withQuery } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Session } from '../../shared/auth.js';
import { ProofPanel, esc, reportReachability, toast } from '../../shared/ui.js';
import { ed25519Supported, fromHex } from '../../shared/crypto.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CONFIG, { proxy });
const session = new Session(ledger);
const panel = new ProofPanel();
const renderer = new Renderer($('sky'), CONFIG);
$('back').href = withQuery('../');

const STAKES = [10, 50, 100, 250, 500];
const LEAD_MS = 2000; // a race starts 2 s after its beacon block's certified time
const TICK_MS = 1000 / TICKS_PER_SECOND;

const ui = {
  pick: null,
  stake: 50,
  nonce: 0,
  pending: new Map(), // messageId → { comet, stake }
  posted: new Set(), // races this browser already posted a "go" for
  status: null,
  anchor: null,
  ready: false,
  shown: null, // { key, rec, race, start, replay }
  announced: new Set(),
};
let derby = null;
let stopWatch = null;
const me = () => session.commander?.id ?? null;
const nextNonce = () => (ui.nonce = Math.max(Date.now(), ui.nonce + 1));

// ---------------------------------------------------------------- the hour

async function enterHour(hour) {
  stopWatch?.();
  ui.ready = false;
  derby = new Derby(CONFIG, hour);
  stopWatch = ledger.watch(CONFIG.movesChain, hourTopic(CONFIG, hour), 0, sync, 1500);
  await sync();
  ui.ready = true;
  render();
}

let syncing = null;
let again = false;
async function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    do {
      again = false;
      const d = derby;
      const entries = await ledger.entriesFrom(CONFIG.movesChain, hourTopic(CONFIG, d.hour), d.position.height);
      for (const entry of entries) {
        if (d !== derby) return;
        let result;
        try {
          result = await d.apply(entry, session.profiles.check);
        } catch {
          setTimeout(sync, 800); // a bet waiting on the profile chain: retry, in order
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
  render();
}

function onApplied(entry, result) {
  const mine = ui.pending.get(entry.messageId);
  if (mine) {
    ui.pending.delete(entry.messageId);
    if (result.accepted) toast(`${mine.stake} on ${CONFIG.comets[mine.comet].name} is final at block #${entry.height}`, 'info');
    else toast(`Your bet was refused: ${result.reason}`, 'info');
  }
}

// ---------------------------------------------------------------- betting

async function placeBet() {
  const c = session.commander;
  if (!c) { session.open(); return; }
  if (ui.pick === null) return;
  const now = Date.now();
  const race = raceOf(CONFIG, now);
  if (raceClose(CONFIG, race) - now < 3000) { toast('Too close to the close — wait for the next race', 'info'); return; }
  if (ui.stake > derby.balance(c.id) - pendingStake()) { toast('Not enough credits', 'info'); return; }
  const n = nextNonce();
  const comet = ui.pick;
  const stake = ui.stake;
  const sig = await c.sign(betStatement(CONFIG, derby.hour, c.id, n, race, comet, stake));
  try {
    const body = JSON.stringify({ t: 'bet', id: c.id, pub: c.pub, n, race, comet, stake, sig });
    const { messageId } = await ledger.submit(CONFIG.movesChain, session.relay, hourTopic(CONFIG, derby.hour), { body });
    ui.pending.set(messageId, { comet, stake, race });
    render();
  } catch (error) {
    toast(`Could not place the bet: ${error.message}`, 'info');
  }
}

/** Results stay hidden until their race has finished on screen, so the sidebar never spoils it. */
const revealed = (rec, now = Date.now()) => !rec.result || rec.result.void
  || now >= rec.beacon.timestamp + LEAD_MS + rec.result.ticks * TICK_MS;
/** Credits as shown: payouts of races still playing are not counted yet. */
const shownCredits = (id, now = Date.now()) => derby.balance(id)
  - [...derby.races.values()].filter((r) => r.result && !revealed(r, now)).reduce((s, r) => s + (r.result.payouts.get(id) ?? 0), 0);

const pendingStake = () => [...ui.pending.values()].reduce((s, p) => s + p.stake, 0);

/** Any browser may post the message that becomes a race's beacon. */
async function postBeacons(now) {
  for (const rec of derby.races.values()) {
    if (rec.beacon || !rec.bets.length || ui.posted.has(rec.race)) continue;
    if (now < raceClose(CONFIG, rec.race) + 300) continue;
    ui.posted.add(rec.race);
    try {
      await ledger.submit(CONFIG.movesChain, session.relay, hourTopic(CONFIG, derby.hour), { body: '{"t":"go"}' });
    } catch {
      ui.posted.delete(rec.race);
    }
  }
}

// ---------------------------------------------------------------- showing races

/** The race to draw now: a requested replay, else the latest race still playing or just finished. */
function chooseShown(now) {
  if (ui.shown?.replay && now < ui.shown.end) return ui.shown;
  let pick = null;
  for (const rec of derby.races.values()) {
    if (!rec.beacon || !rec.result || rec.result.void) continue;
    const start = rec.beacon.timestamp + LEAD_MS;
    if (now < start - LEAD_MS) continue;
    if (!pick || rec.race > pick.rec.race) pick = { rec, start };
  }
  if (!pick) return null;
  const end = pick.start + 2600 * TICK_MS;
  if (now > end + 8000) return null;
  const key = `race-${pick.rec.race}`;
  if (ui.shown?.key === key) return ui.shown;
  return { key, rec: pick.rec, start: pick.start, end: end + 8000, race: new Race(fromHex(pick.rec.beacon.seed), CONFIG.comets.length) };
}

function replay(rec) {
  panel.close();
  const start = Date.now() + 600;
  ui.shown = { key: `replay-${rec.race}-${start}`, rec, start, end: start + 2600 * TICK_MS + 6000, replay: true,
    race: new Race(fromHex(rec.beacon.seed), CONFIG.comets.length) };
}

function frame() {
  const now = Date.now();
  let view = { now: performance.now(), race: null, raceKey: 'parked', parked: true, highlight: ui.pick };
  if (derby) {
    const shown = chooseShown(now);
    ui.shown = shown;
    if (shown) {
      const tick = Math.max(0, Math.floor((now - shown.start) / TICK_MS));
      if (tick < shown.race.tick) shown.race = new Race(fromHex(shown.rec.beacon.seed), CONFIG.comets.length);
      shown.race.runTo(tick);
      const myBets = shown.rec.bets.filter((b) => b.id === me());
      view = { now: performance.now(), race: now >= shown.start ? shown.race : null, raceKey: shown.key,
        parked: now < shown.start, highlight: myBets.length ? myBets[myBets.length - 1].comet : ui.pick };
      announce(shown, now);
    }
    renderStage(now);
  }
  renderer.frame(view);
  requestAnimationFrame(frame);
}

function announce(shown, now) {
  const { rec, race } = shown;
  if (!race.done || shown.replay || ui.announced.has(rec.race) || now - shown.start > 60_000) return;
  ui.announced.add(rec.race);
  const won = rec.result.payouts.get(me());
  const staked = rec.bets.filter((b) => b.id === me()).reduce((s, b) => s + b.stake, 0);
  const name = CONFIG.comets[rec.result.winner].name;
  if (staked) toast(won ? `${name} wins — you collect ${won} credits` : `${name} wins — you lose ${staked}`, won ? '' : 'info');
}

// ---------------------------------------------------------------- panels

function renderStage(now) {
  const shown = ui.shown;
  const race = raceOf(CONFIG, now);
  const close = raceClose(CONFIG, race);
  const rec = derby.races.get(race);
  if (shown && now >= shown.start - LEAD_MS) {
    const r = shown.race;
    const names = CONFIG.comets.map((c) => c.name);
    $('kicker').textContent = `${shown.replay ? 'Replay · ' : ''}Race ${shown.rec.race % 1000}`;
    if (now < shown.start) {
      $('big').textContent = `Lights out in ${Math.ceil((shown.start - now) / 1000)}`;
    } else if (!r.done) {
      $('big').textContent = `Lap ${Math.min(3, Math.floor(Math.max(...r.comets.map((c) => c.pos)) / 1_000_000) + 1)} of 3`;
    } else {
      $('big').textContent = `${names[shown.rec.result.winner]} wins!`;
    }
    $('sub').textContent = `pool ${shown.rec.pool} credits · ${shown.rec.bets.length} bets · seed ${shown.rec.beacon.seed.slice(0, 10)}…`;
    const order = r.order.length === r.comets.length ? r.order : [...r.comets].sort((a, b) => b.pos - a.pos).map((c) => c.i);
    const myComets = new Set(shown.rec.bets.filter((b) => b.id === me()).map((b) => b.comet));
    $('standings').innerHTML = order.map((i) => `<li class="${myComets.has(i) ? 'me' : ''}" style="color:${CONFIG.comets[i].color}">${names[i]}${r.comets[i].finished ? ' ✓' : ''}</li>`).join('');
    $('standings').hidden = now < shown.start;
    const b = shown.rec.beacon;
    $('beacon').innerHTML = `Betting closed at <b>${new Date(raceClose(CONFIG, shown.rec.race)).toLocaleTimeString()}</b>.
      Beacon: block <b>#${b.height}</b>, certified after the close<br>root <b>${b.stateRoot.slice(0, 10)}…</b><span class="arrow">→</span>seed <b>${b.seed.slice(0, 10)}…</b>`;
    $('beacon').hidden = false;
  } else {
    $('standings').hidden = true;
    $('beacon').hidden = true;
    $('kicker').textContent = `Race ${race % 1000}`;
    if (now < close) {
      $('big').textContent = `Betting closes in ${Math.ceil((close - now) / 1000)} s`;
      $('sub').textContent = rec?.pool ? `pool ${rec.pool} credits from ${rec.bets.length} bets` : 'no bets yet — pick a comet below';
    } else if (rec?.bets.length && !rec.beacon) {
      $('big').textContent = 'Waiting for the beacon block…';
      $('sub').textContent = 'the first block certified after the close decides the race';
    } else {
      $('big').textContent = `Next race in ${Math.ceil((raceStart(CONFIG, race + 1) - now) / 1000)} s`;
      $('sub').textContent = rec?.bets.length ? '' : 'no bets in this race';
    }
  }
  const open = now < close - 3000;
  $('slot').innerHTML = open ? `race <b>${race % 1000}</b> · betting open` : `race <b>${race % 1000}</b> · betting closed`;
  renderCards(race, open);
}

let lastCards = '';
function renderCards(race, open) {
  const rec = derby.races.get(race);
  const odds = derby.odds(race);
  const mine = CONFIG.comets.map((_, i) => (rec?.bets ?? []).filter((b) => b.id === me() && b.comet === i).reduce((s, b) => s + b.stake, 0));
  const pend = CONFIG.comets.map((_, i) => [...ui.pending.values()].filter((p) => p.comet === i && p.race === race).reduce((s, p) => s + p.stake, 0));
  const key = JSON.stringify([race, open, odds, mine, pend, ui.pick, rec?.pool]);
  if (key === lastCards) return;
  lastCards = key;
  $('cards').innerHTML = CONFIG.comets.map((c, i) => {
    const share = rec?.pool ? Math.round((rec.byComet[i] / rec.pool) * 100) : 0;
    return `<button class="comet ${ui.pick === i ? 'on' : ''}" data-c="${i}" style="--c:${c.color}" ${open ? '' : 'disabled'}>
      <span class="name"><span class="dot"></span>${c.name}</span>
      <span class="odds">${odds[i] ? `${odds[i].toFixed(2)}×` : '—'}</span>
      <span class="share"><span style="width:${share}%"></span></span>
      <span class="mine">${mine[i] ? `you: ${mine[i]}` : ''}${pend[i] ? ` · placing ${pend[i]}…` : ''}</span></button>`;
  }).join('');
  const bet = $('bet');
  bet.disabled = !open || ui.pick === null;
  bet.textContent = !open ? 'Betting closed' : ui.pick === null ? 'Pick a comet' : `Bet ${ui.stake} on ${CONFIG.comets[ui.pick].name}`;
}

function render() {
  if (!derby) return;
  const c = session.commander;
  $('me').hidden = !c;
  $('me-empty').hidden = !!c;
  if (c) {
    $('avatar').textContent = c.id[0];
    $('me-name').textContent = c.id;
    $('me-key').textContent = `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`;
  }
  $('credits').textContent = c ? (shownCredits(c.id) - pendingStake()).toLocaleString() : '—';
  $('stakes').innerHTML = STAKES.map((s) => `<button class="${s === ui.stake ? 'on' : ''}" data-s="${s}">${s}</button>`).join('');
  const board = derby.leaderboard().map((r) => ({ ...r, credits: shownCredits(r.id) })).sort((a, b) => b.credits - a.credits);
  $('board').innerHTML = board.slice(0, 8).map((r) => `<li class="${r.id === me() ? 'me' : ''}">${esc(r.id)}<span class="cr">${r.credits.toLocaleString()}</span></li>`).join('')
    || '<li class="small" style="list-style:none">No bets yet this hour.</li>';
  const races = [...derby.races.values()].filter((r) => r.bets.length).sort((a, b) => b.race - a.race);
  $('races').innerHTML = races.map((r) => {
    const staked = r.bets.filter((b) => b.id === me()).reduce((s, b) => s + b.stake, 0);
    const won = r.result?.payouts.get(me()) ?? 0;
    const gain = staked && r.result ? won - staked : null;
    const done = revealed(r);
    const gainShown = done ? gain : null;
    const what = !r.result ? 'racing soon…' : !done ? 'racing now…' : r.result.void ? 'void — stakes returned'
      : `<span class="w" style="color:${CONFIG.comets[r.result.winner].color}">${CONFIG.comets[r.result.winner].name}</span> won · pool ${r.pool}`;
    return `<li>#${r.race % 1000} ${what}${gainShown === null ? '' : `<span class="gain ${gainShown >= 0 ? 'up' : 'down'}">${gainShown >= 0 ? '+' : ''}${gainShown}</span>`}
      ${r.result && !r.result.void && done ? `<button class="link" data-prove="${r.race}">prove</button> <button class="link" data-replay="${r.race}">▶</button>` : ''}</li>`;
  }).join('') || '<li class="small">No races with bets yet.</li>';
}

function openRace(r) {
  const rec = derby.races.get(r);
  const bet = rec.bets.find((b) => b.id === me()) ?? rec.bets[0];
  const names = CONFIG.comets.map((c) => c.name);
  panel.open(`Race ${r % 1000}`, `
    <dl class="facts">
      <dt>Winner</dt><dd>${names[rec.result.winner]} · then ${rec.result.order.slice(1, 3).map((i) => names[i]).join(', ')}</dd>
      <dt>Pool</dt><dd>${rec.pool} credits from ${rec.bets.length} bets</dd>
      <dt>Proving</dt><dd>${esc(bet.id)}’s ${bet.stake} on ${names[bet.comet]} (block #${bet.height})</dd>
      <dt>Beacon</dt><dd class="mono">block #${rec.beacon.height} · root ${rec.beacon.stateRoot.slice(0, 16)}…</dd>
    </dl>
    <div class="proof-out"></div>`);
  panel.run(() => proveRace(CONFIG, ledger, derby, rec, bet, { threshold: ui.status?.threshold ?? 1 }), `Race ${r % 1000}`);
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(CONFIG.movesChain), ledger.anchor(CONFIG.movesChain)]);
    ui.status = status;
    ui.anchor = anchor;
    $('blk').textContent = `#${status.tipHeight.toLocaleString()}`;
    $('fin').textContent = `${status.threshold} of ${status.members}`;
    $('sealed').textContent = anchor ? `#${anchor.anchoredHeight.toLocaleString()}` : '—';
  } catch (error) {
    reportReachability($('banner'), error);
  }
}

// ---------------------------------------------------------------- input

$('cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b || b.disabled) return;
  ui.pick = Number(b.dataset.c);
  lastCards = '';
  renderStage(Date.now());
});
$('stakes').addEventListener('click', (e) => {
  const s = e.target.dataset?.s;
  if (s) { ui.stake = Number(s); lastCards = ''; render(); renderStage(Date.now()); }
});
$('bet').addEventListener('click', placeBet);
$('races').addEventListener('click', (e) => {
  const p = e.target.dataset?.prove;
  const r = e.target.dataset?.replay;
  if (p) openRace(Number(p));
  if (r) replay(derby.races.get(Number(r)));
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
session.onChange(() => { lastCards = ''; render(); });
await session.restore();
requestAnimationFrame(frame);
await Promise.all([refreshMeta(), enterHour(hourOf(CONFIG, Date.now()))]);
setInterval(() => {
  const now = Date.now();
  if (hourOf(CONFIG, now) !== derby.hour) { enterHour(hourOf(CONFIG, now)); return; }
  if (ui.ready) postBeacons(now);
  ui.shown = chooseShown(now); // the canvas loop pauses in background tabs; the text does not
  renderStage(now);
  render();
}, 1000);
setInterval(refreshMeta, 5000);
