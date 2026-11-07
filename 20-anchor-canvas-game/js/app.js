// UI wiring. Everything that decides the wall lives in game.js; this file only
// fetches the finalized log, feeds it to the fold, and draws the result.

import { CONFIG } from './config.js';
import { CanvasState, shortAddress } from './game.js';
import { Ledger } from './ledger.js';
import { Session, detectWallets } from './wallet.js';
import { ed25519Supported } from './crypto.js';

const params = new URLSearchParams(location.search);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (local && params.has('mockwallet')) await import('../test/mock-wallet.js');

if (params.has('proxy')) {
  // serve.mjs may be standing in a local cluster for the showcase (YANO_NODES).
  try {
    const info = await (await fetch('/proxy/nodes')).json();
    if (info.custom) {
      CONFIG.nodes = info.nodes.map((url, i) => ({ label: `Member ${i} · ${new URL(url).host}`, url }));
      CONFIG.explorerTx = null; // a local devnet has no public explorer
      CONFIG.anchorEveryBlocks = null; // and its own anchor cadence
    }
  } catch { /* a plain static server: keep the showcase members */ }
}

const ledger = new Ledger(CONFIG, { proxy: params.has('proxy') });
const state = new CanvasState(CONFIG);
const $ = (id) => document.getElementById(id);
const N = CONFIG.size;

const ui = {
  mode: 'paint',
  color: 5,
  hover: null,
  session: null,
  relay: 0,
  pending: new Map(), // messageId → { kind, x, y, c, at }
  coolUntil: 0,
  coolTotal: 1,
  status: null,
  anchor: null,
  feed: [],
  synced: false,
};

// ---------------------------------------------------------------- the log

let syncing = null;
let again = false;

async function sync() {
  if (syncing) { again = true; return; }
  syncing = (async () => {
    do {
      again = false;
      const entries = await ledger.entriesFrom(state.position.height);
      for (const entry of entries) {
        const result = await state.apply(entry);
        if (!result.skipped) onApplied(entry, result);
      }
    } while (again);
  })();
  try {
    await syncing;
    hideBanner();
    if (!ui.synced) { ui.synced = true; $('loading').hidden = true; await resumeJoin(); }
  } catch (error) {
    reportReachability(error);
  } finally {
    syncing = null;
  }
  render();
}

function onApplied(entry, result) {
  const mine = ui.pending.get(entry.messageId);
  if (mine) {
    ui.pending.delete(entry.messageId);
    if (!result.accepted) toast(`Your ${mine.kind === 'join' ? 'join' : 'pixel'} was refused: ${result.reason}`);
    else if (result.kind === 'join') toast('Wallet verified — the ledger knows your session key');
  }
  if (result.accepted && result.kind === 'px') {
    const p = result.placement;
    pushFeed({ html: `${swatch(p.c)} <b>${esc(result.player.name)}</b> painted (${p.x},${p.y})`, height: entry.height });
  } else if (result.accepted && result.kind === 'join') {
    pushFeed({ html: `🔑 <b>${esc(result.player.name)}</b> joined with a Cardano wallet`, height: entry.height });
  } else if (mine) {
    pushFeed({ html: `<span class="rej">refused: ${esc(result.reason)}</span>`, height: entry.height });
  }
}

function pushFeed(item) {
  ui.feed.unshift(item);
  ui.feed.length = Math.min(ui.feed.length, 40);
}

async function refreshMeta() {
  try {
    const [status, anchor] = await Promise.all([ledger.status(), ledger.anchor()]);
    ui.status = status;
    ui.anchor = anchor;
    render();
  } catch (error) {
    reportReachability(error);
  }
}

function reportReachability(error) {
  const cors = error instanceof TypeError || /no member reachable/.test(error.message);
  showBanner(cors
    ? `Can't reach the Yano X members from <code>${esc(location.origin)}</code>. Browsers only allow it if the
       members list this origin for CORS (<code>quarkus.http.cors.origins</code>). To play locally, run
       <code>node serve.mjs</code> and open <code>http://localhost:8787/?proxy=1</code>.`
    : `Ledger error: ${esc(error.message)}`);
}

// ---------------------------------------------------------------- players

