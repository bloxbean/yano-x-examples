// Drawing Deep Sonar: your sea (with your hulls) and the enemy's waters as a
// sonar screen, torpedoes, explosions and splashes. Decoration only — it reads
// what the battle proved and never changes it.

const TAU = Math.PI * 2;

/** Ship segments of a board: [{ ship, cells: [first, …], across }]. */
function hulls(board, size) {
  const out = [];
  if (!board) return out;
  const ids = [...new Set(board.filter(Boolean))];
  for (const ship of ids) {
    const cells = board.flatMap((v, i) => (v === ship ? [i] : []));
    out.push({ ship, cells, across: cells.length < 2 || cells[1] - cells[0] === 1, size });
  }
  return out;
}

export class Renderer {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.torpedoes = [];
    this.marks = [];
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
    const n = this.cfg.size;
    const pad = 22;
    const wide = w / h > 1.25;
    const cell = wide ? Math.min((w - pad * 3) / (2 * n), (h - pad * 2 - 34) / n)
      : Math.min((w - pad * 2) / n, (h - pad * 3 - 68) / (2 * n));
    const side = cell * n;
    this.boards = wide
      ? [{ x: (w - side * 2 - pad) / 2, y: (h - side) / 2 + 12 }, { x: (w - side * 2 - pad) / 2 + side + pad, y: (h - side) / 2 + 12 }]
      : [{ x: (w - side) / 2, y: pad + 24 }, { x: (w - side) / 2, y: pad * 2 + side + 48 }];
    this.cell = cell;
  }

  #center(board, cell) {
    const n = this.cfg.size;
    const b = this.boards[board];
    return [b.x + ((cell % n) + 0.5) * this.cell, b.y + (Math.floor(cell / n) + 0.5) * this.cell];
  }

  /** { board: 0 (yours) | 1 (enemy), cell } under a client point, or null. */
  cellAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const n = this.cfg.size;
    for (let board = 0; board < 2; board++) {
      const b = this.boards[board];
      const cx = Math.floor((x - b.x) / this.cell);
      const cy = Math.floor((y - b.y) / this.cell);
      if (cx >= 0 && cy >= 0 && cx < n && cy < n) return { board, cell: cy * n + cx };
    }
    return null;
  }

  /** A torpedo from one board towards a cell of the other. */
  fire(toBoard, cell) {
    const from = this.boards[1 - toBoard];
    const side = this.cell * this.cfg.size;
    this.torpedoes.push({ from: [from.x + side / 2, from.y + side / 2], to: this.#center(toBoard, cell), t: performance.now() });
  }

  /** The answer arrived: an explosion or a splash at that cell. */
  impact(board, cell, hit, sunk) {
    const [x, y] = this.#center(board, cell);
    const now = performance.now();
    this.marks.push({ x, y, t: now, hit, sunk });
    const count = hit ? (sunk ? 120 : 60) : 34;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * TAU;
      const v = Math.random() * (hit ? 4.5 : 2.6);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (hit ? 0.6 : 1.4), life: 1,
        color: hit ? (k % 3 ? '#ff8a3d' : '#ffe08a') : (k % 2 ? '#bfefff' : '#5ad6ff'), g: hit ? 0.02 : 0.08, size: hit ? 2.6 : 2 });
    }
  }

  /**
   * view: { now, mine, enemy: { known, sunk, board }, incoming: { known }, hover, canFire, aim, labels }
   *   mine            your board (ship ids) or null
   *   enemy.known     Map cell → ship id proven on the enemy board
   *   enemy.sunk      Set of enemy ship ids sunk
   *   enemy.board     the enemy board, once revealed
   *   incoming.known  Map cell → ship id proven on your board
   *   aim             a cell you fired at, awaiting its answer
   */
  frame(view) {
    const { ctx, cfg } = this;
    const [w, h] = this.size;
    if (!w) return;
    const now = view.now;
    const n = cfg.size;
    const side = this.cell * n;
    const bg = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#04162a'); bg.addColorStop(1, '#01050c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // ---- your sea
    const a = this.boards[0];
    for (let i = 0; i < n * n; i++) {
      const x = a.x + (i % n) * this.cell;
      const y = a.y + Math.floor(i / n) * this.cell;
      const s = 0.5 + 0.5 * Math.sin(now / 900 + (i % n) * 0.7 + Math.floor(i / n) * 0.5);
      ctx.fillStyle = `rgb(${8 + s * 10},${40 + s * 26},${70 + s * 40})`;
      ctx.fillRect(x + 0.5, y + 0.5, this.cell - 1, this.cell - 1);
    }
    for (const hull of hulls(view.mine, n)) this.#hull(0, hull, false, now);
    for (const [cell, ship] of view.incoming?.known ?? []) this.#marker(0, cell, ship, now);

    // ---- enemy waters: a sonar screen
    const b = this.boards[1];
    const cx = b.x + side / 2;
    const cy = b.y + side / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(b.x, b.y, side, side); ctx.clip();
    ctx.fillStyle = '#021a12';
    ctx.fillRect(b.x, b.y, side, side);
    ctx.strokeStyle = 'rgba(80,255,170,0.12)';
    ctx.lineWidth = 1;
    for (let r = side * 0.12; r < side * 0.75; r += side * 0.12) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke(); }
    const sweep = (now / 2600) * TAU;
    if (ctx.createConicGradient) {
      const g = ctx.createConicGradient(sweep - 1.2, cx, cy);
      g.addColorStop(0, 'rgba(80,255,170,0)');
      g.addColorStop(0.19, 'rgba(80,255,170,0.28)');
      g.addColorStop(0.191, 'rgba(80,255,170,0)');
      g.addColorStop(1, 'rgba(80,255,170,0)');
      ctx.fillStyle = g;
      ctx.fillRect(b.x, b.y, side, side);
    }
    ctx.strokeStyle = 'rgba(120,255,190,0.6)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sweep) * side, cy + Math.sin(sweep) * side); ctx.stroke();
    ctx.restore();
    if (view.enemy?.board) {
      for (const hull of hulls(view.enemy.board, n)) this.#hull(1, hull, true, now);
    } else {
      for (const ship of view.enemy?.sunk ?? []) {
        const cells = [...view.enemy.known].filter(([, s]) => s === ship).map(([c]) => c).sort((x, y) => x - y);
        this.#hull(1, { ship, cells, across: cells.length < 2 || cells[1] - cells[0] === 1 }, true, now);
      }
    }
    for (const [cell, ship] of view.enemy?.known ?? []) this.#marker(1, cell, ship, now, sweep, cx, cy);

    // grids and labels
    for (let board = 0; board < 2; board++) {
      const o = this.boards[board];
      ctx.strokeStyle = board ? 'rgba(80,255,170,0.22)' : 'rgba(150,200,255,0.18)';
      ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        ctx.moveTo(o.x + k * this.cell, o.y); ctx.lineTo(o.x + k * this.cell, o.y + side);
        ctx.moveTo(o.x, o.y + k * this.cell); ctx.lineTo(o.x + side, o.y + k * this.cell);
      }
      ctx.stroke();
      ctx.fillStyle = board ? '#66ffb4' : '#9fd8ff';
      ctx.font = '600 11px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(view.labels?.[board] ?? '', o.x, o.y - 8);
    }

    // aim and hover
    const reticle = (cell, color, pulse) => {
      const [x, y] = this.#center(1, cell);
      const r = this.cell * (0.42 + (pulse ? 0.08 * Math.sin(now / 120) : 0));
      ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - r * 1.4, y); ctx.lineTo(x - r * 0.5, y); ctx.moveTo(x + r * 0.5, y); ctx.lineTo(x + r * 1.4, y);
      ctx.moveTo(x, y - r * 1.4); ctx.lineTo(x, y - r * 0.5); ctx.moveTo(x, y + r * 0.5); ctx.lineTo(x, y + r * 1.4); ctx.stroke();
    };
    if (view.aim !== null && view.aim !== undefined) reticle(view.aim, '#ffd84d', true);
    if (view.canFire && view.hover !== null && view.hover !== undefined && !view.enemy?.known?.has(view.hover)) reticle(view.hover, '#ffffff', false);
    if (view.incomingAim !== null && view.incomingAim !== undefined) {
      const [x, y] = this.#center(0, view.incomingAim);
      ctx.strokeStyle = `rgba(255,107,138,${0.5 + 0.5 * Math.sin(now / 100)})`; ctx.lineWidth = 2;
      ctx.strokeRect(x - this.cell / 2 + 2, y - this.cell / 2 + 2, this.cell - 4, this.cell - 4);
    }

    // torpedoes
    for (const t of this.torpedoes) {
      const k = Math.min(1, (now - t.t) / 750);
      const x = t.from[0] + (t.to[0] - t.from[0]) * k;
      const y = t.from[1] + (t.to[1] - t.from[1]) * k - Math.sin(k * Math.PI) * 40;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x, y, 0, x, y, 14);
      g.addColorStop(0, 'rgba(255,240,180,0.95)'); g.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 14, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      if (Math.random() < 0.8) this.particles.push({ x, y, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, life: 0.7, color: '#cfe8ff', g: 0, size: 1.6 });
    }
    this.torpedoes = this.torpedoes.filter((t) => now - t.t < 750);

    // explosion rings
    for (const m of this.marks) {
      const k = (now - m.t) / 900;
      if (k > 1) continue;
      ctx.strokeStyle = m.hit ? `rgba(255,140,60,${1 - k})` : `rgba(160,230,255,${1 - k})`;
      ctx.lineWidth = 3 * (1 - k);
      ctx.beginPath(); ctx.arc(m.x, m.y, 4 + k * (m.sunk ? 90 : m.hit ? 46 : 26), 0, TAU); ctx.stroke();
    }
    this.marks = this.marks.filter((m) => now - m.t < 900);

    // particles
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= 0.97; p.life -= 0.018;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  #hull(board, hull, enemy, now) {
    const { ctx } = this;
    const n = this.cfg.size;
    const o = this.boards[board];
    const first = hull.cells[0];
    const last = hull.cells[hull.cells.length - 1];
    const x0 = o.x + (first % n) * this.cell;
    const y0 = o.y + Math.floor(first / n) * this.cell;
    const x1 = o.x + ((last % n) + 1) * this.cell;
    const y1 = o.y + (Math.floor(last / n) + 1) * this.cell;
    const inset = this.cell * 0.16;
    const x = x0 + inset;
    const y = y0 + inset;
    const ww = x1 - x0 - inset * 2;
    const hh = y1 - y0 - inset * 2;
    const g = hull.across ? ctx.createLinearGradient(0, y, 0, y + hh) : ctx.createLinearGradient(x, 0, x + ww, 0);
    if (enemy) { g.addColorStop(0, 'rgba(255,90,90,0.55)'); g.addColorStop(1, 'rgba(120,20,30,0.55)'); }
    else { g.addColorStop(0, '#9fb3c8'); g.addColorStop(0.5, '#5d7189'); g.addColorStop(1, '#2c3a4c'); }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x, y, ww, hh, Math.min(ww, hh) / 2);
    ctx.fill();
    ctx.strokeStyle = enemy ? `rgba(255,107,138,${0.6 + 0.4 * Math.sin(now / 300)})` : 'rgba(220,235,255,0.5)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (!enemy) { // a conning tower
      const tx = hull.across ? x + ww * 0.35 : x + ww / 2 - ww * 0.18;
      const ty = hull.across ? y + hh / 2 - hh * 0.18 : y + hh * 0.35;
      ctx.fillStyle = '#c5d4e4';
      ctx.fillRect(tx, ty, hull.across ? ww * 0.12 : ww * 0.36, hull.across ? hh * 0.36 : hh * 0.12);
    }
  }

  #marker(board, cell, ship, now, sweep, cx, cy) {
    const { ctx } = this;
    const [x, y] = this.#center(board, cell);
    const r = this.cell * 0.32;
    if (ship) {
      ctx.globalCompositeOperation = 'lighter';
      const flick = 0.75 + 0.25 * Math.sin(now / 70 + cell);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
      g.addColorStop(0, `rgba(255,200,90,${flick})`); g.addColorStop(0.5, `rgba(255,90,40,${0.6 * flick})`); g.addColorStop(1, 'rgba(255,60,30,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      if (Math.random() < 0.08) this.particles.push({ x, y, vx: (Math.random() - 0.5) * 0.3, vy: -0.5, life: 0.8, color: 'rgba(120,120,130,0.6)', g: 0, size: 3 });
    } else {
      let glow = 0.35;
      if (board === 1 && sweep !== undefined) { // misses flare as the sweep passes
        const ang = ((Math.atan2(y - cy, x - cx) - sweep) % TAU + TAU) % TAU;
        glow += ang > TAU - 0.6 ? 0.6 * (1 - (TAU - ang) / 0.6) : 0;
      }
      ctx.strokeStyle = board ? `rgba(120,255,190,${glow})` : `rgba(200,235,255,${glow + 0.2})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r * 0.25, 0, TAU); ctx.stroke();
    }
  }
}
