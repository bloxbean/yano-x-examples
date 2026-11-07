// npm test — everything that needs no cluster: hashing, COSE verification
// (including a signature produced by a real wallet), and the game fold.
//
// The rejection cases matter most. A fold that accepts everything paints a
// nice wall in every happy-path test and lets anyone paint as anyone.

import { blake2b, blake2b224 } from '../js/blake2b.js';
import { decode, encode } from '../js/cbor.js';
import { verifyCip8 } from '../js/cip8.js';
import { cardanoAddressBech32, ed25519Generate, ed25519Sign, toHex, utf8 } from '../js/crypto.js';
import { CanvasState, joinPayload, pixelStatement } from '../js/game.js';
import { CONFIG } from '../js/config.js';
import { createMockWallet } from './mock-wallet.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message ?? 'assertion failed'); };
const eq = (actual, expected, label = '') => assert(actual === expected, `${label} expected ${expected}, got ${actual}`);

const RULES = { ...CONFIG, cooldownMs: { wallet: 3000, guest: 8000 } };
const T0 = 1_800_000_000_000;

// ------------------------------------------------------------------ fixtures

const hexBody = (object) => toHex(utf8(JSON.stringify(object)));
let height = 0;
const entry = (object, timestamp, index = 0) => {
  height += 1;
  return { height, index, messageId: `m${height}-${index}`, timestamp, bodyHex: hexBody(object) };
};

async function player() {
  const session = await ed25519Generate();
  const pub = toHex(session.publicKey);
  let nonce = 0;
  return {
    pub,
    async px(x, y, c, n = ++nonce) {
      const sig = toHex(await ed25519Sign(session.privateKey, utf8(pixelStatement(RULES, pub, n, x, y, c))));
      return { t: 'px', s: pub, n, x, y, c, sig };
    },
  };
}

async function walletJoin(wallet, sessionPub, { name = 'alice', expires = T0 + 3_600_000, cfg = RULES } = {}) {
  const addressHex = (await wallet.api.getUsedAddresses())[0];
  const signed = await wallet.api.signData(addressHex, toHex(utf8(joinPayload(cfg, sessionPub, name, expires))));
  return { t: 'join', cose: signed.signature, key: signed.key };
}

// ------------------------------------------------------------------ tests

console.log('primitives');

