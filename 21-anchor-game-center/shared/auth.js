// One commander for every game: the signed-in session and the sign-in panel.
//
// Creating a commander claims the call sign on the authenticated-map chain
// (PUT_IF_ABSENT) with a password-locked signing key; signing in fetches that
// profile and unlocks the key in the browser. The unlocked key is remembered
// in IndexedDB as a non-extractable WebCrypto key, which every page of the
// center shares (same origin), so signing in once is enough for all games.
//
// Or a Cardano wallet instead of a password: the wallet certifies a device key
// made in this browser, once per browser (shared/wallet.js). A first-time
// wallet claims the call sign with that same signature.

import { ACCOUNTS } from './config.js';
import { CALLSIGN, Commander, createCommander, forgetAllDevices, forgetDevice, rememberOnDevice, restoreFromDevice,
  unlockCommander, walletProfileBytes } from './accounts.js';
import { Profiles } from './profiles.js';
import { forgetAllSessions, forgetSessions } from './sessions.js';
import { esc } from './ui.js';
import { DEVICE_MS, certifyDevice, connectWallet, detectWallets, shortAddress } from './wallet.js';

// A stand-in wallet for local tests: only on a loopback host, only with ?mockwallet.
if (typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    && new URLSearchParams(location.search).has('mockwallet')) {
  await import('../test/mock-wallet.js');
}

