// Drawing Comet Derby. Reads a Race (derby.js) and never feeds back into it:
// lanes, trails, sparks and the nebula are decoration, so they may use floats
// and Math.random freely.

import { LAP, PADS, WELLS } from './derby.js';

const TAU = Math.PI * 2;

/** The track: a lopsided loop around the sun, in unit coordinates. */
function trackPoint(f) {
  const t = f * TAU - Math.PI / 2;
  const r = 1 + 0.22 * Math.cos(3 * t + 0.6) + 0.08 * Math.sin(5 * t);
  return [Math.cos(t) * r, Math.sin(t) * r * 0.62];
}

export class Renderer {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.ctx = canvas.getContext('2d');
    this.trails = cfg.comets.map(() => []);
    this.sparks = [];
    this.rings = [];
    this.beams = [];
    this.seenEvents = 0;
    this.raceKey = null;
    this.nebula = null;
    this.size = [0, 0];
    this.stars = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random(), p: Math.random() * TAU }));
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
    this.scale = Math.min(w / 2.7, h / 1.75);
    this.center = [w / 2, h / 2 + h * 0.02];
    this.path = Array.from({ length: 721 }, (_, i) => this.#screen(i / 720));
    this.nebula = this.#paintNebula(w, h);
    for (const t of this.trails) t.length = 0;
  }

  #screen(f, lane = 0) {
    const [x, y] = trackPoint(f);
    const [x2, y2] = trackPoint(f + 0.0005);
    const dx = x2 - x;
    const dy = y2 - y;
    const len = Math.hypot(dx, dy) || 1;
    const s = this.scale;
    return [this.center[0] + x * s - (dy / len) * lane, this.center[1] + y * s + (dx / len) * lane];
  }

  #paintNebula(w, h) {
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d');
    g.fillStyle = '#04030c';
    g.fillRect(0, 0, w, h);
    const hues = ['#3b1d7a', '#0f4a6b', '#6b1d5c', '#1d2f7a', '#5a2a10'];
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = (0.12 + Math.random() * 0.35) * Math.max(w, h);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `${hues[i % hues.length]}55`);
      grad.addColorStop(1, '#00000000');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }
    return off;
  }

  /** Lane offset in px for comet i (six lanes across the ribbon). */
  #lane(i, t) { return (i - (this.cfg.comets.length - 1) / 2) * 7 + Math.sin(t / 400 + i * 1.7) * 1.5; }

  /**
   * view: { race, raceKey, highlight, now, parked }
   *   race      a Race stepped to the tick to show (or null)
   *   raceKey   changes when a different race is shown (clears trails)
   *   highlight comet index to emphasise (your pick)
   *   parked    true while comets wait on the grid
   */
  frame(view) {
    const { ctx } = this;
    const [w, h] = this.size;
    if (!w) return;
    const now = view.now;
    if (view.raceKey !== this.raceKey) {
      this.raceKey = view.raceKey;
      this.seenEvents = 0;
      for (const t of this.trails) t.length = 0;
      this.sparks.length = 0;
      this.rings.length = 0;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.nebula, 0, 0, w, h);
    for (const s of this.stars) {
      const a = 0.25 + 0.55 * s.z * (0.6 + 0.4 * Math.sin(now / 700 + s.p));
      ctx.fillStyle = `rgba(210,220,255,${a})`;
      ctx.fillRect(s.x * w, s.y * h, s.z * 1.7, s.z * 1.7);
    }
    this.#sun(now);
    this.#track(now);
    if (view.race) this.#comets(view, now);
    else if (view.parked) this.#parked(view, now);
    this.#effects(now);
  }

  #sun(now) {
    const { ctx } = this;
    const [cx, cy] = this.center;
    const r = this.scale * 0.13;
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 3; k >= 1; k--) {
      const rr = r * (1 + k * 0.9 + 0.08 * Math.sin(now / 300 + k));
      const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, rr);
      g.addColorStop(0, 'rgba(255,200,90,0.35)');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    const core = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
    core.addColorStop(0, '#fffbe8'); core.addColorStop(0.45, '#ffd36b'); core.addColorStop(1, '#ff7a1a');
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  }

  #track(now) {
    const { ctx, path } = this;
    const line = (width, style) => {
      ctx.lineWidth = width; ctx.strokeStyle = style;
      ctx.beginPath(); path.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); ctx.closePath(); ctx.stroke();
    };
    ctx.lineJoin = 'round';
    line(52, 'rgba(90,110,255,0.06)');
    line(44, 'rgba(10,12,30,0.55)');
    line(1.2, 'rgba(140,160,255,0.35)');
    ctx.setLineDash([2, 10]);
    line(1, 'rgba(255,255,255,0.12)');
    ctx.setLineDash([]);
    // start / finish line
    const [ax, ay] = this.#screen(0, -24);
    const [bx, by] = this.#screen(0, 24);
    for (let k = 0; k < 8; k++) {
      ctx.fillStyle = k % 2 ? '#ffffff' : '#111';
      const x = ax + ((bx - ax) * k) / 8;
      const y = ay + ((by - ay) * k) / 8;
      ctx.fillRect(x - 3, y - 3, 6, 6);
    }
    // boost pads
    for (const pad of PADS) {
      const f = pad / LAP;
      for (let k = 0; k < 3; k++) {
        const [x, y] = this.#screen(f + k * 0.006);
        const [x2, y2] = this.#screen(f + k * 0.006 + 0.003);
        const a = Math.atan2(y2 - y, x2 - x);
        const glow = 0.4 + 0.6 * ((Math.sin(now / 160 - k) + 1) / 2);
        ctx.save(); ctx.translate(x, y); ctx.rotate(a);
        ctx.strokeStyle = `rgba(62,230,255,${glow})`; ctx.lineWidth = 2.5; ctx.shadowColor = '#3ee6ff'; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.moveTo(-5, -12); ctx.lineTo(4, 0); ctx.lineTo(-5, 12); ctx.stroke();
        ctx.restore();
      }
    }
    // gravity wells, just off the outside of the track
    for (const well of WELLS) {
      const [x, y] = this.#screen(well / LAP, -48);
      const g = ctx.createRadialGradient(x, y, 2, x, y, 34);
      g.addColorStop(0, 'rgba(0,0,0,0.95)'); g.addColorStop(0.5, 'rgba(120,60,255,0.25)'); g.addColorStop(1, 'rgba(120,60,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 34, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(180,140,255,0.55)'; ctx.lineWidth = 1.2;
      for (let k = 0; k < 3; k++) {
        const r = 10 + k * 7;
        const s = now / (600 + k * 250) + k;
        ctx.beginPath(); ctx.arc(x, y, r, s, s + 2.2); ctx.stroke();
      }
    }
  }

  #parked(view, now) {
    const { ctx } = this;
    this.cfg.comets.forEach((c, i) => {
      const [x, y] = this.#screen(-0.012 - (i % 2) * 0.004, this.#lane(i, now));
      this.#head(x, y, c.color, 5 + Math.sin(now / 300 + i), i === view.highlight);
      ctx.fillStyle = 'rgba(233,236,248,0.75)'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
      if (i === view.highlight) ctx.fillText(c.name, x - 12, y + 4);
    });
  }

  #comets(view, now) {
    const { ctx } = this;
    const race = view.race;
    // effects for events up to this tick
    for (; this.seenEvents < race.events.length; this.seenEvents++) this.#event(race, race.events[this.seenEvents], now);
    const order = [...race.comets].sort((a, b) => b.pos - a.pos);
    for (const c of race.comets) {
      const def = this.cfg.comets[c.i];
      const f = (c.pos % LAP) / LAP;
      const [x, y] = this.#screen(f, this.#lane(c.i, now));
      const trail = this.trails[c.i];
      trail.push([x, y]);
      const max = c.boost > 0 ? 46 : 28;
      while (trail.length > max) trail.shift();
      // tail
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 1; k < trail.length; k++) {
        const a = k / trail.length;
        ctx.strokeStyle = c.boost > 0 ? `rgba(255,240,200,${a * 0.5})` : `${def.color}${Math.round(a * 140).toString(16).padStart(2, '0')}`;
        ctx.lineWidth = 1 + a * (c.boost > 0 ? 7 : 5);
        ctx.beginPath(); ctx.moveTo(trail[k - 1][0], trail[k - 1][1]); ctx.lineTo(trail[k][0], trail[k][1]); ctx.stroke();
      }
      if (c.boost > 0 && Math.random() < 0.7) this.#spark(x, y, '#ffe9a8', 1.5);
      ctx.globalCompositeOperation = 'source-over';
      this.#head(x, y, def.color, c.boost > 0 ? 8 : 6, c.i === view.highlight);
      if (c.stun > 0) this.#zap(x, y);
      const place = order.indexOf(c) + 1;
      ctx.font = c.i === view.highlight ? 'bold 12px system-ui' : '11px system-ui';
      ctx.textAlign = 'left';
      ctx.fillStyle = c.i === view.highlight ? '#fff' : 'rgba(233,236,248,0.7)';
      ctx.fillText(`${place} ${def.name}`, x + 10, y - 8);
    }
  }

  #head(x, y, color, r, mine) {
    const { ctx } = this;
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
    g.addColorStop(0, `${color}cc`); g.addColorStop(1, `${color}00`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, TAU); ctx.fill();
    if (mine) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  #zap(x, y) {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(140,200,255,0.9)'; ctx.lineWidth = 1.2;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath(); ctx.moveTo(x, y);
      let px = x; let py = y;
      for (let s = 0; s < 4; s++) { px += (Math.random() - 0.5) * 14; py += (Math.random() - 0.5) * 14; ctx.lineTo(px, py); }
      ctx.stroke();
    }
  }

  #event(race, e, now) {
    const c = race.comets[e.comet];
    const def = this.cfg.comets[e.comet];
    const [x, y] = this.#screen((c.pos % LAP) / LAP, this.#lane(e.comet, now));
    if (e.kind === 'boost') for (let k = 0; k < 12; k++) this.#spark(x, y, '#9ff4ff', 3);
    else if (e.kind === 'sling') { this.rings.push({ x, y, color: '#c9a8ff', t: now, grow: 40 }); for (let k = 0; k < 16; k++) this.#spark(x, y, '#c9a8ff', 3.5); }
    else if (e.kind === 'snare') this.rings.push({ x, y, color: '#6a4bff', t: now, grow: -26 });
    else if (e.kind === 'flare') this.beams.push({ x, y, t: now });
    else if (e.kind === 'finish') {
      const first = race.order[0] === e.comet;
      for (let k = 0; k < (first ? 90 : 20); k++) this.#spark(x, y, k % 3 ? def.color : '#fff', first ? 6 : 3);
      if (first) this.rings.push({ x, y, color: def.color, t: now, grow: 120 });
    }
  }

  #spark(x, y, color, speed) {
    const a = Math.random() * TAU;
    const v = Math.random() * speed;
    this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color });
  }

  #effects(now) {
    const { ctx } = this;
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.sparks) {
      s.x += s.vx; s.y += s.vy; s.vx *= 0.96; s.vy *= 0.96; s.life -= 0.02;
      ctx.fillStyle = s.color; ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillRect(s.x - 1, s.y - 1, 2.2, 2.2);
    }
    ctx.globalAlpha = 1;
    this.sparks = this.sparks.filter((s) => s.life > 0);
    for (const r of this.rings) {
      const k = (now - r.t) / 700;
      if (k > 1) continue;
      ctx.strokeStyle = r.color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(1, (r.grow > 0 ? 6 : 30) + r.grow * k), 0, TAU); ctx.stroke();
    }
    this.rings = this.rings.filter((r) => now - r.t < 700);
    const [cx, cy] = this.center;
    for (const b of this.beams) {
      const k = (now - b.t) / 600;
      if (k > 1) continue;
      ctx.globalAlpha = 1 - k; ctx.strokeStyle = '#ffb35c'; ctx.lineWidth = 6 * (1 - k);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    this.beams = this.beams.filter((b) => now - b.t < 600);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
