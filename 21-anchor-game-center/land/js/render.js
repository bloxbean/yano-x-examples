// Drawing only: the hex map, owners, flags and the claim animations. It reads
// the Land fold and never changes it.

const OTHERS = ['#ff4fd8', '#ffb020', '#c9a7ff', '#7dff6a', '#ff6b6b', '#5ab0ff', '#f9f871', '#ff9f80'];

/** You are always cyan; everyone else keeps a colour derived from their call sign. */
export function ownerColor(id, me) {
  if (id === me) return '#3ee6ff';
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return OTHERS[h % OTHERS.length];
}

export class Renderer {
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.plants = new Map(); // "c,r" → animation start
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
    const { cols, rows } = this.cfg;
    const s3 = Math.sqrt(3);
    this.size = Math.min(this.w / (cols * s3 + s3 / 2 + 0.5), this.h / (rows * 1.5 + 0.6));
    this.ox = (this.w - (cols * s3 + s3 / 2) * this.size) / 2 + (s3 / 2) * this.size;
    this.oy = (this.h - (rows * 1.5 + 0.5) * this.size) / 2 + this.size;
  }

  center(c, r) {
    return [this.ox + Math.sqrt(3) * this.size * (c + (r % 2) * 0.5), this.oy + this.size * 1.5 * r];
  }

  /** The tile under a canvas point, or null. */
  tileAt(x, y) {
    let best = null;
    let bd = Infinity;
    for (let r = 0; r < this.cfg.rows; r++) {
      for (let c = 0; c < this.cfg.cols; c++) {
        const [cx, cy] = this.center(c, r);
        const d = (cx - x) ** 2 + (cy - y) ** 2;
        if (d < bd) { bd = d; best = [c, r]; }
      }
    }
    return bd < this.size * this.size ? best : null;
  }

  plant(c, r) { this.plants.set(`${c},${r}`, performance.now()); }

  #hex(x, y, s) {
    const { ctx } = this;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const px = x + s * Math.cos(a);
      const py = y + s * Math.sin(a);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  /**
   * Draw a frame. `land` is the fold (may have no map yet); `ui` carries me,
   * mode, hover, pending claims ("c,r" → owner id) and the seal glow.
   */
  frame(land, ui) {
    const { ctx, cfg } = this;
    const now = performance.now();
    const s = this.size;
    ctx.fillStyle = '#050810';
    ctx.fillRect(0, 0, this.w, this.h);
    if (!land?.map) {
      ctx.fillStyle = 'rgba(160,170,200,0.7)';
      ctx.font = '15px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('This season’s land appears when its first block is finalized.', this.w / 2, this.h / 2);
      return;
    }
    for (const t of land.map) {
      const [x, y] = this.center(t.c, t.r);
      const key = `${t.c},${t.r}`;
      const tile = land.tiles.get(key);
      this.#hex(x, y, s * 0.96);
      ctx.fillStyle = tile?.scorched ? '#1d1414' : cfg.terrain[t.terrain].color;
      ctx.fill();
      if (t.terrain === 3 && !tile) {
        ctx.fillStyle = `rgba(160,240,255,${0.12 + 0.12 * Math.sin(now / 420 + t.c + t.r)})`;
        ctx.fill();
      }
      if (tile?.owner) {
        const color = ownerColor(tile.owner, ui.me);
        ctx.fillStyle = `${color}66`;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (ui.mode === 'claim' && ui.me && !tile && !ui.pending.has(key) && land.claimable(ui.me, t.c, t.r)
          && land.players.has(ui.me)) {
        ctx.strokeStyle = `rgba(125,255,106,${0.45 + 0.4 * Math.sin(now / 250)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(5,8,16,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (tile?.scorched) {
        ctx.strokeStyle = 'rgba(255,107,138,0.4)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x - s * 0.4, y - s * 0.4); ctx.lineTo(x + s * 0.4, y + s * 0.4); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + s * 0.4, y - s * 0.4); ctx.lineTo(x - s * 0.4, y + s * 0.4); ctx.stroke();
      }
      if (tile?.owner && land.players.get(tile.owner)?.capital === key) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(s * 0.85)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('♜', x, y + 1);
      }
      const started = this.plants.get(key);
      if (tile?.owner && started !== undefined) {
        const k = Math.min(1, (now - started) / 900);
        const color = ownerColor(tile.owner, ui.me);
        const pole = s * 0.45 * (0.3 + 0.7 * k);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y + s * 0.4); ctx.lineTo(x, y - pole); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(x, y - pole); ctx.lineTo(x + s * 0.45, y - pole + s * 0.15); ctx.lineTo(x, y - pole + s * 0.3); ctx.fill();
        this.#hex(x, y, s * (1 + (1 - k) * 0.9));
        ctx.strokeStyle = `${color}${Math.round((1 - k) * 220).toString(16).padStart(2, '0')}`;
        ctx.lineWidth = 2;
        ctx.stroke();
        if (k >= 1 && now - started > 2500) this.plants.delete(key);
      }
      if (ui.pending.has(key)) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(now / 180);
        ctx.strokeStyle = ownerColor(ui.pending.get(key), ui.me); ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        this.#hex(0, 0, s * 0.7); ctx.stroke();
        ctx.restore(); ctx.setLineDash([]);
      }
      if (ui.sealGlow > 0 && tile?.owner) {
        this.#hex(x, y, s * 0.96);
        ctx.strokeStyle = `rgba(255,204,77,${ui.sealGlow})`; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    if (ui.hover) {
      const [c, r] = ui.hover;
      const t = land.map[r * cfg.cols + c];
      const tile = land.tiles.get(`${c},${r}`);
      const [x, y] = this.center(c, r);
      this.#hex(x, y, s * 0.96);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      const status = tile?.owner ? tile.owner : tile?.scorched ? 'scorched' : 'free';
      const label = `${t.name} · ${cfg.terrain[t.terrain].name} ${cfg.terrain[t.terrain].value} · ${status}`;
      ctx.font = '12px system-ui';
      const w = ctx.measureText(label).width + 16;
      const ly = Math.max(14, y - s * 1.9);
      ctx.fillStyle = 'rgba(5,8,16,0.88)';
      ctx.fillRect(x - w / 2, ly, w, 22);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x, ly + 11);
    }
  }
}