async function joinWithWallet(walletId) {
  const buttons = document.querySelectorAll('#player-card button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const { session, joinBody } = await Session.withWallet(CONFIG, walletId, $('name').value.trim() || 'painter');
    session.joinBody = joinBody;
    session.save(CONFIG);
    ui.session = session;
    await submitJoin();
  } catch (error) {
    toast(`Wallet: ${error.info ?? error.message ?? error}`);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    render();
  }
}

async function submitJoin() {
  const { messageId } = await ledger.submit(ui.relay, ui.session.joinBody);
  ui.pending.set(messageId, { kind: 'join', at: Date.now() });
  toast('Join submitted — waiting for 4 of 5 members to finalize it');
}

/** A restored wallet session whose join never finalized gets one more try. */
async function resumeJoin() {
  const s = ui.session;
  if (s?.kind === 'wallet' && !state.sessions.has(s.pub) && s.joinBody
      && ![...ui.pending.values()].some((p) => p.kind === 'join')) {
    try { await submitJoin(); } catch (error) { toast(`Re-sending join failed: ${error.message}`); }
  }
}

async function joinAsGuest() {
  ui.session = await Session.guest(CONFIG);
  toast('Playing as a guest — connect a wallet to paint faster');
  render();
}

function leave() {
  Session.clear(CONFIG);
  ui.session = null;
  render();
}

const isVerified = () => ui.session?.kind === 'wallet' && state.sessions.has(ui.session.pub);

async function paint(x, y) {
  const s = ui.session;
  if (!s) { toast('Join first: connect a wallet or play as a guest'); $('name').focus(); return; }
  if (s.kind === 'wallet' && !isVerified()) { toast('Your wallet join is still being finalized…'); return; }
  const now = Date.now();
  if (now < ui.coolUntil) { toast(`Cooling down — ${((ui.coolUntil - now) / 1000).toFixed(1)} s`); return; }

  const cooldown = CONFIG.cooldownMs[s.kind];
  ui.coolUntil = now + cooldown + 300;
  ui.coolTotal = cooldown + 300;
  try {
    const body = await s.pixel(CONFIG, x, y, ui.color);
    const { messageId } = await ledger.submit(ui.relay, body);
    ui.pending.set(messageId, { kind: 'px', x, y, c: ui.color, at: Date.now() });
  } catch (error) {
    ui.coolUntil = 0;
    toast(`Submit failed: ${error.message}`);
  }
  render();
}

// ---------------------------------------------------------------- drawing

const wall = $('wall');
const ctx = wall.getContext('2d');

function drawCells(context, cells, px, { markUnsealed = false } = {}) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cell = cells[y * N + x];
      context.fillStyle = cell ? CONFIG.palette[cell.c] : ((x + y) % 2 ? '#10141c' : '#0c1016');
      context.fillRect(x * px, y * px, px, px);
    }
  }
  const sealed = ui.anchor?.anchoredHeight ?? 0;
  if (markUnsealed) {
    context.fillStyle = 'rgba(255,255,255,0.75)';
    for (const cell of cells) {
      if (cell && cell.height > sealed) context.fillRect(cell.x * px + px - 4, cell.y * px + 1, 3, 3);
    }
  }
}

function drawWall() {
  const px = wall.width / N;
  drawCells(ctx, state.cells, px, { markUnsealed: true });

  for (const p of ui.pending.values()) {
    if (p.kind !== 'px') continue;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = CONFIG.palette[p.c];
    ctx.fillRect(p.x * px, p.y * px, px, px);
    ctx.globalAlpha = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(p.x * px + 1, p.y * px + 1, px - 2, px - 2);
    ctx.setLineDash([]);
  }

  if (ui.hover) {
    const { x, y } = ui.hover;
    if (ui.mode === 'paint' && ui.session) {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = CONFIG.palette[ui.color];
      ctx.fillRect(x * px, y * px, px, px);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x * px + 1, y * px + 1, px - 2, px - 2);
    ctx.lineWidth = 1;
  }
}

function drawFrame() {
  const frame = $('frame');
  const height = ui.anchor?.anchoredHeight;
  const cells = height ? state.frameAt(height) : new Array(N * N).fill(null);
  drawCells(frame.getContext('2d'), cells, frame.width / N);
  return cells;
}

// ---------------------------------------------------------------- panels

