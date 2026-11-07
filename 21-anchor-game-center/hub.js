// The game center page: sign in once, pick a game. Each game card links to
// the game's own folder; every game reads the same commander from this
// origin's localStorage, so the sign-in here carries over.

import { CENTER, GAMES, ACCOUNTS, applyProxy, withQuery } from './shared/config.js';
import { Ledger } from './shared/ledger.js';
import { Session } from './shared/auth.js';
import { proveProfile } from './shared/proofs.js';
import { ProofPanel, esc, reportReachability } from './shared/ui.js';
import { rocket } from './arcade/js/render.js';

const $ = (id) => document.getElementById(id);
const proxy = await applyProxy();
const ledger = new Ledger(CENTER, { proxy });
const session = new Session(ledger);
const panel = new ProofPanel();
let status = null;

// ---------------------------------------------------------------- games

$('games').innerHTML = GAMES.map((g) => `
  <a class="game" href="${withQuery(g.href ?? `${g.id}/`)}" style="--accent:${g.color}">
    <canvas data-preview="${g.preview ?? g.id}"></canvas>
    <div class="body">
      <div class="tag">${esc(g.tagline)}</div>
      <h2>${esc(g.title)}</h2>
      <p>${esc(g.blurb)}</p>
      <div class="foot"><span class="small">${esc(g.players)}</span><span class="play">Play</span></div>
    </div>
  </a>`).join('') + `
  <div class="game soon"><div><b>Your game here</b><p>Add a folder with a deterministic game over the ledger;
    accounts, proofs and the ledger client come from <code>shared/</code>.</p></div></div>`;

// ---------------------------------------------------------------- commander

function renderCommander() {
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
session.onChange(renderCommander);
$('create').onclick = () => session.open('create');
$('signin').onclick = () => session.open('signin');
$('signout').onclick = () => session.signOut();
$('prove-me').onclick = () => {
  const c = session.commander;
  panel.open(`Commander ${c.id}`, `
    <dl class="facts">
      <dt>Call sign</dt><dd><b>${esc(c.id)}</b></dd>
      <dt>Stored at</dt><dd class="mono">${esc(ACCOUNTS.profilesChain)} · ${esc(ACCOUNTS.profilesCollection)}</dd>
      <dt>Holds</dt><dd>public key, PBKDF2 salt and the password-locked signing key — never the password</dd>
    </dl>
    <div class="proof-out"></div>`);
  panel.run(() => proveProfile(ledger, session.profiles, c.id, { threshold: status?.threshold ?? 1, expectPub: c.pub }),
    `${c.id}’s profile`);
};

async function refresh() {
  try {
    const [s, anchor] = await Promise.all([ledger.status(CENTER.movesChain), ledger.anchor(CENTER.movesChain)]);
    status = s;
    $('blk').textContent = `#${s.tipHeight.toLocaleString()}`;
    $('fin').textContent = `${s.threshold} of ${s.members}`;
    $('sealed').innerHTML = anchor ? `#${anchor.anchoredHeight.toLocaleString()}` : '—';
    $('sealed').title = anchor ? `tx ${anchor.transactionHash}` : '';
    $('banner').hidden = true;
  } catch (error) {
    reportReachability($('banner'), error);
  }
}

// ---------------------------------------------------------------- pictures

const sky = $('sky');
const stars = Array.from({ length: 220 }, () => ({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8 }));
function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}

const PLANETS = [[0.2, 0.35, 16, '#3ee6ff'], [0.52, 0.6, 22, '#ff4fd8'], [0.8, 0.3, 14, '#ffb020'],
  [0.35, 0.78, 11, '#59607a'], [0.7, 0.8, 12, '#7dff6a']];
function galaxyPreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  ctx.fillStyle = '#05060d'; ctx.fillRect(0, 0, w, h);
  for (const s of stars.slice(0, 80)) { ctx.fillStyle = `rgba(200,215,255,${s.z * 0.6})`; ctx.fillRect(s.x * w, s.y * h, 1.2, 1.2); }
  const routes = [[0, 1], [1, 2], [0, 3], [2, 4], [1, 4]];
  routes.forEach(([a, b], i) => {
    const pa = PLANETS[a]; const pb = PLANETS[b];
    const k = ((t / 2600 + i * 0.23) % 1);
    for (let j = 0; j < 5; j++) {
      const kk = k - j * 0.025;
      if (kk < 0) continue;
      const x = (pa[0] + (pb[0] - pa[0]) * kk) * w;
      const y = (pa[1] + (pb[1] - pa[1]) * kk) * h;
      const ang = Math.atan2((pb[1] - pa[1]) * h, (pb[0] - pa[0]) * w);
      rocket(ctx, x, y, (ang / (Math.PI * 2)) * 256, 0.35, pa[3], 0.9, true, t);
    }
  });
  for (const [x, y, r, c] of PLANETS) {
    const g = ctx.createRadialGradient(x * w, y * h, r * 0.5, x * w, y * h, r * 2.6);
    g.addColorStop(0, `${c}66`); g.addColorStop(1, `${c}00`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x * w, y * h, r * 2.6, 0, 7); ctx.fill();
    const b = ctx.createRadialGradient(x * w - r * 0.3, y * h - r * 0.3, 1, x * w, y * h, r);
    b.addColorStop(0, '#fff'); b.addColorStop(0.3, c); b.addColorStop(1, '#05060d');
    ctx.fillStyle = b; ctx.beginPath(); ctx.arc(x * w, y * h, r, 0, 7); ctx.fill();
  }
}

const ROCKS = Array.from({ length: 6 }, (_, i) => ({ x: Math.random(), y: Math.random(), r: 10 + (i % 3) * 8,
  vx: (Math.random() - 0.5) * 0.0004, vy: (Math.random() - 0.5) * 0.0004, c: ['#3ee6ff', '#ff4fd8', '#ffb020', '#7dff6a'][i % 4],
  shape: Array.from({ length: 9 }, () => 0.7 + Math.random() * 0.4) }));
function arcadePreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  ctx.fillStyle = '#05060d'; ctx.fillRect(0, 0, w, h);
  for (const s of stars.slice(80, 170)) {
    ctx.fillStyle = `rgba(200,215,255,${s.z * 0.6})`;
    ctx.fillRect(((s.x * w - t * 0.02 * s.z) % w + w) % w, s.y * h, 1.3, 1.3);
  }
  for (const r of ROCKS) {
    r.x = (r.x + r.vx * 16 + 1) % 1; r.y = (r.y + r.vy * 16 + 1) % 1;
    ctx.save(); ctx.translate(r.x * w, r.y * h); ctx.rotate(t / 2000);
    ctx.strokeStyle = r.c; ctx.lineWidth = 1.6; ctx.shadowColor = r.c; ctx.shadowBlur = 10;
    ctx.beginPath();
    r.shape.forEach((f, i) => { const a = (i / r.shape.length) * Math.PI * 2; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r.r * f, Math.sin(a) * r.r * f); });
    ctx.closePath(); ctx.stroke(); ctx.restore();
  }
  const x = w / 2 + Math.sin(t / 1300) * w * 0.25;
  const y = h / 2 + Math.sin(t / 900) * h * 0.22;
  const a = Math.atan2(Math.cos(t / 900) * h * 0.22 / 900, Math.cos(t / 1300) * w * 0.25 / 1300);
  rocket(ctx, x, y, (a / (Math.PI * 2)) * 256, 1.1, '#3ee6ff', 1, true, t);
  const gx = w / 2 + Math.sin(t / 1300 - 0.9) * w * 0.25;
  const gy = h / 2 + Math.sin(t / 900 - 0.9) * h * 0.22;
  const ga = Math.atan2(Math.cos(t / 900 - 0.9) * h * 0.22 / 900, Math.cos(t / 1300 - 0.9) * w * 0.25 / 1300);
  rocket(ctx, gx, gy, (ga / (Math.PI * 2)) * 256, 1.1, '#ff4fd8', 0.4, true, t);
}

const HEX = { cols: 16, rows: 8 };
const LAND_COLORS = ['#3d6b45', '#2a5135', '#6d6a7d', '#2f7f9a'];
const landTiles = Array.from({ length: HEX.cols * HEX.rows }, (_, i) => ({
  c: i % HEX.cols, r: Math.floor(i / HEX.cols), t: Math.floor(Math.random() * 4), owner: null, at: 0 }));
