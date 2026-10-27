// One commander for every game: the signed-in session and the sign-in panel.
//
// Creating a commander claims the call sign on the authenticated-map chain
// (PUT_IF_ABSENT) with a password-locked signing key; signing in fetches that
// profile and unlocks the key in the browser. The unlocked key is remembered
// in localStorage, which every page of the center shares (same origin), so
// signing in once is enough for all games.

import { ACCOUNTS } from './config.js';
import { CALLSIGN, createCommander, forgetDevice, rememberOnDevice, restoreFromDevice, unlockCommander }
  from './accounts.js';
import { Profiles } from './profiles.js';
import { esc } from './ui.js';

const STEPS = {
  create: [
    ['Generate your commander key', 'Ed25519, in this browser'],
    ['Lock it with your password', `PBKDF2 · ${ACCOUNTS.kdfIterations.toLocaleString()} rounds → AES-GCM`],
    ['Claim your call sign on the ledger', `${ACCOUNTS.profilesChain} · PUT_IF_ABSENT`],
    ['Ready for every game', 'one commander, all games in the center'],
  ],
  signin: [
    ['Fetch your profile', `${ACCOUNTS.profilesChain} · ${ACCOUNTS.profilesCollection}`],
    ['Unlock your key with your password', 'PBKDF2 → AES-GCM, in this browser'],
    ['Check it is the profile’s key', 'sign and verify locally'],
    ['Ready for every game', 'remembered on this device until you sign out'],
  ],
};

export class Session {
  constructor(ledger) {
    this.ledger = ledger;
    this.profiles = new Profiles(ACCOUNTS, ledger);
    this.commander = null;
    this.profileHeight = null;
    this.relay = 0; // which member relays writes; it signs the envelope
    this.listeners = [];
    this.overlay = null;
  }

  onChange(fn) { this.listeners.push(fn); }
  #emit() { for (const fn of this.listeners) fn(this.commander); }

