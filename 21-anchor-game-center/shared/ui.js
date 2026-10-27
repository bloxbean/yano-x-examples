// Small UI pieces every page shares: escaping, toasts, the reachability
// banner, and the proof panel that renders a list of checks.

import { CENTER } from './config.js';

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export const txLink = (tx) => (CENTER.explorerTx
  ? `<a class="tx" target="_blank" rel="noopener" href="${CENTER.explorerTx.replace('{tx}', tx)}">${tx.slice(0, 16)}…</a>`
  : `<span class="tx mono">${tx.slice(0, 16)}…</span>`);

let toastEl;
let toastTimer;
export function toast(text, kind = '') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = `toast ${kind}`; }, 3500);
}

export function reportReachability(banner, error) {
  const cors = error instanceof TypeError || /no member reachable/.test(error.message);
  banner.innerHTML = cors
    ? `Can't reach the Yano X members from <code>${esc(location.origin)}</code>. Browsers only allow it if the
       members list this origin for CORS. To play locally, run <code>node serve.mjs</code> and open
       <code>http://localhost:8787/?proxy=1</code>.`
    : `Ledger error: ${esc(error.message)}`;
  banner.hidden = false;
}

/** A modal panel with a title, some facts, buttons, and the outcome of a proof. */
export class ProofPanel {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'overlay';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="panel proof-panel">
      <div class="proof-head"><h2></h2><button class="btn" aria-label="Close">✕</button></div>
      <div class="proof-body"></div></div>`;
    document.body.append(this.el);
    this.el.querySelector('button').onclick = () => this.close();
    this.el.addEventListener('click', (event) => { if (event.target === this.el) this.close(); });
    addEventListener('keydown', (event) => { if (event.key === 'Escape') this.close(); });
  }

  /** Show `bodyHtml`; it may contain an element with class "proof-out" for results. */
  open(title, bodyHtml) {
    this.el.querySelector('h2').textContent = title;
    this.el.querySelector('.proof-body').innerHTML = bodyHtml;
    this.el.hidden = false;
    return this.el.querySelector('.proof-body');
  }

  close() { this.el.hidden = true; }

  /** Run `prove()` and render its { checks, sealed, anchor, pending, trust } into .proof-out. */
  async run(prove, what) {
    const out = this.el.querySelector('.proof-out');
    out.innerHTML = '<ul class="checks"><li><span>…</span><span>Asking a member for a typed proof…</span></li></ul>';
    try {
      const r = await prove();
      const all = r.checks.every((c) => c.ok);
      out.innerHTML = `<ul class="checks">${r.checks.map((c, i) => `<li style="animation-delay:${i * 90}ms">
          <span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span>
          <span>${esc(c.text).replace(/tx [0-9a-f]{16}…/, c.tx ? `tx ${txLink(c.tx)}` : '$&')}</span></li>`).join('')}</ul>
        ${r.sealed && all ? `<div class="sealed">⚓ ${esc(what)} is part of the state anchored on Cardano in ${txLink(r.anchor.transactionHash)}.</div>`
          : r.pending ? `<div class="sealed wait">Not sealed yet: ${esc(r.pending)}. Proven against the latest finalized root instead; try again after the next seal.</div>` : ''}
        <p class="small">The member checked the Merkle proof (trust <code>${esc(r.trust ?? 'n/a')}</code>); this page
          checked the rest. Example 09 verifies the proof and the anchor datum with nothing but Cardano.</p>`;
      return r;
    } catch (error) {
      out.innerHTML = `<ul class="checks"><li><span class="no">✗</span><span>${esc(error.message)}</span></li></ul>`;
      return null;
    }
  }
}