const CAPITALS = [[3, 2, '#3ee6ff'], [12, 5, '#ff4fd8'], [9, 1, '#ffb020']];
for (const [c, r, color] of CAPITALS) Object.assign(landTiles[r * HEX.cols + c], { owner: color, at: -1e9 });
function landPreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  ctx.fillStyle = '#050810'; ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / (HEX.cols * 1.75 + 1), h / (HEX.rows * 1.5 + 0.6));
  const ox = (w - HEX.cols * 1.732 * s) / 2 + s;
  const oy = (h - HEX.rows * 1.5 * s) / 2 + s * 0.8;
  if (!landPreview.last || t - landPreview.last > 600) {
    landPreview.last = t;
    const owned = landTiles.filter((x) => x.owner);
    const from = owned[Math.floor(Math.random() * owned.length)];
    const free = landTiles.filter((x) => !x.owner && Math.abs(x.c - from.c) <= 1 && Math.abs(x.r - from.r) <= 1);
    const pick = free[Math.floor(Math.random() * free.length)];
    if (pick) Object.assign(pick, { owner: from.owner, at: t });
    if (owned.length > landTiles.length * 0.6) for (const x of landTiles) if (!CAPITALS.some(([c, r]) => c === x.c && r === x.r)) x.owner = null;
  }
  for (const x of landTiles) {
    const cx = ox + 1.732 * s * (x.c + (x.r % 2) * 0.5);
    const cy = oy + 1.5 * s * x.r;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      ctx[i ? 'lineTo' : 'moveTo'](cx + s * 0.95 * Math.cos(a), cy + s * 0.95 * Math.sin(a));
    }
    ctx.closePath();
    ctx.fillStyle = LAND_COLORS[x.t]; ctx.fill();
    if (x.owner) {
      ctx.fillStyle = `${x.owner}66`; ctx.fill();
      ctx.strokeStyle = x.owner; ctx.lineWidth = 1.2; ctx.stroke();
      const k = Math.min(1, (t - x.at) / 600);
      if (k < 1) { ctx.strokeStyle = x.owner; ctx.lineWidth = 2 * (1 - k); ctx.beginPath(); ctx.arc(cx, cy, s * (1 + k), 0, 7); ctx.stroke(); }
    }
  }
}

function duelsPreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  ctx.fillStyle = '#06050f'; ctx.fillRect(0, 0, w, h);
  for (const s of stars.slice(0, 70)) { ctx.fillStyle = `rgba(200,200,255,${s.z * 0.6})`; ctx.fillRect(s.x * w, s.y * h, 1.2, 1.2); }
  const ax = w * 0.22; const bx = w * 0.78; const y = h * 0.55;
  const phase = (t / 2400) % 1;
  rocket(ctx, ax, y + Math.sin(t / 600) * 4, 0, 1.1, '#3ee6ff', 1, true, t);
  rocket(ctx, bx, y + Math.sin(t / 600 + 2) * 4, 128, 1.1, '#ff4fd8', 1, true, t);
  ctx.font = '16px system-ui'; ctx.textAlign = 'center';
  if (phase < 0.45) { ctx.fillText('🔒', ax, y - 34); if (phase > 0.2) ctx.fillText('🔒', bx, y - 34); }
  else if (phase < 0.6) { ctx.strokeStyle = '#3ee6ff'; ctx.lineWidth = 3 * (1 - (phase - 0.45) / 0.15); ctx.shadowColor = '#3ee6ff';
    ctx.shadowBlur = 16; ctx.beginPath(); ctx.moveTo(ax + 20, y); ctx.lineTo(bx - 20, y); ctx.stroke(); ctx.shadowBlur = 0; }
  else { ctx.strokeStyle = '#7dff6a'; ctx.globalAlpha = 1 - (phase - 0.6) / 0.4; ctx.lineWidth = 2; ctx.beginPath();
    for (let a = 0; a < 6; a++) { const ang = Math.PI / 3 * a; ctx[a ? 'lineTo' : 'moveTo'](bx + Math.cos(ang) * 34, y + Math.sin(ang) * 34); }
    ctx.closePath(); ctx.stroke(); ctx.globalAlpha = 1; }
}

