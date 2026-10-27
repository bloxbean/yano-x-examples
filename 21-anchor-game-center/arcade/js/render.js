// Drawing only: reads a Run (and the ghosts' Runs) and never writes to them,
// so what you see can never change a score.

import { H, W, toPixels } from './sim.js';

const HUES = ['#3ee6ff', '#ff4fd8', '#ffb020', '#7dff6a'];
export const GHOST_COLORS = ['#ff4fd8', '#ffb020', '#7dff6a', '#a78bff', '#5ab0ff'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sparks = [];
    this.pops = [];
    this.seen = new WeakMap(); // run → frame of the last event drawn
    this.shake = 0;
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.stars = Array.from({ length: 260 }, () => ({ x: r(), y: r(), z: 0.2 + r() * 0.8 }));
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.k = Math.min(this.w / W, this.h / H);
    this.ox = (this.w - W * this.k) / 2;
    this.oy = (this.h - H * this.k) / 2;
  }

  sx(v) { return this.ox + toPixels(v) * this.k; }
  sy(v) { return this.oy + toPixels(v) * this.k; }

  /** Draw the player's run, any ghosts ({ run, name, color }) and the overlays. */
  frame(run, ghosts = [], { showShip = true } = {}) {
    const { ctx } = this;
    const now = performance.now();
    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= 0.88;
    }
    ctx.fillStyle = 'rgba(4,5,11,0.45)';
    ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
    this.#stars(run);
    ctx.strokeStyle = 'rgba(120,140,220,0.12)';
    ctx.strokeRect(this.ox, this.oy, W * this.k, H * this.k);

    for (const g of ghosts) {
      const s = g.run.ship;
      if (s.dead) continue;
      const x = this.sx(s.x); const y = this.sy(s.y);
      rocket(ctx, x, y, s.a, this.k, g.color, 0.4, s.thrust, now);
      ctx.globalAlpha = 0.65; ctx.fillStyle = g.color; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(`${g.name} ${g.run.score.toLocaleString()}`, x, y - 24 * this.k);
      ctx.globalAlpha = 1;
    }
    for (const r of run.rocks) this.#rock(r);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#3ee6ff'; ctx.shadowBlur = 10;
    for (const s of run.shots) ctx.fillRect(this.sx(s.x) - 2, this.sy(s.y) - 2, 4, 4);
    ctx.shadowBlur = 0;
    this.#events(run);
    for (const p of this.sparks) {
      p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.vy *= 0.97; p.life -= 0.022;
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 2.4, 2.4);
    }
    this.sparks = this.sparks.filter((p) => p.life > 0);
    ctx.globalAlpha = 1;

    const s = run.ship;
    if (showShip && !s.dead && !(s.shield > 0 && Math.floor(now / 100) % 2)) {
      rocket(ctx, this.sx(s.x), this.sy(s.y), s.a, this.k, '#3ee6ff', 1, s.thrust, now);
      if (s.shield > 0) {
        ctx.strokeStyle = 'rgba(62,230,255,0.45)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(this.sx(s.x), this.sy(s.y), 26 * this.k, 0, 7); ctx.stroke();
      }
    }
    for (const p of this.pops) {
      p.y -= 0.6; p.life -= 0.015;
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
      ctx.font = '700 15px ui-monospace, monospace'; ctx.textAlign = 'center';
      ctx.fillText(p.text, p.x, p.y);
    }
    this.pops = this.pops.filter((p) => p.life > 0);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  #stars(run) {
    const { ctx } = this;
    const px = toPixels(run.ship.x);
    const py = toPixels(run.ship.y);
    for (const s of this.stars) {
      const x = ((s.x * this.w - px * s.z * 0.06) % this.w + this.w) % this.w;
      const y = ((s.y * this.h - py * s.z * 0.06) % this.h + this.h) % this.h;
      ctx.fillStyle = `rgba(200,215,255,${0.2 + s.z * 0.6})`;
      ctx.fillRect(x, y, s.z * 1.8, s.z * 1.8);
    }
  }

  #rock(r) {
    const { ctx } = this;
    const color = HUES[r.hue];
    ctx.save();
    ctx.translate(this.sx(r.x), this.sy(r.y));
    ctx.rotate((r.rot / 256) * Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.beginPath();
    r.shape.forEach((pct, i) => {
      const a = (i / r.shape.length) * Math.PI * 2;
      const d = (r.r * pct * this.k) / 100;
      if (i) ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d); else ctx.moveTo(Math.cos(a) * d, Math.sin(a) * d);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  #events(run) {
    const last = this.seen.get(run) ?? 0;
    for (const e of run.events) {
      if (e.frame <= last) continue;
      const x = this.sx(e.x); const y = this.sy(e.y);
      if (e.kind === 'kill') {
        this.#burst(x, y, HUES[e.hue], 14 + e.size * 9, 2 + e.size);
        this.pops.push({ x, y, text: `+${e.points}${e.combo > 1 ? ` ×${e.combo}` : ''}`, life: 1, color: HUES[e.hue] });
      } else {
        this.#burst(x, y, '#3ee6ff', 70, 5);
        this.#burst(x, y, '#ffb020', 40, 3);
        this.pops.push({ x, y, text: '−250', life: 1, color: '#ff5470' });
        this.shake = 14;
      }
    }
    if (run.events.length) this.seen.set(run, run.events[run.events.length - 1].frame);
  }

  #burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * speed;
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, color });
    }
  }
}