await check('BLAKE2b-512("abc") matches RFC 7693', () => {
  eq(toHex(blake2b(utf8('abc'), 64)),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
});
await check('BLAKE2b-224("") matches the reference', () => {
  eq(toHex(blake2b224(new Uint8Array(0))), '836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07');
});
await check('CBOR round-trips COSE-shaped values', () => {
  const value = new Map([[1, -8], ['address', Uint8Array.of(1, 2)], [-2, [true, null, 'x']]]);
  const back = decode(encode(value));
  eq(back.get(1), -8);
  eq(toHex(back.get('address')), '0102');
  eq(back.get(-2)[2], 'x');
});

console.log('CIP-8 wallet signatures');

const REAL = {
  signature: '845846a2012767616464726573735839003175d03902583e82037438cc86732f6e539f803f9a8b2d4ee164b9d0c77e617030631811f60a1f8a8be26d65a57ff71825b336cc6b76361da166686173686564f44b48656c6c6f20576f726c64584036c2151e1230364b0bf9e40cb65dbdca4c5decf4187e3c5511945d410ea59a1e733b5e68178c234979053ed75b0226ba826fb951c5a79fabf10bddcabda8dc05',
  key: 'a4010103272006215820a5f73966e73d0bb9eadc75c5857eafd054a0202d716ac6dde00303ee9c0019e3',
};

await check('a real wallet signData result verifies and binds to its base address', async () => {
  const r = await verifyCip8(REAL.signature, REAL.key);
  assert(r.ok, r.reason);
  eq(new TextDecoder().decode(r.payload), 'Hello World');
  assert(cardanoAddressBech32(r.address).startsWith('addr_test1q'), 'expected a testnet base address');
});
await check('a flipped signature bit is rejected', async () => {
  const bad = REAL.signature.slice(0, -2) + (REAL.signature.endsWith('05') ? '04' : '05');
  eq((await verifyCip8(bad, REAL.key)).reason, 'signature does not verify');
});
await check('a hashed payload is refused — the game must read the text', async () => {
  const hashed = '84582aa201276761646472657373581de103d205532089ad2f7816892e2ef42849b7b52788e41b3fd43a6e01cfa166686173686564f5581c1c1afc33a1ed48205eadcbbda2fc8e61442af2e04673616f21b7d0385840954858f672e9ca51975655452d79a8f106011e9535a2ebfb909f7bbcce5d10d246ae62df2da3a7790edd8f93723cbdfdffc5341d08135b1a40e7a998e8b2ed06';
  const r = await verifyCip8(hashed, 'a4010103272006215820c13745be35c2dfc3fa9523140030dda5b5346634e405662b1aae5c61389c55b3');
  assert(!r.ok && /hashed/.test(r.reason), r.reason);
});
await check("a valid signature over someone else's address is rejected", async () => {
  const mallory = await createMockWallet();
  const victim = await createMockWallet();
  const victimAddress = (await victim.api.getUsedAddresses())[0];
  // Mallory signs correctly with her key but puts the victim's address in the header.
  const protectedHeader = encode(new Map([[1, -8], ['address', Uint8Array.from(Buffer.from(victimAddress, 'hex'))]]));
  const signed = await mallory.api.signData((await mallory.api.getUsedAddresses())[0], '00');
  const parts = decode(Uint8Array.from(Buffer.from(signed.signature, 'hex')));
  const { webcrypto } = await import('node:crypto');
  const key = await webcrypto.subtle.importKey('pkcs8', Buffer.from(mallory.record.pkcs8, 'hex'), { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, key,
    encode(['Signature1', protectedHeader, new Uint8Array(0), parts[2]])));
  const forged = toHex(encode([protectedHeader, new Map(), parts[2], sig]));
  eq((await verifyCip8(forged, signed.key)).reason, 'signing key does not belong to the address');
});
await check('a script address cannot sign', async () => {
  const wallet = await createMockWallet();
  const address = Uint8Array.from(Buffer.from((await wallet.api.getUsedAddresses())[0], 'hex'));
  address[0] = 0x70; // enterprise, script credential
  const protectedHeader = encode(new Map([[1, -8], ['address', address]]));
  const { webcrypto } = await import('node:crypto');
  const key = await webcrypto.subtle.importKey('pkcs8', Buffer.from(wallet.record.pkcs8, 'hex'), { name: 'Ed25519' }, false, ['sign']);
  const payload = Uint8Array.of(1);
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, key,
    encode(['Signature1', protectedHeader, new Uint8Array(0), payload])));
  const coseKey = toHex(encode(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(wallet.record.publicKey, 'hex')]])));
  const r = await verifyCip8(toHex(encode([protectedHeader, new Map(), payload, sig])), coseKey);
  assert(!r.ok && /no key credential/.test(r.reason), r.reason);
});

console.log('the game fold');