  async restore() {
    this.commander = await restoreFromDevice(ACCOUNTS);
    this.#emit();
    if (this.commander) {
      this.profiles.lookup(this.commander.id).then((found) => {
        if (found.present) { this.profileHeight = found.createdHeight; this.#emit(); }
      }).catch(() => {});
    }
    return this.commander;
  }

  signOut() {
    forgetDevice(ACCOUNTS);
    this.commander = null;
    this.profileHeight = null;
    this.#emit();
  }

  /** Open the sign-in panel ('create' or 'signin'). */
  open(mode = 'create') {
    if (!this.overlay) this.#mount();
    this.#setMode(mode);
    this.overlay.hidden = false;
    this.overlay.querySelector('#auth-callsign').focus();
  }

  close() { if (this.overlay) this.overlay.hidden = true; }

  #mount() {
    const el = document.createElement('div');
    el.className = 'overlay';
    el.hidden = true;
    el.innerHTML = `<div class="auth">
      <section>
        <div class="tabs" role="tablist">
          <button class="tab on" data-mode="create" role="tab">New commander</button>
          <button class="tab" data-mode="signin" role="tab">I have an account</button>
        </div>
        <h2 id="auth-title"></h2>
        <div class="small" id="auth-sub"></div>
        <form id="auth-form" autocomplete="on">
          <label>Call sign<input id="auth-callsign" autocomplete="username" spellcheck="false" maxlength="20" placeholder="nova"></label>
          <label>Password<input id="auth-password" type="password" placeholder="at least ${ACCOUNTS.minPasswordLength} characters"></label>
          <div class="strength"><span id="auth-strength"></span></div>
          <div class="error" id="auth-error"></div>
          <div class="row"><button class="btn primary" id="auth-go" type="submit"></button>
            <button class="btn" id="auth-later" type="button">Just watch</button></div>
        </form>
        <div class="note">Your password never leaves this browser. It locks a fresh signing key; only the
          locked key and its public half are stored on the ledger, so you can sign in on any device.</div>
      </section>
      <section>
        <h2>What happens</h2>
        <ol class="steps" id="auth-steps"></ol>
        <div class="note">Call signs are first come, first served — the ledger itself refuses a taken one,
          and your profile can be proven against the Cardano anchor.</div>
      </section></div>`;
    document.body.append(el);
    this.overlay = el;
    el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => this.#setMode(t.dataset.mode)));
    el.querySelector('#auth-form').addEventListener('submit', (event) => this.#submit(event));
    el.querySelector('#auth-later').addEventListener('click', () => this.close());
    el.querySelector('#auth-password').addEventListener('input', (event) => {
      const p = event.target.value;
      const bar = el.querySelector('#auth-strength');
      bar.style.width = `${Math.round(Math.min(1, p.length / 16) * (/[^a-z]/i.test(p) || p.length >= 16 ? 1 : 0.7) * 100)}%`;
      bar.style.background = p.length < ACCOUNTS.minPasswordLength ? 'var(--bad)' : 'var(--good)';
    });
  }

  #setMode(mode) {
    this.mode = mode;
    const $ = (id) => this.overlay.querySelector(id);
    this.overlay.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === mode));
    $('#auth-title').textContent = mode === 'create' ? 'Create your commander' : 'Welcome back, commander';
    $('#auth-sub').textContent = mode === 'create' ? 'Pick a call sign and a password. That’s all.'
      : 'Your call sign and password unlock your key from the ledger.';
    $('#auth-go').textContent = mode === 'create' ? 'Create commander' : 'Sign in';
    $('#auth-password').autocomplete = mode === 'create' ? 'new-password' : 'current-password';
    $('#auth-error').textContent = '';
    this.#steps(-1);
  }

  #steps(running, detail = {}, failed = false) {
    this.overlay.querySelector('#auth-steps').innerHTML = STEPS[this.mode].map(([title, sub], i) => {
      const state = i < running ? 'done' : i === running ? (failed ? 'fail' : 'run') : '';
      return `<li class="${state}"><span class="ic">${i < running ? '✓' : failed && i === running ? '!' : i + 1}</span>
        <div>${title}<small>${esc(detail[i] ?? sub)}</small></div></li>`;
    }).join('');
  }

  async #submit(event) {
    event.preventDefault();
    const $ = (id) => this.overlay.querySelector(id);
    const id = $('#auth-callsign').value.trim().toLowerCase();
    const password = $('#auth-password').value;
    $('#auth-error').textContent = '';
    if (!CALLSIGN.test(id)) { $('#auth-error').textContent = 'Call signs are 3–20 characters: a–z, 0–9, _ or -'; return; }
    if (!password) { $('#auth-error').textContent = 'Enter your password'; return; }
    const buttons = this.overlay.querySelectorAll('form button');
    buttons.forEach((b) => { b.disabled = true; });
    const pause = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
    let at = 0;
    try {
      let commander;
      if (this.mode === 'create') {
        if (password.length < ACCOUNTS.minPasswordLength) {
          throw new Error(`Use at least ${ACCOUNTS.minPasswordLength} characters for your password`);
        }
        if ((await this.profiles.lookup(id)).present) throw new Error('That call sign is taken. Try another.');
        this.#steps(at = 0);
        await pause();
        this.#steps(at = 1);
        const created = await createCommander(ACCOUNTS, id, password);
        this.#steps(at = 2, { 2: 'finalizing…' });
        const done = await this.profiles.register(id, created.profileBytes, this.relay,
          () => this.#steps(2, { 2: 'submitted · waiting for the members to finalize…' }));
        this.#steps(at = 3, { 2: `finalized at height ${done.height} in ${(done.ms / 1000).toFixed(1)} s` });
        for (let i = 0; i < 40 && !(await this.profiles.lookup(id)).present; i++) await pause(250);
        commander = created.commander;
        this.profileHeight = done.height;
      } else {
        this.#steps(at = 0);
        const found = await this.profiles.lookup(id);
        if (!found.present) throw new Error('No commander with that call sign');
        if (!found.profile || found.revision !== 1) throw new Error('That profile is not valid');
        this.#steps(at = 1, { 0: `found at height ${found.createdHeight}` });
        commander = await unlockCommander(ACCOUNTS, found.profile, password);
        this.#steps(at = 3, { 0: `found at height ${found.createdHeight}`, 2: 'it matches' });
        this.profileHeight = found.createdHeight;
      }
      rememberOnDevice(ACCOUNTS, commander);
      this.commander = commander;
      await pause(400);
      $('#auth-password').value = '';
      this.close();
      this.#emit();
    } catch (error) {
      this.#steps(at, {}, true);
      $('#auth-error').textContent = error.message;
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }
}