function render() {
  drawWall();
  renderPill();
  renderPlayer();
  renderAnchor();
  renderLeaders();
  $('feed').innerHTML = ui.feed.map((f) => `<li><span>${f.html}</span><span class="h">h${f.height}</span></li>`).join('')
    || '<li class="muted">No pixels yet — be the first.</li>';
}

function renderPill() {
  const s = ui.status;
  $('chain-pill').innerHTML = s
    ? `<span class="dot"></span><b>${esc(s.chainId)}</b> · height ${Math.max(s.tipHeight, state.position.height)}
       · ${s.threshold}-of-${s.members} finality`
    : 'connecting…';
}

function renderPlayer() {
  const s = ui.session;
  $('join-view').hidden = !!s;
  $('me-view').hidden = !s;
  if (!s) {
    const wallets = detectWallets();
    const key = wallets.map((w) => w.id).join(',');
    if ($('wallets').dataset.key === key && key) return; // keep the buttons under the pointer stable
    $('wallets').dataset.key = key;
    $('wallets').innerHTML = wallets.length
      ? wallets.map((w) => `<button type="button" class="wallet-btn" data-wallet="${esc(w.id)}">
          ${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}Connect ${esc(w.name)}</button>`).join('')
      : '<p class="small muted">No CIP-30 wallet found in this browser. Install Eternl, Lace or another Cardano wallet — or play as a guest.</p>';
    return;
  }
  const player = state.players.get(s.playerId);
  $('me-swatch').style.background = CONFIG.palette[ui.color];
  $('me-name').textContent = player?.name ?? s.name;
  $('me-id').textContent = s.kind === 'wallet' ? shortAddress(s.address) : `session ${s.pub.slice(0, 12)}…`;
  const until = new Date(s.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const held = state.leaderboard().find((r) => r.player.id === s.playerId)?.held ?? 0;
  const badge = s.kind === 'guest'
    ? '<span class="badge warn">guest · 8 s cooldown</span>'
    : isVerified() ? '<span class="badge good">wallet verified on the ledger</span>'
      : '<span class="badge warn">join finalizing…</span>';
  $('me-status').innerHTML = `${badge}<div class="muted" style="margin-top:6px">Holding ${held} · painted
    ${player?.painted ?? 0} · session until ${until}</div>`;
}

function renderAnchor() {
  const a = ui.anchor;
  const tip = Math.max(ui.status?.tipHeight ?? 0, state.position.height);
  const cells = drawFrame();
  if (!a) return;
  const champion = state.leaderboard(cells)[0];
  const painted = cells.filter(Boolean).length;
  const tx = a.transactionHash;
  $('anchor-facts').innerHTML = `
    <div>Sealed through height <b>${a.anchoredHeight}</b></div>
    <div>tx ${txLink(tx, `${tx.slice(0, 16)}…`)}</div>
    <div class="muted">${painted} pixel${painted === 1 ? '' : 's'} on the sealed wall</div>
    ${champion ? `<div>Sealed champion: <b>${esc(champion.player.name)}</b> (${champion.held})</div>` : ''}`;

  const behind = Math.max(0, tip - a.anchoredHeight);
  const pending = ui.status?.anchor?.pendingTx;
  const every = CONFIG.anchorEveryBlocks;
  $('anchor-meter').style.width = `${Math.min(100, (behind / (every ?? 2)) * 100)}%`;
  $('anchor-next').textContent = pending
    ? 'An anchor transaction is in flight on Cardano preprod…'
    : behind === 0
      ? 'Everything finalized so far is sealed on Cardano. Unsealed pixels get a white corner.'
      : `${behind} block${behind === 1 ? '' : 's'} since the last seal. ${every
        ? `The next anchor comes after ${every} blocks, or within the hour.`
        : 'The next anchor comes in a few blocks.'} Unsealed pixels get a white corner.`;
}

function renderLeaders() {
  const rows = state.leaderboard().slice(0, 8);
  const me = ui.session?.playerId;
  $('leaders').innerHTML = rows.map((r) => `<li class="${r.player.id === me ? 'me-row' : ''}">
      <span class="who">${esc(r.player.name)} ${r.player.kind === 'wallet' ? '🔑' : ''}</span>
      <span class="n">${r.held}</span></li>`).join('')
    || '<li class="muted">The wall is empty.</li>';
}

// ---------------------------------------------------------------- inspect

async function inspect(x, y) {
  const cell = state.cells[y * N + x];
  $('inspect-title').textContent = `Pixel (${x}, ${y})`;
  const body = $('inspect-body');
  $('inspect').showModal();
  if (!cell) {
    body.innerHTML = '<p class="muted">Nobody has painted this pixel yet.</p>';
    return;
  }
  const player = state.players.get(cell.player);
  const sealed = ui.anchor && cell.height <= ui.anchor.anchoredHeight;
  const s = ui.status;
  body.innerHTML = `
    <dl class="facts">
      <dt>Colour</dt><dd>${swatch(cell.c)} <span class="mono">${CONFIG.palette[cell.c]}</span></dd>
      <dt>Painter</dt><dd><b>${esc(player.name)}</b> ${player.kind === 'wallet'
        ? `<span class="badge good">Cardano wallet</span><br>${CONFIG.explorerTx
          ? `<a class="mono" target="_blank" rel="noopener" href="https://preprod.cardanoscan.io/address/${esc(player.address)}">${esc(player.address)}</a>`
          : `<span class="mono">${esc(player.address)}</span>`}`
        : '<span class="badge warn">guest session</span>'}</dd>
      <dt>Message</dt><dd class="mono">${cell.messageId}</dd>
      <dt>Finalized</dt><dd>height ${cell.height}, index ${cell.index}<br>
        <span class="muted">${new Date(cell.timestamp).toLocaleString()}</span></dd>
      <dt>Finality</dt><dd>certified by ${s ? `≥${s.threshold} of ${s.members}` : 'a threshold of'} members</dd>
      <dt>Cardano</dt><dd>${sealed
        ? `<span class="badge good">sealed</span> anchored through height ${ui.anchor.anchoredHeight}<br>
           ${txLink(ui.anchor.transactionHash, ui.anchor.transactionHash)}`
        : '<span class="badge warn">not sealed yet</span> it will be in the next anchor'}</dd>
    </dl>
    <button type="button" class="wallet-btn" id="prove" style="margin-top:14px">
      ${sealed ? 'Prove it against the Cardano anchor' : 'Prove it against the latest state root'}</button>
    <div id="proof-out"></div>
    <details id="raw"><summary>Message on the ledger</summary><pre>loading…</pre></details>`;
  $('prove').onclick = () => prove(cell, sealed);
  $('raw').ontoggle = async (event) => {
    if (!event.target.open) return;
    try {
      const m = await ledger.read(`/messages/${cell.messageId}`);
      const text = new TextDecoder().decode(Uint8Array.from(m.bodyHex.match(/../g), (h) => parseInt(h, 16)));
      event.target.querySelector('pre').textContent =
        `topic:  ${m.topic}\nrelayed by member ${m.sender}\n\n${JSON.stringify(JSON.parse(text), null, 2)}`;
    } catch (error) {
      event.target.querySelector('pre').textContent = error.message;
    }
  };
}

async function prove(cell, sealed) {
  const out = $('proof-out');
  out.innerHTML = '<div class="proof muted">Requesting a typed proof…</div>';
  try {
    const r = await ledger.proveMessage(cell.messageId, sealed ? 'latest-confirmed-anchor' : 'latest');
    const f = r.fact?.fields ?? {};
    const sigs = r.proof?.finalityCertificate?.signatures?.length ?? 0;
    const rootMatches = sealed && r.proof?.stateRoot === ui.anchor.stateRoot;
    const ok = (good) => (good ? '✅' : '❌');
    out.innerHTML = `<div class="proof">
      <b>${ok(r.claimResult?.satisfied)} ${esc(r.claimResult?.explanation ?? 'claim not evaluated')}</b>
      <ul>
        <li>${ok(f.height === cell.height && f.index === cell.index)} record says height ${f.height}, index ${f.index},
          topic <code>${esc(f.topic ?? '')}</code></li>
        <li>proven under state root <span class="mono">${r.proof?.stateRoot}</span> at height ${r.proof?.version}</li>
        <li>${ok(sigs >= (ui.status?.threshold ?? 1))} finality certificate: ${sigs} member signatures</li>
        ${sealed ? `<li>${ok(rootMatches)} that root is the one anchored on Cardano in
          ${txLink(ui.anchor.transactionHash, `${ui.anchor.transactionHash.slice(0, 16)}…`)}</li>` : ''}
      </ul>
      <p class="small muted">This proof was checked by the serving member (trust: <code>${esc(r.trust ?? 'n/a')}</code>).
        To verify with no member in the loop, check the MPF proof yourself against the root in the Cardano
        anchor datum — example 09 shows how.</p></div>`;
  } catch (error) {
    out.innerHTML = `<div class="proof">❌ ${esc(error.message)}</div>`;
  }
}

// ---------------------------------------------------------------- input

function cellAt(event) {
  const rect = wall.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * N);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * N);
  return x >= 0 && y >= 0 && x < N && y < N ? { x, y } : null;
}