const COMET_COLORS = ['#3ee6ff', '#ff4fd8', '#ff8a3d', '#7dff6a', '#a78bff', '#ffd84d'];
const cometTrails = COMET_COLORS.map(() => []);
function derbyPreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  ctx.fillStyle = 'rgba(4,3,12,0.35)'; ctx.fillRect(0, 0, w, h);
  const cx = w / 2; const cy = h / 2;
  const sun = ctx.createRadialGradient(cx, cy, 2, cx, cy, h * 0.22);
  sun.addColorStop(0, '#fff6d0'); sun.addColorStop(0.3, '#ffb347'); sun.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(cx, cy, h * 0.22, 0, 7); ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  COMET_COLORS.forEach((c, i) => {
    const a = t / (1400 - i * 37) + i * 0.4;
    const r = 0.36 + 0.02 * i;
    const x = cx + Math.cos(a) * w * r;
    const y = cy + Math.sin(a) * h * (r + 0.02);
    const tr = cometTrails[i];
    tr.push([x, y]); if (tr.length > 16) tr.shift();
    tr.forEach(([px, py], k) => { ctx.fillStyle = c; ctx.globalAlpha = k / tr.length * 0.5; ctx.beginPath(); ctx.arc(px, py, 1 + k / 6, 0, 7); ctx.fill(); });
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
}

const REEF = { w: 64, h: 28 };
let reefCells = null;
let reefLast = 0;
function reefPreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  if (!reefCells || t - reefLast > 2e4) {
    reefCells = new Uint8Array(REEF.w * REEF.h).map(() => (Math.random() < 0.3 ? 1 + Math.floor(Math.random() * 4) : 0));
    reefLast = t;
  }
  if (!reefPreview.tick || t - reefPreview.tick > 160) {
    reefPreview.tick = t;
    const n = new Uint8Array(reefCells.length);
    for (let y = 0; y < REEF.h; y++) for (let x = 0; x < REEF.w; x++) {
      const ps = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const v = reefCells[((y + dy + REEF.h) % REEF.h) * REEF.w + ((x + dx + REEF.w) % REEF.w)];
        if (v) ps.push(v);
      }
      const self = reefCells[y * REEF.w + x];
      if (self && (ps.length === 2 || ps.length === 3)) n[y * REEF.w + x] = self;
      else if (!self && ps.length === 3) n[y * REEF.w + x] = ps[0] === ps[1] || ps[0] === ps[2] ? ps[0] : ps[1];
    }
    reefCells = n;
  }
  ctx.fillStyle = '#021226'; ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / REEF.w, h / REEF.h);
  const ox = (w - s * REEF.w) / 2; const oy = (h - s * REEF.h) / 2;
  const cols = [null, '#3ee6ff', '#ff4fd8', '#ffb020', '#7dff6a'];
  ctx.shadowBlur = 8;
  for (let i = 0; i < reefCells.length; i++) {
    const v = reefCells[i];
    if (!v) continue;
    ctx.fillStyle = cols[v]; ctx.shadowColor = cols[v];
    ctx.fillRect(ox + (i % REEF.w) * s, oy + Math.floor(i / REEF.w) * s, s - 0.5, s - 0.5);
  }
  ctx.shadowBlur = 0;
}

function sonarPreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  ctx.fillStyle = '#021a12'; ctx.fillRect(0, 0, w, h);
  const cx = w / 2; const cy = h / 2; const R = Math.min(w, h) * 0.45;
  ctx.strokeStyle = 'rgba(80,255,170,0.18)';
  for (let r = R / 4; r <= R; r += R / 4) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke(); }
  const a = t / 1100;
  if (ctx.createConicGradient) {
    const g = ctx.createConicGradient(a - 1.2, cx, cy);
    g.addColorStop(0, 'rgba(80,255,170,0)'); g.addColorStop(0.19, 'rgba(80,255,170,0.35)'); g.addColorStop(0.191, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
  }
  const blips = [[0.3, 0.4, true], [-0.5, 0.2, false], [0.1, -0.6, true], [-0.2, -0.3, false], [0.6, -0.1, false]];
  for (const [bx, by, hit] of blips) {
    const x = cx + bx * R; const y = cy + by * R;
    const ang = ((Math.atan2(by, bx) - a) % 6.283 + 6.283) % 6.283;
    const glow = ang > 5.6 ? 1 : 0.35;
    ctx.fillStyle = hit ? `rgba(255,120,60,${0.5 + 0.5 * glow})` : `rgba(120,255,190,${glow})`;
    ctx.beginPath(); ctx.arc(x, y, hit ? 4 : 2.5, 0, 7); ctx.fill();
  }
}

