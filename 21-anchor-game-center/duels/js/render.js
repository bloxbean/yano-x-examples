// The duel arena: two rockets, their bars, and the effects of each settled
// round. Drawing only — it reads the Duel and never changes it.

import { rocket } from '../../arcade/js/render.js';

export class Arena {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.fx = [];
    this.stars = Array.from({ length: 200 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() }));
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
  }

  pos(seat) { return seat === 0 ? [this.w * 0.24, this.h * 0.55] : [this.w * 0.76, this.h * 0.55]; }

  /** Animate a settled round: both moves, then the damage. */
  play(round) {
    const now = performance.now();
    round.moves.forEach((m, seat) => { if (m) this.fx.push({ seat, kind: m, t0: now }); });
    round.dealt.forEach((d, seat) => { if (d) this.fx.push({ seat: 1 - seat, kind: 'hit', n: d, t0: now + 900 }); });
    round.forfeited.forEach((f, seat) => { if (f) this.fx.push({ seat, kind: 'forfeit', t0: now }); });
  }

  /** `view`: { names, colors, hp, energy, sealed: [bool, bool], revealed, done, winner }. */
  frame(view) {
    const { ctx, w, h, cfg } = this;
    const now = performance.now();
    ctx.fillStyle = '#06050f';
    ctx.fillRect(0, 0, w, h);
    for (const s of this.stars) {
      ctx.fillStyle = `rgba(200,200,255,${0.2 + s.z * 0.6})`;
      ctx.fillRect(s.x * w, s.y * h, s.z * 1.7, s.z * 1.7);
    }
    const glow = ctx.createRadialGradient(w / 2, h * 0.55, 10, w / 2, h * 0.55, w * 0.5);
    glow.addColorStop(0, 'rgba(120,80,255,0.12)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    if (!view) return;
    const k = Math.max(1.6, Math.min(w, h) / 170);
    const u = k / 1.6;
    for (const seat of [0, 1]) {
      const [x, y0] = this.pos(seat);
      const y = y0 + Math.sin(now / 600 + seat * 2) * 6;
      const alive = view.hp[seat] > 0;
      rocket(ctx, x, y, seat === 0 ? 0 : 128, k, view.colors[seat], alive ? 1 : 0.25, alive, now);
      ctx.fillStyle = view.colors[seat];
      ctx.font = '700 13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(view.names[seat], x, y - 46 * u);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x - 60, y + 40 * u, 120, 7);
      ctx.fillStyle = '#ff6b8a';
      ctx.fillRect(x - 60, y + 40 * u, (120 * view.hp[seat]) / cfg.hp, 7);
      for (let i = 0; i < cfg.energy.max; i++) {
        ctx.fillStyle = i < view.energy[seat] ? '#ffcc4d' : 'rgba(255,255,255,0.1)';
        ctx.fillRect(x - 60 + i * (120 / cfg.energy.max), y + 52 * u, 120 / cfg.energy.max - 4, 5);
      }
      ctx.fillStyle = 'rgba(220,220,255,0.6)';
      ctx.font = '11px system-ui';
      ctx.fillText(`HP ${view.hp[seat]} · energy ${view.energy[seat]}`, x, y + 70 * u);
      if (view.sealed[seat] && !view.done) {
        ctx.font = '18px system-ui';
        ctx.fillText(view.revealed[seat] ? '🔓' : '🔒', x + 52 * u, y - 40 * u);
      }
    }
    this.#effects(now);
  }

  #effects(now) {
    const { ctx } = this;
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      const t = (now - f.t0) / 1000;
      if (t < 0) continue;
      const [x, y] = this.pos(f.seat);
      const [tx, ty] = this.pos(1 - f.seat);
      const move = this.cfg.moves.find((m) => m.id === f.kind);
      const c = f.kind === 'hit' ? '#ff6b8a' : f.kind === 'forfeit' ? '#8a93b4' : move.color;
      if (f.kind === 'laser' && t < 0.6) {
        ctx.strokeStyle = c; ctx.lineWidth = 4 * (1 - t / 0.6); ctx.shadowColor = c; ctx.shadowBlur = 20;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.shadowBlur = 0;
      } else if (f.kind === 'missile' && t < 0.9) {
        const k = t / 0.9;
        rocket(ctx, x + (tx - x) * k, y + (ty - y) * k - Math.sin(k * Math.PI) * 60, f.seat === 0 ? 0 : 128, 0.9, c, 1, true, now);
      } else if (f.kind === 'shield' && t < 2.2) {
        ctx.strokeStyle = c; ctx.globalAlpha = 1 - t / 2.2; ctx.lineWidth = 3;
        ctx.beginPath();
        for (let a = 0; a < 6; a++) {
          const ang = (Math.PI / 3) * a;
          ctx[a ? 'lineTo' : 'moveTo'](x + Math.cos(ang) * 60, y + Math.sin(ang) * 60);
        }
        ctx.closePath(); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (f.kind === 'emp' && t < 1) {
        ctx.strokeStyle = c; ctx.globalAlpha = 1 - t; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, 20 + t * Math.abs(tx - x), 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (f.kind === 'recharge' && t < 1.2) {
        for (let j = 0; j < 12; j++) {
          const a = (j / 12) * Math.PI * 2 + t * 3;
          const r = 70 * (1 - t / 1.2);
          ctx.fillStyle = c; ctx.fillRect(x + Math.cos(a) * r, y + Math.sin(a) * r, 3, 3);
        }
      } else if (f.kind === 'forfeit' && t < 1.6) {
        ctx.fillStyle = c; ctx.globalAlpha = 1 - t / 1.6; ctx.font = '700 15px system-ui'; ctx.textAlign = 'center';
        ctx.fillText('missed the deadline', x, y - 90); ctx.globalAlpha = 1;
      } else if (f.kind === 'hit' && t < 1.2) {
        ctx.fillStyle = c; ctx.globalAlpha = 1 - t / 1.2; ctx.font = '800 26px ui-monospace, monospace'; ctx.textAlign = 'center';
        ctx.fillText(`−${f.n}`, x, y - 70 - t * 30); ctx.globalAlpha = 1;
        for (let j = 0; j < 16; j++) {
          const a = (j / 16) * Math.PI * 2;
          ctx.fillStyle = c; ctx.fillRect(x + Math.cos(a) * t * 90, y + Math.sin(a) * t * 90, 3, 3);
        }
      } else if (t >= 0) {
        this.fx.splice(i, 1);
      }
    }
  }
}