/**
 * A rocket pointing along angle `a` (0..255): exhaust plume, fins, a shaded
 * body with a band and a porthole, and a nose cone. `k` scales to the world.
 */
export function rocket(ctx, x, y, a, k, color, alpha, thrust, now) {
  const s = Math.max(0.9, k * 1.15);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((a / 256) * Math.PI * 2);
  ctx.scale(s, s);
  ctx.globalAlpha = alpha;

  if (thrust) {
    const flick = 0.75 + Math.random() * 0.5;
    const plume = ctx.createLinearGradient(-12, 0, -12 - 22 * flick, 0);
    plume.addColorStop(0, 'rgba(255,245,200,0.95)');
    plume.addColorStop(0.35, 'rgba(255,176,32,0.85)');
    plume.addColorStop(1, 'rgba(255,60,40,0)');
    ctx.fillStyle = plume;
    ctx.beginPath();
    ctx.moveTo(-11, 4.5);
    ctx.quadraticCurveTo(-18, 0 + Math.sin(now / 30) * 1.2, -12 - 22 * flick, 0);
    ctx.quadraticCurveTo(-18, 0 - Math.sin(now / 30) * 1.2, -11, -4.5);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(255,176,32,0.45)';
    ctx.beginPath(); ctx.arc(-12, 0, 2.2, 0, 7); ctx.fill();
  }

  // fins
  ctx.fillStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.moveTo(-4, 5); ctx.lineTo(-13, 12); ctx.lineTo(-12, 5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-4, -5); ctx.lineTo(-13, -12); ctx.lineTo(-12, -5); ctx.closePath(); ctx.fill();
  ctx.fillRect(-12, -1, 7, 2); // the centre fin, seen edge-on

  // nozzle and body
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#5b6380';
  ctx.beginPath(); ctx.moveTo(-10, 4); ctx.lineTo(-13, 5.5); ctx.lineTo(-13, -5.5); ctx.lineTo(-10, -4); ctx.closePath(); ctx.fill();
  const body = ctx.createLinearGradient(0, -6, 0, 6);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.45, '#d9deec');
  body.addColorStop(1, '#7b84a3');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-11, 5.5);
  ctx.lineTo(7, 5.5);
  ctx.quadraticCurveTo(13, 4, 18, 0);
  ctx.quadraticCurveTo(13, -4, 7, -5.5);
  ctx.lineTo(-11, -5.5);
  ctx.closePath();
  ctx.fill();

  // nose cone and band in the player's colour
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(9, 5); ctx.quadraticCurveTo(14, 3.6, 18, 0); ctx.quadraticCurveTo(14, -3.6, 9, -5); ctx.closePath();
  ctx.fill();
  ctx.fillRect(-7, -5.5, 2.2, 11);

  // porthole
  ctx.fillStyle = '#0b1a2c';
  ctx.beginPath(); ctx.arc(2, 0, 2.6, 0, 7); ctx.fill();
  ctx.strokeStyle = '#9aa3c2'; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.fillStyle = 'rgba(160,230,255,0.8)';
  ctx.beginPath(); ctx.arc(1.3, -0.8, 0.9, 0, 7); ctx.fill();
  ctx.restore();
}