function motoPreview(canvas, t) {
  const [ctx, w, h] = fit(canvas);
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
  sky.addColorStop(0, '#05030f'); sky.addColorStop(1, '#6b1d63');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  const hz = h * 0.5;
  for (let i = 0; i < 26; i++) { // skyline
    const bx = (i * 37 + 11) % w; const bh = 12 + ((i * 53) % 34);
    ctx.fillStyle = '#120b26'; ctx.fillRect(bx, hz - bh, 26, bh);
    ctx.fillStyle = i % 3 ? 'rgba(255,210,140,0.6)' : 'rgba(150,220,255,0.6)'; ctx.fillRect(bx + 6, hz - bh + 5, 2, 2);
  }
  ctx.fillStyle = '#100c20'; ctx.fillRect(0, hz, w, h - hz);
  const bend = Math.sin(t / 1800) * w * 0.18;
  for (let k = 0; k < 40; k++) {
    const z1 = k / 40; const z2 = (k + 1) / 40;
    const y1 = hz + (h - hz) * z1 * z1; const y2 = hz + (h - hz) * z2 * z2;
    const c1 = w / 2 + bend * (1 - z1) ** 2; const c2 = w / 2 + bend * (1 - z2) ** 2;
    const w1 = w * 0.05 + w * 0.5 * z1 * z1; const w2 = w * 0.05 + w * 0.5 * z2 * z2;
    const stripe = Math.floor(k - t / 60) % 2 === 0;
    ctx.fillStyle = stripe ? '#d22a8a' : '#e8e8ff';
    ctx.beginPath(); ctx.moveTo(c1 - w1 * 1.1, y1); ctx.lineTo(c2 - w2 * 1.1, y2); ctx.lineTo(c2 + w2 * 1.1, y2); ctx.lineTo(c1 + w1 * 1.1, y1); ctx.fill();
    ctx.fillStyle = stripe ? '#262236' : '#2c283e';
    ctx.beginPath(); ctx.moveTo(c1 - w1, y1); ctx.lineTo(c2 - w2, y2); ctx.lineTo(c2 + w2, y2); ctx.lineTo(c1 + w1, y1); ctx.fill();
  }
  const cx = w / 2 + Math.sin(t / 900) * w * 0.06;
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y, r, c] of [[cx, h * 0.84, 14, 'rgba(255,40,80,0.9)'], [w / 2 + bend * 0.3 + 30, hz + 26, 5, 'rgba(255,40,40,0.9)'], [w / 2 + bend * 0.3 + 40, hz + 26, 5, 'rgba(255,40,40,0.9)']]) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2); g.addColorStop(0, c); g.addColorStop(1, 'rgba(255,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2, 0, 7); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ff4fd8'; ctx.beginPath(); ctx.arc(cx, h * 0.74, 7, 0, 7); ctx.fill();
  ctx.fillStyle = '#1b1b2a'; ctx.fillRect(cx - 9, h * 0.76, 18, 16);
}

function draw(t) {
  const [ctx, w, h] = fit(sky);
  ctx.fillStyle = '#04050b'; ctx.fillRect(0, 0, w, h);
  for (const s of stars) {
    const y = (s.y * h + t * 0.01 * s.z) % h;
    ctx.fillStyle = `rgba(200,215,255,${0.15 + s.z * 0.5})`;
    ctx.fillRect(s.x * w, y, s.z * 1.6, s.z * 1.6);
  }
  for (const c of document.querySelectorAll('[data-preview]')) {
    if (c.dataset.preview === 'galaxy') galaxyPreview(c, t);
    else if (c.dataset.preview === 'arcade') arcadePreview(c, t);
    else if (c.dataset.preview === 'land') landPreview(c, t);
    else if (c.dataset.preview === 'duels') duelsPreview(c, t);
    else if (c.dataset.preview === 'derby') derbyPreview(c, t);
    else if (c.dataset.preview === 'reef') reefPreview(c, t);
    else if (c.dataset.preview === 'sonar') sonarPreview(c, t);
    else if (c.dataset.preview === 'moto') motoPreview(c, t);
  }
  requestAnimationFrame(draw);
}

requestAnimationFrame(draw);
await session.restore();
renderCommander();
refresh();
setInterval(refresh, 5000);
