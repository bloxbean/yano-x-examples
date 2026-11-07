// Drawing Neon Rush: a pseudo-3D road through a night city (projected road
// segments, billboards for buildings, lamps, signs and traffic), the parallax
// skyline, your bike, ghosts and live riders. Decoration only — it reads the
// simulation and never feeds back into it, so it may use floats freely.

import { LAP, ROAD, SEG, SEGMENTS } from './sim.js';

const DRAW = 170; // segments ahead
const CAM_HEIGHT = 1000;
const CAM_DEPTH = 0.84; // a 100° field of view
const PLAYER_Z = CAM_HEIGHT * CAM_DEPTH; // the camera rides this far behind the bike
const CURVE_SCALE = 0.7;
const HILL_SCALE = 2;
const CAR_COLORS = ['#e94d6a', '#3ea7ff', '#f0f0f0', '#ffcc33', '#7dff6a', '#b07cff'];
const NEON = ['#ff3fd0', '#3ee6ff', '#ffb020', '#7dff6a', '#a78bff', '#ff5a5a'];

function mulberry(seed) { // decoration-only randomness for the pre-drawn buildings
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function paintBuilding(k) {
  const r = mulberry(1000 + k);
  const c = document.createElement('canvas');
  const w = 140 + Math.floor(r() * 90);
  const h = 320 + Math.floor(r() * 420);
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const tone = 14 + Math.floor(r() * 18);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, `rgb(${tone},${tone + 4},${tone + 22})`);
  grad.addColorStop(1, `rgb(${tone + 10},${tone + 12},${tone + 34})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const cols = 4 + Math.floor(r() * 4);
  const rows = Math.floor(h / 26);
  const cw = (w - 16) / cols;
  const warm = r() < 0.5;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const lit = r() < 0.42;
      g.fillStyle = lit ? (warm ? `rgba(255,${200 + Math.floor(r() * 40)},${120 + Math.floor(r() * 60)},0.9)` : `rgba(${150 + Math.floor(r() * 60)},220,255,0.85)`) : 'rgba(10,12,26,0.9)';
      g.fillRect(8 + x * cw + 2, 14 + y * 26, cw - 5, 14);
    }
  }
  if (r() < 0.7) { // a neon band near the top
    const neon = NEON[Math.floor(r() * NEON.length)];
    g.shadowColor = neon;
    g.shadowBlur = 16;
    g.fillStyle = neon;
    g.fillRect(6, 6, w - 12, 5);
    if (r() < 0.6) { g.fillRect(w * 0.2, 16, w * 0.6, 18); g.fillStyle = '#10101c'; g.fillRect(w * 0.2 + 3, 19, w * 0.6 - 6, 12); }
  }
  return c;
}

function paintSkyline(seed, height, tone) {
  const r = mulberry(seed);
  const c = document.createElement('canvas');
  c.width = 2400;
  c.height = height;
  const g = c.getContext('2d');
  let x = 0;
  while (x < c.width) {
    const bw = 40 + r() * 110;
    const bh = height * (0.3 + r() * 0.7);
    g.fillStyle = tone;
    g.fillRect(x, height - bh, bw, bh);
    for (let k = 0; k < bh / 9; k++) {
      if (r() < 0.25) {
        g.fillStyle = r() < 0.5 ? 'rgba(255,210,140,0.55)' : 'rgba(150,220,255,0.5)';
        g.fillRect(x + 4 + r() * (bw - 10), height - bh + 6 + k * 9, 3, 3);
      }
    }
    if (r() < 0.15) { g.fillStyle = NEON[Math.floor(r() * NEON.length)]; g.fillRect(x + bw / 2 - 1, height - bh - 18, 2, 18); }
    x += bw + r() * 6;
  }
  return c;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.buildings = Array.from({ length: 12 }, (_, k) => paintBuilding(k));
    this.skyFar = paintSkyline(7, 220, '#120c2a');
    this.skyNear = paintSkyline(11, 300, '#0b0819');
    this.skyOffset = 0;
    this.sparks = [];
    this.size = [0, 0];
    new ResizeObserver(() => this.#fit()).observe(canvas);
    this.#fit();
  }

  #fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = [w, h];
  }

  #project(wx, wy, wz, cam) {
    const [w, h] = this.size;
    const cz = wz - cam.z;
    const scale = CAM_DEPTH / Math.max(1, cz);
    return { x: w / 2 + scale * (wx - cam.x) * w / 2, y: h / 2 - scale * (wy - cam.y) * h / 2, w: scale * ROAD * w / 2, scale, cz };
  }

  /**
   * view: { run, ghosts: [{ name, color, run }], live: [{ name, z, x }], now, label }
   */
  frame(view) {
    const { ctx } = this;
    const [w, h] = this.size;
    if (!w || !view.run) return;
    const run = view.run;
    const track = run.track;
    const segs = track.segments;
    const camZ = run.z - PLAYER_Z;
    const camMod = ((camZ % LAP) + LAP) % LAP;
    const baseIdx = Math.floor(camMod / SEG);
    const basePct = (camMod % SEG) / SEG;
    const playerSeg = run.track.segment(run.z);
    const camY = (playerSeg.y * HILL_SCALE) + CAM_HEIGHT;

    // sky and skyline (parallax with the bends)
    const speed = run.v >> 4;
    this.skyOffset += segs[baseIdx].curve * speed * 0.004;
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, '#05030f');
    sky.addColorStop(0.65, '#2a0f45');
    sky.addColorStop(1, '#7a1f6b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    const moonX = w * 0.78 - this.skyOffset * 2 % w;
    const moon = ctx.createRadialGradient(moonX, h * 0.16, 2, moonX, h * 0.16, 70);
    moon.addColorStop(0, 'rgba(255,240,255,0.9)'); moon.addColorStop(0.2, 'rgba(255,200,255,0.35)'); moon.addColorStop(1, 'rgba(255,120,255,0)');
    ctx.fillStyle = moon; ctx.beginPath(); ctx.arc(moonX, h * 0.16, 70, 0, 7); ctx.fill();
    const horizon = h * 0.5;
    for (const [layer, k, scaleY] of [[this.skyFar, 6, 0.85], [this.skyNear, 12, 1]]) {
      const lw = layer.width;
      const lh = layer.height * scaleY * (h / 700);
      const off = (((this.skyOffset * k) % lw) + lw) % lw;
      for (let x = -off; x < w; x += lw) ctx.drawImage(layer, x, horizon - lh + 8, lw, lh);
    }

    // project the road
    const cam = { x: run.x, y: camY, z: 0 };
    const list = [];
    let x = 0;
    let dx = -(segs[baseIdx].curve * basePct * CURVE_SCALE);
    let maxy = h;
    for (let n = 0; n < DRAW; n++) {
      const idx = (baseIdx + n) % SEGMENTS;
      const s = segs[idx];
      const z1 = (n - basePct) * SEG;
      const z2 = z1 + SEG;
      const next = segs[(idx + 1) % SEGMENTS];
      const p1 = this.#project(x, s.y * HILL_SCALE, z1, cam);
      const p2 = this.#project(x + dx, next.y * HILL_SCALE, z2, cam);
      x += dx;
      dx += s.curve * CURVE_SCALE;
      const item = { n, idx, s, p1, p2, clip: maxy, visible: false };
      list.push(item);
      if (p1.cz <= 1 || p2.y >= p1.y || p2.y >= maxy) continue;
      item.visible = true;
      this.#segment(n, idx, p1, p2, Math.min(p1.y, maxy));
      maxy = p2.y;
    }

    // sprites, far to near
    const carsBySeg = new Map();
    for (const c of run.cars) {
      let rel = c.z - camMod;
      if (rel < 0) rel += LAP;
      const n = Math.floor((rel + basePct * SEG) / SEG);
      if (n >= 1 && n < DRAW) {
        if (!carsBySeg.has(n)) carsBySeg.set(n, []);
        carsBySeg.get(n).push({ car: c, pct: ((rel + basePct * SEG) % SEG) / SEG });
      }
    }
    const riders = [];
    for (const g of view.ghosts ?? []) riders.push({ name: g.name, color: g.color, z: g.run.z, x: g.run.x, ghost: true });
    for (const l of view.live ?? []) riders.push({ name: l.name, color: '#ffffff', z: l.z, x: l.x, live: true });
    const ridersBySeg = new Map();
    for (const r of riders) {
      const rel = r.z - camZ;
      if (rel < 200 || rel > (DRAW - 2) * SEG) continue;
      const n = Math.floor((rel + basePct * SEG) / SEG);
      if (!ridersBySeg.has(n)) ridersBySeg.set(n, []);
      ridersBySeg.get(n).push({ ...r, pct: ((rel + basePct * SEG) % SEG) / SEG });
    }
    for (let n = DRAW - 1; n > 0; n--) {
      const it = list[n];
      if (!it) continue;
      const { s, p1, p2, clip } = it;
      if (p1.cz <= 1) continue;
      const fog = Math.min(1, n / DRAW);
      const bx = (wx) => p1.x + p1.scale * wx * w / 2;
      for (const b of [s.left, s.right]) {
        if (!b) continue;
        const img = this.buildings[b.kind];
        const bw = p1.scale * 760 * w / 2;
        const bh = bw * (img.height / img.width);
        const cx = bx(b.x) - (b.x < 0 ? bw : 0);
        this.#sprite(img, cx, p1.y - bh, bw, bh, clip, 1 - fog * 0.75);
      }
      if (s.lamp) for (const side of [-1, 1]) this.#lamp(bx(side * 1180), p1.y, p1.scale * w / 2, clip, side, fog);
      if (s.sign) this.#sign(bx(s.sign.side * 1420), p1.y, p1.scale * w / 2, clip, NEON[s.sign.hue], now(view), fog);
      for (const { car, pct } of carsBySeg.get(n) ?? []) {
        const px = p1.x + (p2.x - p1.x) * pct;
        const py = p1.y + (p2.y - p1.y) * pct;
        const sc = p1.scale + (p2.scale - p1.scale) * pct;
        this.#car(px + sc * car.x * w / 2, py, sc * w / 2, clip, CAR_COLORS[car.kind], fog);
      }
      for (const r of ridersBySeg.get(n) ?? []) {
        const px = p1.x + (p2.x - p1.x) * r.pct;
        const py = p1.y + (p2.y - p1.y) * r.pct;
        const sc = p1.scale + (p2.scale - p1.scale) * r.pct;
        this.#riderSprite(px + sc * r.x * w / 2, py, sc * w / 2, clip, r);
      }
    }

    // haze at the horizon
    const haze = ctx.createLinearGradient(0, horizon - 40, 0, horizon + 60);
    haze.addColorStop(0, 'rgba(160,60,160,0)'); haze.addColorStop(0.5, 'rgba(160,60,170,0.18)'); haze.addColorStop(1, 'rgba(160,60,160,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, horizon - 40, w, 100);

    this.#bike(run, now(view), speed);
    this.#speedLines(speed, now(view));
  }

  #segment(n, idx, p1, p2, top) {
    const { ctx } = this;
    const [w] = this.size;
    const dark = Math.floor(idx / 3) % 2 === 0;
    const fog = Math.min(1, (n / DRAW) ** 1.4);
    const mix = (c, f) => c.map((v, i) => Math.round(v * (1 - f) + [42, 16, 60][i] * f));
    const rgb = (c) => `rgb(${c.join(',')})`;
    const poly = (x1, y1, w1, x2, y2, w2, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1 - w1, y1); ctx.lineTo(x2 - w2, y2); ctx.lineTo(x2 + w2, y2); ctx.lineTo(x1 + w1, y1);
      ctx.closePath(); ctx.fill();
    };
    const y1 = Math.min(p1.y, top + 1);
    ctx.fillStyle = rgb(mix(dark ? [16, 14, 30] : [20, 18, 36], fog)); // the pavement
    ctx.fillRect(0, p2.y, w, y1 - p2.y + 1);
    poly(p1.x, y1, p1.w * 1.18, p2.x, p2.y, p2.w * 1.18, rgb(mix(dark ? [210, 40, 120] : [240, 240, 255], fog))); // kerb
    poly(p1.x, y1, p1.w, p2.x, p2.y, p2.w, rgb(mix(dark ? [34, 32, 48] : [38, 36, 54], fog))); // asphalt
    if (dark) {
      for (const lane of [-0.43, 0, 0.43]) {
        poly(p1.x + p1.w * lane, y1, p1.w * 0.012, p2.x + p2.w * lane, p2.y, p2.w * 0.012, rgb(mix(lane ? [190, 190, 220] : [255, 200, 60], fog)));
      }
    }
    if (idx === 0 || idx === 1) poly(p1.x, y1, p1.w, p2.x, p2.y, p2.w, idx === 0 ? '#ffffff' : '#111111'); // start/finish
  }

  #sprite(img, x, y, w, h, clip, alpha) {
    const { ctx } = this;
    if (y >= clip || w < 1) return;
    const visible = Math.min(h, clip - y);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, 0, 0, img.width, img.height * (visible / h), x, y, w, visible);
    ctx.globalAlpha = 1;
  }

  #lamp(x, y, unit, clip, side, fog) {
    const { ctx } = this;
    const pole = 1500 * unit;
    if (y - pole >= clip) return;
    ctx.globalAlpha = 1 - fog * 0.7;
    ctx.fillStyle = '#2a2a3c';
    ctx.fillRect(x - Math.max(1, 14 * unit), y - pole, Math.max(1, 28 * unit), Math.min(pole, clip - (y - pole)));
    const hx = x - side * 220 * unit;
    const hy = y - pole;
    ctx.fillRect(Math.min(x, hx), hy, Math.abs(x - hx), Math.max(1, 18 * unit));
    ctx.globalCompositeOperation = 'lighter';
    const r = Math.max(4, 260 * unit);
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, r);
    g.addColorStop(0, 'rgba(255,220,160,0.9)'); g.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, hy, r, 0, 7); ctx.fill();
    if (y < clip) { // a pool of light on the road
      const pool = ctx.createRadialGradient(hx, y, 0, hx, y, 600 * unit);
      pool.addColorStop(0, 'rgba(255,190,120,0.18)'); pool.addColorStop(1, 'rgba(255,160,90,0)');
      ctx.fillStyle = pool; ctx.beginPath(); ctx.ellipse(hx, y, 600 * unit, 160 * unit, 0, 0, 7); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  #sign(x, y, unit, clip, color, t, fog) {
    const { ctx } = this;
    const sh = 900 * unit;
    const sw = 200 * unit;
    const top = y - 1700 * unit;
    if (top >= clip) return;
    ctx.globalAlpha = 1 - fog * 0.6;
    ctx.fillStyle = '#0d0b1a';
    ctx.fillRect(x - sw / 2, top, sw, Math.min(sh, clip - top));
    const flicker = Math.sin(t / 90 + x) > -0.92 ? 1 : 0.3;
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = color; ctx.shadowBlur = 18;
    ctx.strokeStyle = color; ctx.globalAlpha = (1 - fog * 0.6) * flicker;
    ctx.lineWidth = Math.max(1, 26 * unit);
    ctx.strokeRect(x - sw / 2 + 30 * unit, top + 30 * unit, sw - 60 * unit, Math.min(sh - 60 * unit, Math.max(0, clip - top - 30 * unit)));
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  #car(x, y, unit, clip, color, fog) {
    const { ctx } = this;
    const cw = 420 * unit;
    const ch = 230 * unit;
    if (y - ch >= clip || cw < 2) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(x - cw, y - ch * 2, cw * 2, clip - (y - ch * 2)); ctx.clip();
    ctx.globalAlpha = 1 - fog * 0.6;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.ellipse(x, y, cw * 0.6, ch * 0.12, 0, 0, 7); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(x - cw / 2, y - ch, cw, ch * 0.75, ch * 0.12); ctx.fill();
    ctx.fillStyle = '#121226';
    ctx.beginPath(); ctx.roundRect(x - cw * 0.36, y - ch * 1.32, cw * 0.72, ch * 0.42, ch * 0.1); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of [-1, 1]) {
      const lx = x + s * cw * 0.36;
      const ly = y - ch * 0.62;
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, cw * 0.32);
      g.addColorStop(0, 'rgba(255,60,60,0.95)'); g.addColorStop(1, 'rgba(255,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(lx, ly, cw * 0.32, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  #riderSprite(x, y, unit, clip, r) {
    const { ctx } = this;
    const s = 520 * unit;
    if (y - s * 2 >= clip || s < 2) return;
    const color = r.live ? '#ffffff' : r.color;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(x, y - s * 0.7, 0, x, y - s * 0.7, s * 1.3);
    halo.addColorStop(0, `${color}55`); halo.addColorStop(1, `${color}00`);
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y - s * 0.7, s * 1.3, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = r.ghost ? 0.55 : 0.9;
    ctx.fillStyle = '#0c0c14';
    ctx.beginPath(); ctx.roundRect(x - s * 0.1, y - s * 0.55, s * 0.2, s * 0.56, s * 0.08); ctx.fill(); // tyre
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(x - s * 0.26, y - s * 0.95, s * 0.52, s * 0.42, s * 0.12); ctx.fill(); // bike
    ctx.beginPath(); ctx.roundRect(x - s * 0.18, y - s * 1.35, s * 0.36, s * 0.45, s * 0.14); ctx.fill(); // rider
    ctx.beginPath(); ctx.arc(x, y - s * 1.5, s * 0.17, 0, 7); ctx.fill(); // helmet
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    const tail = ctx.createRadialGradient(x, y - s * 0.7, 0, x, y - s * 0.7, s * 0.35);
    tail.addColorStop(0, 'rgba(255,40,80,0.95)'); tail.addColorStop(1, 'rgba(255,0,60,0)');
    ctx.fillStyle = tail; ctx.beginPath(); ctx.arc(x, y - s * 0.7, s * 0.35, 0, 7); ctx.fill();
    ctx.restore();
    const label = `${r.live ? '● LIVE ' : '◐ '}${r.name}`;
    ctx.font = '600 11px system-ui';
    const tw = ctx.measureText(label).width + 12;
    const ly = y - s * 1.75 - 10;
    ctx.fillStyle = 'rgba(8,6,20,0.75)';
    ctx.beginPath(); ctx.roundRect(x - tw / 2, ly - 12, tw, 17, 8); ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, ly);
  }

  #bike(run, t, speed) {
    const { ctx } = this;
    const [w, h] = this.size;
    const seg = run.track.segment(run.z);
    const lean = run.steer * 0.32 + -seg.curve * 0.02 * (speed / 135);
    const bx = w / 2;
    const by = h * 0.97;
    const s = Math.min(w, h) * 0.00085;
    const bounce = Math.sin(t / 45) * (speed > 5 ? 1.2 : 0);
    ctx.save();
    ctx.translate(bx, by + bounce);
    ctx.rotate(lean);
    // headlight cone ahead
    ctx.globalCompositeOperation = 'lighter';
    const cone = ctx.createRadialGradient(0, -60 * s, 10, 0, -260 * s, 260 * s);
    cone.addColorStop(0, 'rgba(255,250,220,0.12)'); cone.addColorStop(1, 'rgba(255,250,220,0)');
    ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(-30 * s, -60 * s); ctx.lineTo(-220 * s, -380 * s); ctx.lineTo(220 * s, -380 * s); ctx.lineTo(30 * s, -60 * s); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // shadow, tyre, body
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.ellipse(0, 6 * s, 70 * s, 14 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#0c0c12';
    ctx.beginPath(); ctx.roundRect(-20 * s, -70 * s, 40 * s, 76 * s, 14 * s); ctx.fill();
    const body = ctx.createLinearGradient(-60 * s, 0, 60 * s, 0);
    body.addColorStop(0, '#13b8d8'); body.addColorStop(0.5, '#7ff4ff'); body.addColorStop(1, '#0b7f9a');
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.roundRect(-58 * s, -118 * s, 116 * s, 60 * s, 18 * s); ctx.fill();
    ctx.fillStyle = '#1b1b2a';
    ctx.beginPath(); ctx.roundRect(-34 * s, -150 * s, 68 * s, 40 * s, 12 * s); ctx.fill();
    // rider
    ctx.fillStyle = '#20202e';
    ctx.beginPath(); ctx.roundRect(-38 * s, -210 * s, 76 * s, 80 * s, 26 * s); ctx.fill();
    const helmet = ctx.createRadialGradient(-10 * s, -250 * s, 4, 0, -240 * s, 36 * s);
    helmet.addColorStop(0, '#ffffff'); helmet.addColorStop(0.4, '#ff4fd8'); helmet.addColorStop(1, '#5a0f50');
    ctx.fillStyle = helmet; ctx.beginPath(); ctx.arc(0, -240 * s, 34 * s, 0, 7); ctx.fill();
    // tail light and exhaust
    ctx.globalCompositeOperation = 'lighter';
    const tail = ctx.createRadialGradient(0, -86 * s, 0, 0, -86 * s, 46 * s);
    tail.addColorStop(0, 'rgba(255,40,70,1)'); tail.addColorStop(1, 'rgba(255,0,40,0)');
    ctx.fillStyle = tail; ctx.beginPath(); ctx.arc(0, -86 * s, 46 * s, 0, 7); ctx.fill();
    if (speed > 10) {
      for (const side of [-1, 1]) {
        const fx = side * 46 * s;
        const len = (18 + Math.random() * 16) * s * (speed / 135);
        const g = ctx.createRadialGradient(fx, -52 * s, 0, fx, -52 * s + len, len + 8);
        g.addColorStop(0, 'rgba(120,200,255,0.8)'); g.addColorStop(1, 'rgba(60,120,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(fx, -52 * s + len / 2, len, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
    if (run.bump > 20) { // a crash flash
      ctx.fillStyle = `rgba(255,80,80,${(run.bump - 20) / 60})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  #speedLines(speed, t) {
    if (speed < 95) return;
    const { ctx } = this;
    const [w, h] = this.size;
    const k = (speed - 95) / 40;
    ctx.strokeStyle = `rgba(255,255,255,${0.12 * k})`;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + t / 900;
      const r1 = Math.min(w, h) * (0.45 + ((t / 60 + i * 37) % 30) / 100);
      const cx = w / 2;
      const cy = h * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.6);
      ctx.lineTo(cx + Math.cos(a) * (r1 + 60 * k), cy + Math.sin(a) * (r1 + 60 * k) * 0.6);
      ctx.stroke();
    }
  }
}

const now = (view) => view.now ?? performance.now();