await check('a wallet join binds a session; its pixels paint as the wallet', async () => {
  const state = new CanvasState(RULES);
  const wallet = await createMockWallet();
  const p = await player();
  const join = await state.apply(entry(await walletJoin(wallet, p.pub), T0));
  assert(join.accepted, join.reason);
  const px = await state.apply(entry(await p.px(3, 4, 5), T0 + 1000));
  assert(px.accepted, px.reason);
  eq(px.player.kind, 'wallet');
  eq(px.player.name, 'alice');
  eq(state.cells[4 * RULES.size + 3].c, 5);
});
await check('cooldown is measured in certified block time, per player', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  assert((await state.apply(entry(await p.px(0, 0, 1), T0))).accepted);
  eq((await state.apply(entry(await p.px(1, 0, 1), T0 + 7999))).reason, 'cooling down');
  assert((await state.apply(entry(await p.px(1, 0, 1), T0 + 8000))).accepted, 'guest cooldown is 8 s');
});
await check('a replayed pixel is refused, even after its cooldown', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  const move = await p.px(0, 0, 3);
  assert((await state.apply(entry(move, T0))).accepted);
  eq((await state.apply(entry(move, T0 + 60_000))).reason, 'stale nonce (replayed)');
});
await check('a refused pixel burns its nonce, so it cannot be replayed later', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  assert((await state.apply(entry(await p.px(0, 0, 1), T0))).accepted);
  const early = await p.px(9, 9, 9);
  eq((await state.apply(entry(early, T0 + 10))).reason, 'cooling down');
  eq((await state.apply(entry(early, T0 + 60_000))).reason, 'stale nonce (replayed)');
});
await check('a pixel with a tampered colour fails its signature', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  const move = { ...(await p.px(0, 0, 1)), c: 2 };
  eq((await state.apply(entry(move, T0))).reason, 'session signature does not verify');
});
await check('out-of-range coordinates and colours are refused', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  eq((await state.apply(entry(await p.px(RULES.size, 0, 0), T0))).reason, 'field out of range');
  eq((await state.apply(entry(await p.px(0, 0, RULES.palette.length), T0))).reason, 'field out of range');
});
await check('a session cannot be re-bound to another wallet', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  assert((await state.apply(entry(await walletJoin(await createMockWallet(), p.pub), T0))).accepted);
  eq((await state.apply(entry(await walletJoin(await createMockWallet(), p.pub, { name: 'mallory' }), T0)))
    .reason, 'session already bound');
});
await check('a join signed for another game or chain is refused', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  const other = { ...RULES, chainId: 'registry-chain' };
  eq((await state.apply(entry(await walletJoin(await createMockWallet(), p.pub, { cfg: other }), T0))).reason,
    'signed for another game');
});
await check('sessions expire by block time, and cannot be authorized for more than a day', async () => {
  const state = new CanvasState(RULES);
  const p = await player();
  const wallet = await createMockWallet();
  eq((await state.apply(entry(await walletJoin(wallet, p.pub, { expires: T0 + RULES.maxSessionMs + 1 }), T0)))
    .reason, 'session too long');
  assert((await state.apply(entry(await walletJoin(wallet, p.pub, { expires: T0 + 5000 }), T0))).accepted);
  eq((await state.apply(entry(await p.px(0, 0, 1), T0 + 5001))).reason, 'session expired');
});
await check('the later finalized pixel wins a cell; frames and leaderboards follow the log', async () => {
  const state = new CanvasState(RULES);
  const a = await player();
  const b = await player();
  await state.apply(entry(await a.px(5, 5, 1), T0));
  const sealedAt = height;
  await state.apply(entry(await b.px(5, 5, 2), T0 + 1));
  await state.apply(entry(await b.px(6, 5, 2), T0 + 9000));
  eq(state.cells[5 * RULES.size + 5].c, 2, 'live');
  eq(state.frameAt(sealedAt)[5 * RULES.size + 5].c, 1, 'frame');
  const board = state.leaderboard();
  eq(board[0].player.id, `guest:${b.pub}`);
  eq(board[0].held, 2);
});
await check('two clients folding the same log reach the same wall', async () => {
  const p = await player();
  const q = await player();
  const log = [];
  for (let i = 0; i < 12; i++) {
    log.push(entry(await (i % 2 ? p : q).px(i % 4, i % 3, i % 16), T0 + i * 5000));
  }
  const one = new CanvasState(RULES);
  const two = new CanvasState(RULES);
  for (const e of log) await one.apply(e);
  for (const e of log) await two.apply(e);
  await one.apply(log[3]); // re-delivery of an old entry is skipped
  eq(JSON.stringify(one.cells), JSON.stringify(two.cells));
});
await check('garbage bodies are refused, not fatal', async () => {
  const state = new CanvasState(RULES);
  eq((await state.apply({ height: 1, index: 0, messageId: 'x', timestamp: T0, bodyHex: 'ff00' })).reason, 'not JSON');
  eq((await state.apply(entry({ t: 'nope' }, T0))).reason, 'unknown message kind');
  eq((await state.apply(entry({ t: 'join', cose: 'zz', key: '00' }, T0))).accepted, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