wall.addEventListener('mousemove', (event) => {
  ui.hover = cellAt(event);
  $('coords').textContent = ui.hover ? `(${ui.hover.x}, ${ui.hover.y})` : '';
  drawWall();
});
wall.addEventListener('mouseleave', () => { ui.hover = null; $('coords').textContent = ''; drawWall(); });
wall.addEventListener('click', (event) => {
  const at = cellAt(event);
  if (!at) return;
  if (ui.mode === 'inspect' || event.altKey) inspect(at.x, at.y);
  else paint(at.x, at.y);
});

function setMode(mode) {
  ui.mode = mode;
  wall.classList.toggle('inspect', mode === 'inspect');
  document.querySelectorAll('.mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  });
  $('hint').innerHTML = mode === 'inspect'
    ? 'Click a pixel to see who painted it, when it was finalized, and prove it against the Cardano anchor.'
    : 'Click to paint. Alt-click (or Inspect) to see a pixel’s proof.';
}
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select')) return;
  if (event.key === 'i') setMode(ui.mode === 'inspect' ? 'paint' : 'inspect');
});

$('palette').innerHTML = CONFIG.palette.map((c, i) =>
  `<button type="button" role="radio" aria-label="colour ${i}" data-c="${i}" style="background:${c}"></button>`).join('');