/** "key 3f2a…91" for a password commander, "wallet stake_test1uq…x9k2" for a wallet commander. */
export const keyLabel = (c) => (c.wallet ? `wallet ${shortAddress(c.address)}` : `key ${c.pub.slice(0, 6)}…${c.pub.slice(-4)}`);
const DAYS = Math.round(DEVICE_MS / 86400000);

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
  wallet: [
    ['Connect your wallet', 'CIP-30: the wallet asks you to allow this site'],
    ['Make this browser’s device key', 'Ed25519, non-extractable, in this browser'],
    ['Sign once with your wallet', `signData: this browser may play as you for ${DAYS} days. No transaction, no funds`],
    ['Claim your call sign, or check it is yours', `${ACCOUNTS.profilesChain} · PUT_IF_ABSENT`],
    ['Ready for every game', 'the device key signs from now on: no more wallet popups'],
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
    if (this.commander?.cert && this.commander.cert.until < Date.now() + 300_000) {
      // The wallet let this browser play for a while; that while is over. Ask it again.
      const { id } = this.commander;
      await this.signOut();
      this.open('wallet');
      this.overlay.querySelector('#auth-callsign').value = id;
      this.overlay.querySelector('#auth-error').textContent =
        `Your wallet’s permission for this browser to play as “${id}” has run out. Connect the wallet again.`;
      return null;
    }
    if (this.commander) {
      const { id, pub } = this.commander;
      this.profiles.lookup(id).then((found) => {
        if (this.commander?.pub !== pub) return; // signed out or in again meanwhile
        if (found.present && found.revision === 1 && found.profile?.pub === pub) {
          this.profileHeight = found.createdHeight;
          this.#emit();
          return;
        }
        // The key remembered here is not this ledger's commander for that call sign: it was
        // made against an earlier chain (a reset or rebuilt cluster). Nothing it signs would be
        // accepted, so forget it and ask for a sign-in instead of failing later, move by move.
        const wallet = found.present && found.profile?.v === 2;
        this.signOut();
        this.open(found.present ? (wallet ? 'wallet' : 'signin') : 'create');
        this.overlay.querySelector('#auth-callsign').value = id;
        this.overlay.querySelector('#auth-error').textContent = found.present
          ? `This browser remembered an older key for “${id}”. Sign in again with your ${wallet ? 'wallet' : 'password'}.`
          : `This browser remembered “${id}”, but this ledger has no such commander. Create one, or sign in.`;
      }).catch(() => {}); // unreachable for now: the delegation service checks again
    }
    return this.commander;
  }

  /** Forget this commander here: its key and every game's session key for it. Resolves once gone. */
  signOut() {
    const done = Promise.all([forgetDevice(ACCOUNTS), forgetSessions(this.commander?.id)]);
    this.commander = null;
    this.profileHeight = null;
    this.#emit();
    return done;
  }

  /**
   * Forget everything this browser keeps for the center, then reload: the remembered
   * commander, every session key, and each game's local secrets (a hidden Deep Sonar
   * fleet, a committed duel move). The ledger keeps your profile: sign in again with
   * your password. Everything here lives on this origin only, so clearing it is safe.
   */
  async clearBrowser() {
    await this.signOut();
    try { localStorage.clear(); } catch { /* nothing stored */ }
    await Promise.all([forgetAllDevices(), forgetAllSessions()]); // robots' keys too
    location.reload();
  }

  /** Make `button` clear this browser's data on a second click, with the cost spelled out. */
  bindClear(button) {
    const label = button.textContent;
    let armed = null;
    button.addEventListener('click', () => {
      if (armed) { clearTimeout(armed); button.disabled = true; this.clearBrowser(); return; }
      button.textContent = 'Click again to forget this browser’s sign-in, session keys and any hidden fleet or duel move in progress';
      armed = setTimeout(() => { armed = null; button.textContent = label; }, 6000);
    });
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
          <button class="tab" data-mode="wallet" role="tab">Cardano wallet</button>
        </div>
        <h2 id="auth-title"></h2>
        <div class="small" id="auth-sub"></div>
        <form id="auth-form" autocomplete="on">
          <label>Call sign<input id="auth-callsign" autocomplete="username" spellcheck="false" maxlength="20" placeholder="nova"></label>
          <label id="auth-password-row">Password<input id="auth-password" type="password" placeholder="at least ${ACCOUNTS.minPasswordLength} characters"></label>
          <div class="strength" id="auth-strength-row"><span id="auth-strength"></span></div>
          <div class="wallets" id="auth-wallets" hidden></div>
          <div class="error" id="auth-error"></div>
          <div class="row"><button class="btn primary" id="auth-go" type="submit"></button>
            <button class="btn" id="auth-later" type="button">Just watch</button></div>
        </form>
        <div class="note" id="auth-note"></div>
        <div class="note">Stuck with an old sign-in or session key, say after the cluster was rebuilt?
          <button class="link" type="button" id="auth-clear">Clear this browser’s data</button></div>
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
    el.querySelector('#auth-wallets').addEventListener('click', (event) => {
      const button = event.target.closest('[data-wallet]');
      if (button) this.#submitWallet(button.dataset.wallet);
    });
    this.bindClear(el.querySelector('#auth-clear'));
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
    const wallet = mode === 'wallet';
    $('#auth-title').textContent = wallet ? 'Play with your Cardano wallet'
      : mode === 'create' ? 'Create your commander' : 'Welcome back, commander';
    $('#auth-sub').textContent = wallet ? 'Your call sign, then pick your wallet: new or returning, it’s the same.'
      : mode === 'create' ? 'Pick a call sign and a password. That’s all.'
        : 'Your call sign and password unlock your key from the ledger.';
    $('#auth-go').textContent = mode === 'create' ? 'Create commander' : 'Sign in';
    $('#auth-go').hidden = wallet;
    $('#auth-password-row').hidden = wallet;
    $('#auth-strength-row').hidden = wallet;
    $('#auth-wallets').hidden = !wallet;
    $('#auth-note').textContent = wallet
      ? 'Your wallet signs one message, shown in the wallet: it lets a key made in this browser play as you for '
        + `${DAYS} days. No transaction, nothing spent, and no key leaves the wallet. On another browser, connect the `
        + 'wallet again. Only your wallet’s public key and address go on the ledger.'
      : 'Your password never leaves this browser. It locks a fresh signing key; only the locked key and its '
        + 'public half are stored on the ledger, so you can sign in on any device.';
    $('#auth-password').autocomplete = mode === 'create' ? 'new-password' : 'current-password';
    $('#auth-error').textContent = '';
    this.#steps(-1);
    if (wallet) {
      this.#renderWallets();
      setTimeout(() => this.mode === 'wallet' && this.#renderWallets(), 800); // wallets may inject late
    }
  }

  #renderWallets() {
    const wallets = detectWallets();
    const icon = (w) => (/^data:image\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="">` : '<span class="wicon">₳</span>');
    this.overlay.querySelector('#auth-wallets').innerHTML = wallets.length
      ? wallets.map((w) => `<button type="button" class="btn wallet-btn" data-wallet="${esc(w.id)}">${icon(w)}${esc(w.name)}</button>`).join('')
      : '<div class="small">No CIP-30 wallet found in this browser. Install Eternl, Lace, Yoroi or another Cardano '
        + 'wallet extension and reload, or use a password commander.</div>';
  }

  #precheck(id) {
    if (!CALLSIGN.test(id)) return 'Call signs are 3–20 characters: a–z, 0–9, _ or -';
    if (!globalThis.crypto?.subtle) {
      // Browsers offer WebCrypto only to https pages and localhost: http://<LAN address> can watch, not sign.
      return `This browser signs only on https or localhost, not on ${location.origin}. `
        + `In Chrome, add ${location.origin} under chrome://flags/#unsafely-treat-insecure-origin-as-secure and relaunch.`;
    }
    return null;
  }

  /** Sign in, or claim the call sign, with CIP-30 wallet `walletId`. */
  async #submitWallet(walletId) {
    const $ = (id) => this.overlay.querySelector(id);
    const id = $('#auth-callsign').value.trim().toLowerCase();
    $('#auth-error').textContent = '';
    const problem = this.#precheck(id);
    if (problem) { $('#auth-error').textContent = problem; return; }
    const buttons = this.overlay.querySelectorAll('form button');
    buttons.forEach((b) => { b.disabled = true; });
    const pause = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
    let at = 0;
    const d = {};
    try {
      this.#steps(at = 0);
      const found = await this.profiles.lookup(id);
      if (found.present && (!found.profile || found.revision !== 1)) throw new Error('That profile is not valid');
      if (found.present && found.profile.v !== 2) throw new Error(`“${id}” signs in with a password: use “I have an account”`);
      const { api, addresses } = await connectWallet(walletId);
      const address = found.present ? found.profile.wallet.address : addresses[0];
      if (found.present && !addresses.includes(address)) {
        throw new Error(`This wallet does not hold ${id}’s address ${shortAddress(address)}`);
      }
      d[0] = `connected · ${shortAddress(address)}`;
      this.#steps(at = 1, d);
      await pause(200);
      this.#steps(at = 2, { ...d, 2: 'waiting for you in the wallet…' });
      const device = await certifyDevice(ACCOUNTS, api, address, id);
      if (found.present && device.pub !== found.profile.pub) throw new Error(`This wallet’s key is not ${id}’s`);
      d[1] = `device key ${device.cert.device.slice(0, 6)}…${device.cert.device.slice(-4)}`;
      d[2] = `signed · this browser plays as ${id} until ${new Date(device.cert.until).toLocaleDateString()}`;
      this.#steps(at = 3, d);
      if (!found.present) {
        const done = await this.profiles.register(id, walletProfileBytes(ACCOUNTS, id, device.pub, address, device.cert),
          this.relay, () => this.#steps(3, { ...d, 3: 'submitted · waiting for the members to finalize…' }));
        for (let i = 0; i < 40 && !(await this.profiles.lookup(id)).present; i++) await pause(250);
        this.profileHeight = done.height;
        d[3] = `claimed at height ${done.height} in ${(done.ms / 1000).toFixed(1)} s`;
      } else {
        this.profileHeight = found.createdHeight;
        d[3] = `${id}’s wallet: it matches`;
      }
      this.#steps(at = 4, d);
      const commander = new Commander(id, device.pub, device.privateKey, { cert: device.cert, address });
      await rememberOnDevice(ACCOUNTS, commander);
      this.commander = commander;
      await pause(400);
      this.close();
      this.#emit();
    } catch (error) {
      this.#steps(at, d, true);
      $('#auth-error').textContent = error.message;
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
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
    if (this.mode === 'wallet') return; // the wallet buttons submit
    const id = $('#auth-callsign').value.trim().toLowerCase();
    const password = $('#auth-password').value;
    $('#auth-error').textContent = '';
    if (!CALLSIGN.test(id)) { $('#auth-error').textContent = 'Call signs are 3–20 characters: a–z, 0–9, _ or -'; return; }
    if (!password) { $('#auth-error').textContent = 'Enter your password'; return; }
    const problem = this.#precheck(id);
    if (problem) { $('#auth-error').textContent = problem; return; }
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
        if (found.profile.v === 2) throw new Error(`“${id}” signs in with a Cardano wallet: use the wallet tab`);
        this.#steps(at = 1, { 0: `found at height ${found.createdHeight}` });
        commander = await unlockCommander(ACCOUNTS, found.profile, password);
        this.#steps(at = 3, { 0: `found at height ${found.createdHeight}`, 2: 'it matches' });
        this.profileHeight = found.createdHeight;
      }
      await rememberOnDevice(ACCOUNTS, commander);
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
