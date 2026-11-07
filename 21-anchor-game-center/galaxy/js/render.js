// Drawing only. The renderer is handed a galaxy that has been run ahead to
// "now" (a clone), so between blocks fleets keep flying and planets keep
// growing; when the next block lands, the authoritative galaxy catches up and
// the picture continues without a jump.

const COLORS = ['#3ee6ff', '#ff4fd8', '#ffb020', '#7dff6a', '#a78bff', '#ff6b6b', '#5ab0ff', '#f9f871'];
const NEUTRAL = '#59607a';

/** You are always cyan; the other commanders share the remaining seven colours. */
export function playerColor(index, me) {
  if (index < 0) return NEUTRAL;
  if (index === me) return COLORS[0];
  return COLORS[1 + ((index - (me >= 0 && index > me ? 1 : 0)) % 7)];
}

export class Renderer {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.me = -1;
    this.particles = [];
    this.rings = [];
    this.seenEvents = new Set();
    this.beam = 0;
    this.sealGlow = 0;
    this.stars = [];
    let seed = 11;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 280; i++) this.stars.push({ x: r(), y: r(), s: r() * 1.4 + 0.2, t: r() * 6 });
    this.resize();
    // The canvas changes size with the layout (side panel, banner, rotation), not only the window.
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = this.cfg.game;
    this.scale = Math.min(this.w / g.width, this.h / g.height);
    this.ox = (this.w - g.width * this.scale) / 2;
    this.oy = (this.h - g.height * this.scale) / 2;
  }

  sx(x) { return this.ox + x * this.scale; }
  sy(y) { return this.oy + y * this.scale; }
  radius(p) { return (9 + p.size * 6) * Math.max(0.7, this.scale); }
  colorOf(owner) { return playerColor(owner, this.me); }

  /** The planet under a screen point (canvas-relative), if any. */
  planetAt(planets, x, y) {
    return planets.find((p) => Math.hypot(this.sx(p.x) - x, this.sy(p.y) - y) < this.radius(p) + 12);
  }

  seal() {
    this.beam = 1;
    this.sealGlow = 1;
  }

  /**
   * Draw one frame. `view` is a galaxy clone advanced to `t`; `ui` carries the
   * player's index, selection, drag line and pending (not yet final) launches.
   */
  frame(view, t, ui) {
    const { ctx } = this;
    const now = performance.now();
    this.me = ui.me;
    ctx.clearRect(0, 0, this.w, this.h);
    this.#background(now);
    this.#effectsFromEvents(view);

    for (const f of view.fleets) this.#fleet(view, f, t, false);
    for (const p of ui.pending) this.#pendingFleet(view, p, now);
    for (const p of view.planets) this.#planet(view, p, t, now, ui);
    this.#overlays(view, ui, now);
    this.beam = Math.max(0, this.beam - 0.01);
    this.sealGlow = Math.max(0, this.sealGlow - 0.006);
  }

  #background(now) {
    const { ctx, w, h } = this;
    for (const [x, y, r, c] of [[0.25, 0.3, 0.5, 'rgba(90,40,200,0.16)'], [0.78, 0.72, 0.55, 'rgba(0,140,200,0.12)'],
      [0.62, 0.12, 0.3, 'rgba(220,40,140,0.08)']]) {
      const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * Math.max(w, h));
      g.addColorStop(0, c);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = '#cfd8ff';
    for (const s of this.stars) {
      ctx.globalAlpha = 0.3 + 0.7 * Math.abs(Math.sin(now / 1500 + s.t));
      ctx.fillRect(s.x * w, s.y * h, s.s, s.s);
    }
    ctx.globalAlpha = 1;
    if (this.beam > 0) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `rgba(255,204,77,${0.3 * this.beam})`);
      g.addColorStop(1, 'rgba(255,204,77,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }

  #effectsFromEvents(view) {
    for (const e of view.s.events) {
      const key = `${e.seq}:${e.kind}`;
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      const p = view.planets[e.planet];
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      const color = this.colorOf(e.kind === 'capture' ? e.owner : e.attacker);
      const n = e.kind === 'capture' ? 34 : 14;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 0.6 + Math.random() * (e.kind === 'capture' ? 3 : 1.8);
        this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, c: color });
      }
      if (e.kind === 'capture') this.rings.push({ x, y, r: this.radius(p), life: 1, c: color });
    }
    if (this.seenEvents.size > 2000) this.seenEvents = new Set([...this.seenEvents].slice(-500));
  }

  #planet(view, p, t, now, ui) {
    const { ctx } = this;
    const x = this.sx(p.x);
    const y = this.sy(p.y);
    const r = this.radius(p);
    const c = this.colorOf(p.owner);
    const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
    glow.addColorStop(0, `${c}55`);
    glow.addColorStop(1, `${c}00`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 7); ctx.fill();
    const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.25, c);
    body.addColorStop(1, '#05060d');
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();

    const mine = ui.me >= 0 && p.owner === ui.me;
    ctx.strokeStyle = mine ? c : `${c}99`;
    ctx.lineWidth = mine ? 2 : 1.4;
    ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = -(now / 60 + p.id * 7);
    ctx.beginPath(); ctx.arc(x, y, r + 6, 0, 7); ctx.stroke();
    ctx.setLineDash([]);
    if (ui.selected === p.id) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 10 + Math.sin(now / 150) * 1.5, 0, 7); ctx.stroke();
    }
    if (this.sealGlow > 0) {
      ctx.strokeStyle = `rgba(255,204,77,${this.sealGlow})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 12, 0, 7); ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(12 + p.size)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.floor(view.shipsAt(p, t) / 1000)), x, y);
    ctx.fillStyle = 'rgba(200,210,240,0.55)';
    ctx.font = '11px system-ui';
    const owner = p.owner >= 0 ? view.players[p.owner]?.id : '';
    ctx.fillText(owner ? `${p.name} · ${owner}` : p.name, x, y + r + 16);
  }

  #fleet(view, f, t) {
    const from = view.planets[f.from];
    const to = view.planets[f.to];
    const k = Math.max(0, Math.min(1, (t - f.launched) / Math.max(1, f.arrive - f.launched)));
    this.#swarm(from, to, k, this.colorOf(f.owner), Math.floor(f.milli / 1000), f.seq, false);
  }

  #pendingFleet(view, p, now) {
    const from = view.planets[p.from];
    const to = view.planets[p.to];
    const k = Math.min(0.12, (now - p.at) / 8000);
    this.#swarm(from, to, k, this.colorOf(p.owner), p.ships, p.at, true);
  }

  #swarm(from, to, k, color, ships, seed, pending) {
    const { ctx } = this;
    const ax = this.sx(from.x); const ay = this.sy(from.y);
    const bx = this.sx(to.x); const by = this.sy(to.y);
    const dx = bx - ax; const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; const ny = dx / len;
    const now = performance.now();
    ctx.strokeStyle = `${color}${pending ? '66' : '22'}`;
    ctx.lineWidth = 1;
    ctx.setLineDash(pending ? [3, 5] : []);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    const n = Math.min(14, 2 + Math.floor(ships / 5));
    const angle = Math.atan2(dy, dx);
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const kk = Math.max(0, Math.min(1, k - (i / n) * 0.06));
      if (kk <= 0 && !pending) continue;
      const wob = Math.sin(seed + i * 1.7 + now / 300) * 7 * Math.sin(Math.max(kk, 0.05) * Math.PI);
      const x = ax + dx * kk + nx * wob;
      const y = ay + dy * kk + ny * wob;
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.scale(1.5, 1.5);
      miniRocket(ctx, color, pending ? 0.45 : 1, now / 40 + i * 2.3);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    const mx = ax + dx * k; const my = ay + dy * k;
    ctx.fillStyle = color;
    ctx.font = '700 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(pending ? `${ships} · finalizing…` : String(ships), mx + nx * 14, my + ny * 14 - 4);
  }

  #overlays(view, ui, now) {
    const { ctx } = this;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      ctx.strokeStyle = r.c; ctx.globalAlpha = r.life; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r + (1 - r.life) * 70, 0, 7); ctx.stroke();
      r.life -= 0.02;
      if (r.life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const b = this.particles[i];
      b.x += b.vx; b.y += b.vy; b.vx *= 0.96; b.vy *= 0.96; b.life -= 0.022;
      ctx.globalAlpha = Math.max(0, b.life); ctx.fillStyle = b.c; ctx.fillRect(b.x, b.y, 2.2, 2.2);
      if (b.life <= 0) this.particles.splice(i, 1);
    }
    ctx.globalAlpha = 1;
    if (ui.drag) {
      const from = view.planets[ui.drag.from];
      const color = this.colorOf(ui.me);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -now / 30;
      ctx.beginPath(); ctx.moveTo(this.sx(from.x), this.sy(from.y)); ctx.lineTo(ui.drag.x, ui.drag.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = '700 12px system-ui'; ctx.textAlign = 'left';
      ctx.fillText(`send ${ui.drag.ships} ships`, ui.drag.x + 12, ui.drag.y - 10);
    }
  }
}

/** A small rocket pointing along +x: exhaust plume, fins, body, nose cone and porthole. */
function miniRocket(ctx, color, alpha, flicker) {
  ctx.globalAlpha = alpha;
  const plume = 5 + Math.abs(Math.sin(flicker)) * 4;
  ctx.fillStyle = '#ffb020';
  ctx.beginPath(); ctx.moveTo(-4, 1.4); ctx.lineTo(-4 - plume, 0); ctx.lineTo(-4, -1.4); ctx.fill();
  ctx.fillStyle = '#fff3c4';
  ctx.beginPath(); ctx.moveTo(-4, 0.7); ctx.lineTo(-4 - plume * 0.5, 0); ctx.lineTo(-4, -0.7); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(-1, 1.6); ctx.lineTo(-5, 3.8); ctx.lineTo(-4, 1.6); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-1, -1.6); ctx.lineTo(-5, -3.8); ctx.lineTo(-4, -1.6); ctx.fill();
  ctx.fillStyle = '#e8ecf8';
  ctx.fillRect(-4, -1.7, 7, 3.4);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(3, 1.7); ctx.lineTo(7, 0); ctx.lineTo(3, -1.7); ctx.fill();
  ctx.fillStyle = '#05060d';
  ctx.beginPath(); ctx.arc(0.6, 0, 0.9, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
}
