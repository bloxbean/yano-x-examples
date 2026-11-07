// Drawing the reef: the world's cells as a glowing bioluminescent layer over a
// moving ocean, placement ripples, a ghost of the pattern you are about to
// drop, and the population chart. Decoration only — it reads the world and
// never changes it.

import { shape } from './reef.js';

const TAU = Math.PI * 2;

export class Renderer {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.ctx = canvas.getContext('2d');
    this.cellsCanvas = document.createElement('canvas');
    this.cellsCanvas.width = cfg.width;
    this.cellsCanvas.height = cfg.height;
    this.cellsCtx = this.cellsCanvas.getContext('2d');
    this.image = this.cellsCtx.createImageData(cfg.width, cfg.height);
    this.palette = cfg.species.map((s) => s?.color ?? [0, 0, 0]);
    this.ripples = [];
    this.plankton = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), v: 0.2 + Math.random(), p: Math.random() * TAU }));
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
    this.cell = Math.min((w - 24) / this.cfg.width, (h - 24) / this.cfg.height);
    this.origin = [(w - this.cell * this.cfg.width) / 2, (h - this.cell * this.cfg.height) / 2];
  }

  /** The world cell under a client point, or null. */
  cellAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - this.origin[0]) / this.cell);
    const y = Math.floor((clientY - rect.top - this.origin[1]) / this.cell);
    return x >= 0 && y >= 0 && x < this.cfg.width && y < this.cfg.height ? [x, y] : null;
  }

  ripple(x, y, species, kind = 'land') {
    this.ripples.push({ x, y, species, kind, t: performance.now() });
  }

  /**
   * view: { cells, now, hover: { pattern, rot, x, y, species } | null, pending: [{ x, y, species }], past }
   */
  frame(view) {
    const { ctx, cfg } = this;
    const [w, h] = this.size;
    if (!w) return;
    const now = view.now;
    const [ox, oy] = this.origin;
    const cw = this.cell * cfg.width;
    const ch = this.cell * cfg.height;

    // the ocean
    const sea = ctx.createLinearGradient(0, 0, 0, h);
    sea.addColorStop(0, view.past ? '#0b0a1c' : '#03142a');
    sea.addColorStop(1, '#010409');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 5; k++) { // drifting caustic light
      const x = w * (0.5 + 0.45 * Math.sin(now / (7000 + k * 1900) + k * 2));
      const y = h * (0.5 + 0.4 * Math.cos(now / (9000 + k * 1300) + k));
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * 0.35);
      g.addColorStop(0, view.past ? 'rgba(120,90,200,0.06)' : 'rgba(40,140,200,0.07)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    for (const p of this.plankton) {
      const x = ((p.x * w + now * 0.004 * p.v) % w);
      const y = p.y * h + Math.sin(now / 1500 + p.p) * 8;
      ctx.fillStyle = `rgba(150,220,255,${0.08 + 0.1 * Math.sin(now / 900 + p.p) ** 2})`;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.globalCompositeOperation = 'source-over';

    // the reef's frame
    ctx.strokeStyle = 'rgba(120,180,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 0.5, oy - 0.5, cw + 1, ch + 1);

    if (view.cells) {
      const data = this.image.data;
      const cells = view.cells;
      for (let i = 0; i < cells.length; i++) {
        const s = cells[i];
        const o = i * 4;
        if (s) {
          const [r, g, b] = this.palette[s];
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        } else {
          data[o + 3] = 0;
        }
      }
      this.cellsCtx.putImageData(this.image, 0, 0);
      // glow, then crisp cells
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.imageSmoothingEnabled = true;
      ctx.filter = `blur(${Math.max(3, this.cell * 1.4)}px)`;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.cellsCanvas, ox, oy, cw, ch);
      ctx.filter = 'none';
      ctx.restore();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.92;
      ctx.drawImage(this.cellsCanvas, ox, oy, cw, ch);
      ctx.globalAlpha = 1;
      if (this.cell >= 6) { // a faint lattice between cells
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        for (let x = 1; x < cfg.width; x++) { ctx.moveTo(ox + x * this.cell, oy); ctx.lineTo(ox + x * this.cell, oy + ch); }
        for (let y = 1; y < cfg.height; y++) { ctx.moveTo(ox, oy + y * this.cell); ctx.lineTo(ox + cw, oy + y * this.cell); }
        ctx.stroke();
      }
    }

    // pending placements pulse until final
    for (const p of view.pending ?? []) {
      const [r, g, b] = this.palette[p.species] ?? [255, 255, 255];
      const k = (now / 600) % 1;
      ctx.strokeStyle = `rgba(${r},${g},${b},${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ox + (p.x + 1.5) * this.cell, oy + (p.y + 1.5) * this.cell, this.cell * (2 + k * 5), 0, TAU);
      ctx.stroke();
    }

    // ripples where placements landed
    for (const rp of this.ripples) {
      const k = (now - rp.t) / 1400;
      if (k > 1) continue;
      const [r, g, b] = this.palette[rp.species] ?? [255, 255, 255];
      for (let j = 0; j < 3; j++) {
        const kk = k - j * 0.12;
        if (kk < 0) continue;
        ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - kk) * 0.8})`;
        ctx.lineWidth = 2 * (1 - kk);
        ctx.beginPath();
        ctx.arc(ox + (rp.x + 1.5) * this.cell, oy + (rp.y + 1.5) * this.cell, this.cell * (2 + kk * 14), 0, TAU);
        ctx.stroke();
      }
    }
    this.ripples = this.ripples.filter((rp) => now - rp.t < 1400);

    // the ghost of the pattern you are about to drop
    const hv = view.hover;
    if (hv) {
      const [r, g, b] = this.palette[hv.species] ?? [233, 236, 248];
      ctx.fillStyle = `rgba(${r},${g},${b},${0.45 + 0.25 * Math.sin(now / 200)})`;
      for (const [dx, dy] of shape(hv.pattern, hv.rot)) {
        const x = (hv.x + dx) % cfg.width;
        const y = (hv.y + dy) % cfg.height;
        ctx.fillRect(ox + x * this.cell + 0.5, oy + y * this.cell + 0.5, this.cell - 1, this.cell - 1);
      }
    }
  }
}

/** The population chart: one line per species over generations, a cursor at the viewed generation. */
export function drawChart(canvas, cfg, populations, lastGen, cursor) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(5,10,24,0.8)';
  ctx.fillRect(0, 0, w, h);
  const total = Math.max(1, lastGen);
  let max = 50;
  const stride = Math.max(1, Math.floor(populations.length / w));
  for (let g = 0; g < populations.length; g += stride) for (let s = 1; s < 7; s++) max = Math.max(max, populations[g][s]);
  for (let s = 1; s < 8; s++) {
    const [r, gg, b] = cfg.species[s].color;
    ctx.strokeStyle = s === 7 ? 'rgba(140,160,190,0.35)' : `rgba(${r},${gg},${b},0.95)`;
    ctx.lineWidth = s === 7 ? 1 : 1.6;
    ctx.beginPath();
    let started = false;
    for (let g = 0; g < populations.length; g += stride) {
      const v = populations[g][s];
      if (!v && !started) continue;
      const x = (g / total) * w;
      const y = Math.max(2, h - 3 - (v / max) * (h - 8)); // the wild soup may run off the top
      ctx[started ? 'lineTo' : 'moveTo'](x, y);
      started = true;
    }
    ctx.stroke();
  }
  if (cursor !== null) {
    const x = (cursor / total) * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.setLineDash([]);
  }
}