function selectColor(i) {
  ui.color = i;
  document.querySelectorAll('#palette button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.c) === i);
    b.setAttribute('aria-checked', String(Number(b.dataset.c) === i));
  });
  render();
}
$('palette').addEventListener('click', (event) => {
  const c = event.target.dataset?.c;
  if (c !== undefined) selectColor(Number(c));
});

$('wallets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-wallet]');
  if (button) joinWithWallet(button.dataset.wallet);
});
$('guest').addEventListener('click', joinAsGuest);
$('leave').addEventListener('click', leave);
$('relay').innerHTML = CONFIG.nodes.map((n, i) => `<option value="${i}">${esc(n.label)}</option>`).join('');
$('relay').addEventListener('change', (event) => { ui.relay = Number(event.target.value); });

setInterval(() => {
  const left = Math.max(0, ui.coolUntil - Date.now());
  const bar = $('cooldown');
  bar.classList.toggle('cold', left > 0);
  bar.firstElementChild.style.width = `${left > 0 ? 100 - (left / ui.coolTotal) * 100 : 100}%`;
  for (const [id, p] of ui.pending) if (Date.now() - p.at > 90_000) ui.pending.delete(id);
}, 100);

// ---------------------------------------------------------------- helpers

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
const txLink = (tx, text) => (CONFIG.explorerTx
  ? `<a class="mono" target="_blank" rel="noopener" href="${CONFIG.explorerTx.replace('{tx}', tx)}">${text}</a>`
  : `<span class="mono">${text}</span>`);
const swatch = (c) => `<span class="swatch" style="background:${CONFIG.palette[c]}"></span>`;

function showBanner(html) { $('banner').innerHTML = html; $('banner').hidden = false; }
function hideBanner() { $('banner').hidden = true; }

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- start

selectColor(ui.color);
setMode('paint');
if (!(await ed25519Supported())) {
  showBanner('This browser has no Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.');
}
ui.session = await Session.restore(CONFIG);
render();
setTimeout(render, 1000); // wallets can inject themselves after the page loads
await Promise.all([refreshMeta(), sync()]);
ledger.watch((ui.status?.tipHeight ?? 0) + 1, sync);
setInterval(refreshMeta, 12_000);
