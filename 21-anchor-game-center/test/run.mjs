// npm test — everything that needs no cluster: the authenticated-map wire
// bytes (pinned to the release CLI), the shared account keystore, and every
// game's rules: Galaxy, Arcade, Land Rush, Sealed Duels, Comet Derby, Reef,
// Deep Sonar and Neon Rush.

import { blake2b } from '../shared/blake2b.js';
import { decodeEntry, putIfAbsentEnvelope } from '../shared/authmap.js';
import { logicalValueHash } from '../shared/proofs.js';
import { createCommander, readProfile, unlockCommander } from '../shared/accounts.js';
import { fromHex, toHex, utf8 } from '../shared/crypto.js';
import { ACCOUNTS } from '../shared/config.js';
import { Galaxy, generateMap, isqrt, moveStatement, roundStart } from '../galaxy/js/galaxy.js';
import { CONFIG } from '../galaxy/js/config.js';
import { CONFIG as ARCADE } from '../arcade/js/config.js';
import { FIRE, LEFT, RUN_FRAMES, THRUST, Run, cos, replay, sin } from '../arcade/js/sim.js';
import { Arcade, decodeInputs, encodeInputs, fieldSeed, inputsHash, runStatement } from '../arcade/js/runs.js';
import { CONFIG as LAND } from '../land/js/config.js';
import { Land, claimStatement, decodeCommand, generateMap as landMap, seasonSeed, tileKey } from '../land/js/land.js';
import { encode } from '../shared/cbor.js';
import { CONFIG as DUELS } from '../duels/js/config.js';
import { Duel, Lobby, damage, rollDie, sealHash, statement as duelStatement } from '../duels/js/duels.js';
import { profileKey } from '../shared/accounts.js';
import { rng } from '../shared/rng.js';
import { CONFIG as DERBY } from '../derby/js/config.js';
import { Derby, betStatement, raceClose, raceSeed, runRace } from '../derby/js/derby.js';
import { CONFIG as REEF } from '../reef/js/config.js';
import { Reef, Timeline, census, seedStatement, shape, soup, stamp, step, worldHash } from '../reef/js/reef.js';
import { CONFIG as MOTO } from '../moto/js/config.js';
import { Run as Ride, Track, autopilot as rider, replay as replayRide, THROTTLE as GAS } from '../moto/js/sim.js';
import { createSessionKey, signerFromKey, issueDelegation, signWrite, encodeCanonicalValue, hex }
  from '../shared/topic-client/topics.mjs';
import { Circuit, circuitSeed, inputsHash as rideHash, runStatement as rideStatement, splitStatement } from '../moto/js/races.js';
import { CONFIG as SONAR } from '../sonar/js/config.js';
import { Battle, Lobby as SonarLobby, answerFor, fleetRoot, merkleLevels, randomFleet, statement as sonarStatement,
  validFleet, verifyAnswer } from '../sonar/js/sonar.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.stack?.split('\n').slice(0, 3).join('\n       ')}`);
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message ?? 'assertion failed'); };
const eq = (actual, expected, label = '') => assert(actual === expected, `${label} expected ${expected}, got ${actual}`);
async function throws(fn, pattern) {
  try { await fn(); } catch (error) { assert(pattern.test(error.message), `wrong error: ${error.message}`); return; }
  throw new Error('expected an error');
}

const FAST = 1000; // PBKDF2 rounds for tests; the game uses CONFIG.kdfIterations
const ROUND = 6_000_000;
const T0 = roundStart(CONFIG, ROUND);

// ------------------------------------------------------------------ fixtures

const commanders = new Map();
async function commander(id) {
  if (!commanders.has(id)) commanders.set(id, (await createCommander(ACCOUNTS, id, 'correct horse battery', FAST)).commander);
  return commanders.get(id);
}
let nonce = 0;
async function join(id, n = ++nonce) {
  const c = await commander(id);
  const sig = await c.sign(moveStatement(CONFIG, ROUND, 'join', id, n, [c.pub]));
  return { t: 'join', id, pub: c.pub, n, sig };
}
async function go(id, from, to, pct = 50, n = ++nonce) {
  const c = await commander(id);
  const sig = await c.sign(moveStatement(CONFIG, ROUND, 'go', id, n, [from, to, pct]));
  return { t: 'go', id, n, from, to, pct, sig };
}
let height = 0;
const entry = (move, timestamp, index = 0) => {
  height += 1;
  return { height, index, messageId: `m${height}`, timestamp, bodyHex: toHex(utf8(JSON.stringify(move))) };
};
const anyone = async () => ({ ok: true });

// ------------------------------------------------------------------ tests

console.log('wire formats');

await check('BLAKE2b-512("abc") matches RFC 7693', () => {
  eq(toHex(blake2b(utf8('abc'), 64)),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
});
await check('PUT_IF_ABSENT envelope matches the release CLI byte for byte', () => {
  // yano.sh appchain authenticated-map action --assignments 0:owner::0, then command --evidence-hex ''
  eq(toHex(putIfAbsentEnvelope('attachments', utf8('galaxy/v1/probe'), Uint8Array.of(0x7b, 0x7d))),
    '8301582e8401008187016b6174746163686d656e74734f67616c6178792f76312f70726f6265427b7d00404081840001600080');
});
await check('entry records decode, present and absent', () => {
  const present = decodeEntry({
    committedHeight: 1, record: { presence: 1 },
    recordValue: '8801000158208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c427b7d5820dc3ebb50957ac866b72f666854f28e0e4fc9107a0ebed5087f1b0989adbcae6c0101',
  });
  assert(present.present);
  eq(present.revision, 1);
  eq(present.createdHeight, 1);
  eq(toHex(present.value), '7b7d');
  const absent = decodeEntry({ committedHeight: 2, record: { presence: 0 }, recordValue: '' });
  eq(absent.present, false);
  eq(absent.committedHeight, 2);
});

await check('the value digest a profile proof carries matches the ledger\'s own hash', () => {
  // the entry route reported this logicalValueHash for the value {} (7b7d)
  eq(logicalValueHash(Uint8Array.of(0x7b, 0x7d)), 'dc3ebb50957ac866b72f666854f28e0e4fc9107a0ebed5087f1b0989adbcae6c');
});

console.log('commander accounts');

await check('a profile round-trips: create, read back, unlock with the password', async () => {
  const { commander: c, profileBytes } = await createCommander(ACCOUNTS, 'satya', 'correct horse battery', FAST);
  const text = new TextDecoder().decode(profileBytes);
  assert(!text.includes('correct horse'), 'password must not appear in the profile');
  const profile = await readProfile(ACCOUNTS, 'satya', profileBytes);
  assert(profile, 'profile should verify');
  const unlocked = await unlockCommander(ACCOUNTS, profile, 'correct horse battery');
  eq(unlocked.pub, c.pub);
  const sig = await unlocked.sign('hello');
  eq(sig, await c.sign('hello')); // Ed25519 is deterministic: same key, same signature
});
await check('the wrong password does not unlock', async () => {
  const { profileBytes } = await createCommander(ACCOUNTS, 'vega', 'correct horse battery', FAST);
  await throws(() => unlockCommander(ACCOUNTS, JSON.parse(new TextDecoder().decode(profileBytes)), 'battery horse correct'),
    /Wrong password/);
});
await check('a profile claimed under another call sign, or with another key, is refused', async () => {
  const { profileBytes } = await createCommander(ACCOUNTS, 'nova', 'correct horse battery', FAST);
  eq(await readProfile(ACCOUNTS, 'orbit', profileBytes), null);
  const p = JSON.parse(new TextDecoder().decode(profileBytes));
  p.pub = (await commander('mallory')).pub;
  eq(await readProfile(ACCOUNTS, 'nova', utf8(JSON.stringify(p))), null);
});
await check('short passwords and bad call signs are refused before anything is generated', async () => {
  await throws(() => createCommander(ACCOUNTS, 'ok-name', 'short', FAST), /at least/);
  await throws(() => createCommander(ACCOUNTS, 'Bad Name', 'correct horse battery', FAST), /Call signs/);
});

console.log('the galaxy');

await check('isqrt is exact', () => {
  for (const n of [0, 1, 2, 3, 4, 15, 16, 17, 999_999, 1_000_000, 2 ** 40 + 3]) {
    const r = isqrt(n);
    assert(r * r <= n && (r + 1) * (r + 1) > n, `isqrt(${n}) = ${r}`);
  }
});
await check('every round has its own map, and the same map for everyone', () => {
  const a = generateMap(CONFIG, ROUND);
  eq(JSON.stringify(a), JSON.stringify(generateMap(CONFIG, ROUND)));
  assert(JSON.stringify(a) !== JSON.stringify(generateMap(CONFIG, ROUND + 1)), 'next round should differ');
  eq(a.length, CONFIG.game.planets, 'planet count');
  for (const p of a) assert(p.x >= 0 && p.x <= CONFIG.game.width && p.y >= 0 && p.y <= CONFIG.game.height, 'in bounds');
});
await check('a join claims a free home planet with the starting fleet', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  const r = await g.apply(entry(await join('satya'), T0 + 1000), anyone);
  assert(r.accepted, r.reason);
  eq(g.planets[0].owner, 0);
  eq(g.planets[0].milli, CONFIG.game.homeShips * 1000);
});
await check('planets grow by certified time, up to their cap', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  await g.apply(entry(await join('satya'), T0), anyone);
  eq(g.shipsAt(g.planets[0], T0 + 10_000), 40_000 + 20_000, 'size 3 makes 2 ships a second');
  eq(g.shipsAt(g.planets[0], T0 + 10_000_000), 200_000, 'cap');
});
await check('a fleet leaves, flies for distance/speed, and captures a weaker planet', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  await g.apply(entry(await join('satya'), T0), anyone);
  const target = g.planets.slice(CONFIG.game.homes).find((p) => p.milli < 18_000);
  const r = await g.apply(entry(await go('satya', 0, target.id, 50), T0), anyone);
  assert(r.accepted, r.reason);
  eq(r.fleet.milli, 20_000, 'half of 40 ships');
  eq(g.planets[0].milli, 20_000);
  const travel = Math.floor((isqrt((target.x - g.planets[0].x) ** 2 + (target.y - g.planets[0].y) ** 2) * 1000)
    / CONFIG.game.fleetSpeed);
  eq(r.fleet.arrive, T0 + travel);
  g.advanceTo(r.fleet.arrive - 1);
  eq(g.planets[target.id].owner, -1, 'not yet');
  const garrison = target.milli;
  g.advanceTo(r.fleet.arrive);
  eq(g.planets[target.id].owner, 0, 'captured on arrival');
  eq(g.planets[target.id].milli, 20_000 - garrison);
  eq(g.s.events.at(-1).kind, 'capture');
});
await check("you can only launch from your own planets, and nonces can't be replayed", async () => {
  const g = new Galaxy(CONFIG, ROUND);
  await g.apply(entry(await join('satya'), T0), anyone);
  await g.apply(entry(await join('nova'), T0), anyone);
  eq((await g.apply(entry(await go('satya', 1, 5), T0 + 10), anyone)).reason, 'not your planet');
  const move = await go('satya', 0, 5);
  assert((await g.apply(entry(move, T0 + 20), anyone)).accepted);
  eq((await g.apply(entry(move, T0 + 30), anyone)).reason, 'stale nonce (replayed)');
});
await check('a forged or altered move is refused', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  await g.apply(entry(await join('satya'), T0), anyone);
  const move = { ...(await go('satya', 0, 9, 25)), pct: 100 };
  eq((await g.apply(entry(move, T0 + 1), anyone)).reason, 'launch signature does not verify');
  const forged = { ...(await go('mallory', 0, 9, 25)), id: 'satya' };
  eq((await g.apply(entry(forged, T0 + 2), anyone)).reason, 'launch signature does not verify');
});
await check('joins are checked against the profile ledger, which may say "later"', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  const refuse = async () => ({ ok: false, reason: 'registered after joining' });
  eq((await g.apply(entry(await join('satya'), T0), refuse)).reason, 'registered after joining');
  const later = async () => { throw new Error('profile not visible yet'); };
  const e = entry(await join('nova'), T0 + 5);
  await throws(() => g.apply(e, later), /not visible/);
  eq(g.position.height, e.height - 1, 'a retry must not move the position');
  assert((await g.apply(e, anyone)).accepted, 'the retry applies');
});
await check('moves outside the round, and a ninth commander, are refused', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  eq((await g.apply(entry(await join('early'), T0 - 1), anyone)).reason, 'outside this round');
  for (let i = 0; i < CONFIG.game.homes; i++) {
    assert((await g.apply(entry(await join(`cmdr-${i}`), T0 + i), anyone)).accepted);
  }
  eq((await g.apply(entry(await join('late'), T0 + 100), anyone)).reason, 'galaxy full');
});
await check('a block caps launches per commander', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  await g.apply(entry(await join('satya'), T0), anyone);
  height += 1;
  const results = [];
  for (let i = 0; i <= CONFIG.game.maxLaunchesPerBlock; i++) {
    const e = { height, index: i, messageId: `b${i}`, timestamp: T0 + 50,
      bodyHex: toHex(utf8(JSON.stringify(await go('satya', 0, 8 + i, 25)))) };
    results.push(await g.apply(e, anyone));
  }
  eq(results.filter((r) => r.accepted).length, CONFIG.game.maxLaunchesPerBlock);
  eq(results.at(-1).reason, 'too many launches in one block');
});
await check('running ahead on a clone never changes the authoritative galaxy', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  await g.apply(entry(await join('satya'), T0), anyone);
  await g.apply(entry(await go('satya', 0, 12, 100), T0), anyone);
  const before = JSON.stringify(g.s);
  const view = g.clone();
  view.advanceTo(T0 + 60_000);
  eq(view.fleets.length, 0);
  eq(JSON.stringify(g.s), before);
});
await check('two browsers folding the same log reach the same galaxy and the same winner', async () => {
  const log = [entry(await join('satya'), T0), entry(await join('nova'), T0 + 10)];
  for (let i = 0; i < 30; i++) {
    const who = i % 2 ? 'nova' : 'satya';
    log.push(entry(await go(who, i % 2, 8 + (i % 14), CONFIG.game.ratios[i % 4]), T0 + 1000 + i * 700));
  }
  const one = new Galaxy(CONFIG, ROUND);
  const two = new Galaxy(CONFIG, ROUND);
  for (const e of log) await one.apply(e, anyone);
  for (const e of log) await two.apply(e, anyone);
  await one.apply(log[5], anyone); // a re-delivered entry is skipped
  const end = one.end;
  one.advanceTo(end);
  two.advanceTo(end);
  eq(JSON.stringify(one.s), JSON.stringify(two.s));
  eq(one.standings(end)[0].player.id, two.standings(end)[0].player.id);
});
await check('garbage is refused, not fatal', async () => {
  const g = new Galaxy(CONFIG, ROUND);
  height += 1;
  eq((await g.apply({ height, index: 0, messageId: 'x', timestamp: T0, bodyHex: 'ff00' }, anyone)).reason,
    'not a move');
  eq((await g.apply(entry({ t: 'go', id: 'nobody' }, T0), anyone)).reason, 'not in this round');
});

console.log('the arcade');

// A scripted pilot: deterministic inputs that turn, thrust and fire a lot.
const pilot = (variant = 0) => {
  const frames = new Uint8Array(RUN_FRAMES);
  for (let f = 0; f < RUN_FRAMES; f++) {
    frames[f] = (f % 9 < 6 ? FIRE : 0) | ((f + variant) % 240 < 50 ? LEFT : 0) | (f % 300 < 30 ? THRUST : 0);
  }
  return frames;
};
const FIELD = 2_000_000;
const F0 = FIELD * ARCADE.fieldMs;
const SEED = fieldSeed(ARCADE, FIELD, 'aa'.repeat(32));
async function runMove(id, frames, { score, n = ++nonce, seed = SEED } = {}) {
  const c = await commander(id);
  const encoded = encodeInputs(frames);
  const claimed = score ?? replay(fromHex(seed), frames).score;
  const sig = await c.sign(runStatement(ARCADE, FIELD, seed, id, n, inputsHash(encoded), claimed));
  return { t: 'run', id, pub: c.pub, n, seed, inputs: toHex(encoded), score: claimed, sig };
}
const arcadeEntry = (move, timestamp, stateRoot = 'aa'.repeat(32)) => {
  height += 1;
  return { height, index: 0, messageId: `a${height}`, timestamp, stateRoot,
    bodyHex: toHex(utf8(JSON.stringify(move))) };
};
async function openField() {
  const a = new Arcade(ARCADE, FIELD);
  const r = await a.apply(arcadeEntry({ t: 'open' }, F0 + 1), anyone);
  assert(r.accepted && r.opened, 'the first message opens the field');
  eq(a.seed, SEED);
  return a;
}

await check('the sine table is exact and symmetric', () => {
  eq(sin(0), 0); eq(sin(64), 16384); eq(sin(128), 0); eq(sin(192), -16384);
  for (let a = 0; a < 256; a++) eq(sin(a), -sin(256 - a) || 0, `sin(${a})`);
  eq(cos(0), 16384);
});
await check('inputs round-trip through the run-length encoding, and are compact', () => {
  const frames = pilot();
  const encoded = encodeInputs(frames);
  eq(toHex(decodeInputs(encoded, RUN_FRAMES)), toHex(frames));
  assert(encoded.length < 3000, `encoded ${encoded.length} bytes`);
  let threw = false;
  try { decodeInputs(encoded.slice(0, -2), RUN_FRAMES); } catch { threw = true; }
  assert(threw, 'short inputs must be refused');
});
await check('the same seed and inputs give the same run, every time', () => {
  const a = replay(fromHex(SEED), pilot());
  const b = replay(fromHex(SEED), pilot());
  eq(a.score, b.score);
  eq(JSON.stringify(a.rocks), JSON.stringify(b.rocks));
  assert(a.kills > 0, 'the pilot should hit something');
  const other = replay(fromHex(fieldSeed(ARCADE, FIELD + 1, 'aa'.repeat(32))), pilot());
  assert(JSON.stringify(other.rocks) !== JSON.stringify(a.rocks), 'another field has other rocks');
});
await check('live play step by step equals the replay', () => {
  const frames = pilot(7);
  const live = new Run(fromHex(SEED));
  for (const bits of frames) live.step(bits);
  eq(live.score, replay(fromHex(SEED), frames).score);
});
await check('a field is seeded by its first finalized block', async () => {
  const a = await openField();
  const r = await a.apply(arcadeEntry({ t: 'open' }, F0 + 2, 'bb'.repeat(32)), anyone);
  assert(r.accepted && !r.opened, 'a second open changes nothing');
  eq(a.seed, SEED);
});
await check('an honest run is accepted, replayed, and ranked', async () => {
  const a = await openField();
  const r = await a.apply(arcadeEntry(await runMove('satya', pilot()), F0 + 1000), anyone);
  assert(r.accepted, r.reason);
  eq(a.leaderboard()[0].id, 'satya');
  eq(a.leaderboard()[0].score, replay(fromHex(SEED), pilot()).score);
});
await check('a claimed score that the inputs do not reach is refused', async () => {
  const a = await openField();
  const honest = replay(fromHex(SEED), pilot()).score;
  const r = await a.apply(arcadeEntry(await runMove('satya', pilot(), { score: honest + 100 }), F0 + 1000), anyone);
  eq(r.accepted, false);
  assert(/does not replay/.test(r.reason), r.reason);
  eq(a.leaderboard().length, 0);
});
await check('altered inputs break the signature; another field’s run is refused', async () => {
  const a = await openField();
  const move = await runMove('satya', pilot());
  const tampered = { ...move, inputs: toHex(encodeInputs(pilot(3))) };
  eq((await a.apply(arcadeEntry(tampered, F0 + 1000), anyone)).reason, 'run signature does not verify');
  const elsewhere = await runMove('satya', pilot(), { seed: 'cd'.repeat(16) });
  eq((await a.apply(arcadeEntry(elsewhere, F0 + 1001), anyone)).reason, 'played on another field');
});
await check('a replayed run message is refused; a better run replaces your best', async () => {
  const a = await openField();
  const first = await runMove('satya', pilot());
  assert((await a.apply(arcadeEntry(first, F0 + 1000), anyone)).accepted);
  eq((await a.apply(arcadeEntry(first, F0 + 2000), anyone)).reason, 'stale nonce (replayed)');
  const scores = [0, 7, 21, 40].map((v) => ({ v, s: replay(fromHex(SEED), pilot(v)).score }));
  const better = scores.find((x) => x.s > replay(fromHex(SEED), pilot()).score);
  if (better) {
    assert((await a.apply(arcadeEntry(await runMove('satya', pilot(better.v)), F0 + 3000), anyone)).accepted);
    eq(a.leaderboard()[0].score, better.s);
  }
  eq(a.leaderboard().length, 1, 'one row per commander');
});
await check('runs are checked against the profile ledger, and outside the field window refused', async () => {
  const a = await openField();
  const refuse = async () => ({ ok: false, reason: 'key does not match the profile' });
  eq((await a.apply(arcadeEntry(await runMove('nova', pilot()), F0 + 1000), refuse)).reason,
    'key does not match the profile');
  eq((await a.apply(arcadeEntry(await runMove('nova', pilot()), F0 + ARCADE.fieldMs), anyone)).reason,
    'outside this field');
});

console.log('land rush');

const SEASON = 500_000;
const S0 = SEASON * LAND.seasonMs;
const ROOT = 'cc'.repeat(32);
const LSEED = seasonSeed(LAND, SEASON, ROOT);
const profileBytes = new Map();
async function landCommander(id) {
  if (!profileBytes.has(id)) {
    const made = await createCommander(ACCOUNTS, id, 'correct horse battery', FAST);
    profileBytes.set(id, made);
  }
  return profileBytes.get(id);
}
const authEntry = (bodyBytes, timestamp, index = 0) => {
  height += 1;
  return { height, index, messageId: `l${height}-${index}`, timestamp, stateRoot: ROOT, bodyHex: toHex(bodyBytes) };
};
async function register(id, timestamp) {
  const { profileBytes: bytes } = await landCommander(id);
  return authEntry(putIfAbsentEnvelope(ACCOUNTS.profilesCollection, profileKey(ACCOUNTS, id), bytes), timestamp);
}
async function claimEntry(id, c, r, timestamp, { sign = id, seed = LSEED } = {}) {
  const { commander } = await landCommander(id);
  const signer = (await landCommander(sign)).commander;
  const sig = await signer.sign(claimStatement(LAND, SEASON, seed, c, r, id));
  const value = utf8(JSON.stringify({ v: 1, id, pub: commander.pub, sig }));
  return authEntry(putIfAbsentEnvelope(ACCOUNTS.profilesCollection, utf8(tileKey(LAND, SEASON, seed, c, r)), value), timestamp);
}
const noReceipt = async () => { throw new Error('the fold should not need a receipt here'); };
async function landWith(...ids) {
  const land = new Land(LAND, ACCOUNTS, SEASON);
  for (const id of ids) await land.apply(await register(id, S0 + 1), { receipt: noReceipt });
  return land;
}
const outcome = async (land, entry, receipt = noReceipt) => (await land.apply(entry, { receipt })).outcomes.at(-1);

await check('a season is seeded by its first block, and its map follows the seed', async () => {
  const land = await landWith('satya');
  eq(land.seed, LSEED);
  eq(JSON.stringify(land.map), JSON.stringify(landMap(LAND, LSEED)));
  assert(JSON.stringify(landMap(LAND, 'ab'.repeat(16))) !== JSON.stringify(land.map), 'another seed, another map');
  const kinds = new Set(land.map.map((t) => t.terrain));
  assert(kinds.size >= 3, `expected varied terrain, got ${[...kinds]}`);
});
await check('our claim envelope decodes as a lone owner PUT_IF_ABSENT', async () => {
  const e = await claimEntry('satya', 3, 4, S0 + 10);
  const cmd = decodeCommand(e.bodyHex);
  eq(cmd.shape, 0); eq(cmd.mutations.length, 1); eq(cmd.mutations[0].op, 1);
  eq(cmd.mutations[0].key, tileKey(LAND, SEASON, LSEED, 3, 4));
});
await check('the first claim on a tile wins; the second loses, exactly as the ledger decides', async () => {
  const land = await landWith('satya', 'nova');
  const first = await outcome(land, await claimEntry('nova', 5, 5, S0 + 10));
  eq(first.kind, 'claimed'); eq(first.id, 'nova'); assert(first.capital, 'a first claim is a capital');
  const second = await outcome(land, await claimEntry('satya', 5, 5, S0 + 10));
  eq(second.kind, 'lost'); eq(second.holder.owner, 'nova');
  eq(land.tiles.get('5,5').owner, 'nova');
});
await check('claims need a profile created earlier in the log, with the same key and a valid signature', async () => {
  const land = await landWith('satya');
  eq((await outcome(land, await claimEntry('vega', 1, 1, S0 + 10))).reason, 'vega had no profile before this claim');
  const forged = await outcome(land, await claimEntry('satya', 2, 2, S0 + 11, { sign: 'mallory' }));
  eq(forged.reason, 'the signature does not verify');
  eq(land.tiles.get('2,2').scorched, true, 'a bad first claim scorches the tile');
});
await check('after the capital, claims must touch your land', async () => {
  const land = await landWith('satya');
  assert((await outcome(land, await claimEntry('satya', 10, 10, S0 + 10))).capital);
  eq((await outcome(land, await claimEntry('satya', 20, 3, S0 + 5000))).reason, 'satya’s claim does not touch their land');
  eq((await outcome(land, await claimEntry('satya', 11, 10, S0 + 9000))).kind, 'claimed');
});
await check('stamina is spent per claim and refills by certified block time', async () => {
  const land = await landWith('satya');
  const row = [[10, 4], [11, 4], [12, 4], [13, 4], [14, 4]];
  const results = [];
  for (const [c, r] of row) results.push(await outcome(land, await claimEntry('satya', c, r, S0 + 100)));
  eq(results.filter((x) => x.kind === 'claimed').length, LAND.stamina.start);
  eq(results.at(-1).reason, 'satya was out of stamina');
  eq((await outcome(land, await claimEntry('satya', 15, 4, S0 + 100 + LAND.stamina.regenMs))).reason,
    'satya’s claim does not touch their land', 'tile 14,4 was scorched, so 15,4 does not touch');
  eq((await outcome(land, await claimEntry('satya', 10, 5, S0 + 100 + LAND.stamina.regenMs))).kind, 'claimed');
});
await check('a command shape the fold does not mirror is settled by the ledger’s receipt', async () => {
  const land = await landWith('satya');
  const { commander } = await landCommander('satya');
  const sig = await commander.sign(claimStatement(LAND, SEASON, LSEED, 7, 7, 'satya'));
  const value = utf8(JSON.stringify({ v: 1, id: 'satya', pub: commander.pub, sig }));
  const empty = new Uint8Array(0);
  const put = [0, ACCOUNTS.profilesCollection, utf8(tileKey(LAND, SEASON, LSEED, 7, 7)), value, 0, empty, empty];
  const body = encode([1, encode([1, 0, [put], [[0, 1, '', 0]]]), []]);
  const refused = await outcome(land, authEntry(body, S0 + 10), async () => ({ status: 1 }));
  eq(refused, undefined, 'a refused command claims nothing');
  eq(land.tiles.has('7,7'), false);
  const applied = await outcome(land, authEntry(body, S0 + 20), async () => ({ status: 0 }));
  eq(applied.kind, 'claimed');
});
await check('claims after the season ends are scorched', async () => {
  const land = await landWith('satya');
  eq((await outcome(land, await claimEntry('satya', 4, 4, S0 + LAND.seasonMs + 1))).reason, 'claimed after the season ended');
});
await check('score is land value plus the bonus for the largest connected realm', async () => {
  const land = await landWith('satya');
  await outcome(land, await claimEntry('satya', 8, 8, S0 + 10));
  await outcome(land, await claimEntry('satya', 9, 8, S0 + 11));
  const [row] = land.standings();
  const value = [[8, 8], [9, 8]].reduce((s, [c, r]) => s + LAND.terrain[land.map[r * LAND.cols + c].terrain].value, 0);
  eq(row.tiles, 2); eq(row.realm, 2); eq(row.score, value + LAND.realmBonus * 2);
});
await check('two browsers folding the same claims reach the same map and standings', async () => {
  const log = [await register('satya', S0 + 1), await register('nova', S0 + 2)];
  for (let i = 0; i < 12; i++) {
    log.push(await claimEntry(i % 2 ? 'nova' : 'satya', 3 + (i % 6), 2 + Math.floor(i / 6), S0 + 100 + i * 3000));
  }
  const one = new Land(LAND, ACCOUNTS, SEASON);
  const two = new Land(LAND, ACCOUNTS, SEASON);
  for (const e of log) await one.apply(e, { receipt: noReceipt });
  for (const e of log) await two.apply(e, { receipt: noReceipt });
  const view = (l) => JSON.stringify([...l.tiles.entries()].map(([k, t]) => [k, t.owner ?? null, t.reason ?? null]));
  eq(view(one), view(two));
  eq(JSON.stringify(one.standings()), JSON.stringify(two.standings()));
});

console.log('sealed duels');

const D0 = 1_900_000_000_000;
const lobbyNonce = new Map();
async function lobbyMove(kind, id, fields, timestamp) {
  const c = await commander(id);
  const n = (lobbyNonce.get(id) ?? 0) + 1;
  lobbyNonce.set(id, n);
  const extra = kind === 'challenge' ? { rounds: fields } : { challenge: fields };
  const sig = await c.sign(duelStatement(DUELS, 'lobby', kind, id, n, fields));
  return entry({ t: kind, id, pub: c.pub, n, ...extra, sig }, timestamp);
}
async function duelMove(duelId, kind, id, round, fields, timestamp) {
  const c = await commander(id);
  const sig = await c.sign(duelStatement(DUELS, duelId, kind, id, round, ...fields));
  const body = { t: kind, id, round, sig };
  if (kind === 'seal') body.hash = fields[0];
  if (kind === 'reveal') { body.move = fields[0]; body.secret = fields[1]; }
  return entry(body, timestamp);
}
async function openDuel(rounds = 5) {
  const lobby = new Lobby(DUELS);
  const ch = await lobbyMove('challenge', 'satya', rounds, D0);
  assert((await lobby.apply(ch, anyone)).accepted);
  const acc = await lobbyMove('accept', 'nova', ch.messageId, D0 + 1000);
  assert((await lobby.apply(acc, anyone)).accepted);
  return { lobby, duel: new Duel(DUELS, ch.messageId, lobby.challenges.get(ch.messageId)), duelId: ch.messageId };
}
const SECRETS = { satya: '11'.repeat(16), nova: '22'.repeat(16) };
async function playRound(duel, duelId, m0, m1, t) {
  const r = duel.round;
  await duel.apply(await duelMove(duelId, 'seal', 'satya', r, [sealHash(DUELS, duelId, r, 'satya', m0, SECRETS.satya)], t));
  await duel.apply(await duelMove(duelId, 'seal', 'nova', r, [sealHash(DUELS, duelId, r, 'nova', m1, SECRETS.nova)], t + 100));
  await duel.apply(await duelMove(duelId, 'reveal', 'satya', r, [m0, SECRETS.satya], t + 200));
  return duel.apply(await duelMove(duelId, 'reveal', 'nova', r, [m1, SECRETS.nova], t + 300));
}

await check('the damage table: shields stop lasers, EMPs stop missiles and break shields', () => {
  eq(damage('laser', 'shield'), 0); eq(damage('missile', 'shield'), 1); eq(damage('missile', 'emp'), 0);
  eq(damage('emp', 'shield'), 3); eq(damage('laser', null), 2); eq(damage('recharge', 'laser'), 0);
});
await check('a challenge is accepted once; not by yourself, and not after it expires', async () => {
  const lobby = new Lobby(DUELS);
  const ch = await lobbyMove('challenge', 'satya', 7, D0);
  assert((await lobby.apply(ch, anyone)).accepted);
  eq((await lobby.apply(await lobbyMove('accept', 'satya', ch.messageId, D0 + 10), anyone)).reason,
    'you cannot accept your own challenge');
  assert((await lobby.apply(await lobbyMove('accept', 'nova', ch.messageId, D0 + 20), anyone)).accepted);
  eq((await lobby.apply(await lobbyMove('accept', 'vega', ch.messageId, D0 + 30), anyone)).reason, 'already accepted');
  const late = await lobbyMove('challenge', 'kepler', 5, D0 + 40);
  await lobby.apply(late, anyone);
  eq((await lobby.apply(await lobbyMove('accept', 'nova', late.messageId, D0 + 40 + DUELS.challengeMs + 1), anyone)).reason,
    'the challenge expired');
});
await check('plugin edition: a call sign belongs to the first key that uses it on the duel chain', async () => {
  const cfg = { ...DUELS, keyBinding: 'first-seen' };
  const lobby = new Lobby(cfg);
  assert((await lobby.apply(await lobbyMove('challenge', 'satya', 5, D0), anyone)).accepted);
  const mallory = await commander('mallory');
  const n = 99;
  const sig = await mallory.sign(duelStatement(cfg, 'lobby', 'challenge', 'satya', n, 5));
  const impostor = entry({ t: 'challenge', id: 'satya', pub: mallory.pub, n, rounds: 5, sig }, D0 + 10);
  eq((await lobby.apply(impostor, anyone)).reason, 'that call sign belongs to another key on this chain');
  assert((await new Lobby(DUELS).apply(impostor, anyone)).accepted, 'the browser edition leaves this to the profile check');
});
await check('a round: both seal, both reveal, damage and energy follow the table', async () => {
  const { duel, duelId } = await openDuel();
  const r = await playRound(duel, duelId, 'laser', 'recharge', D0 + 2000);
  eq(r.settled.length, 1);
  const die = rollDie(DUELS, duelId, 1, SECRETS.satya, SECRETS.nova);
  eq(r.settled[0].die, die);
  eq(duel.hp[1], DUELS.hp - (die === 6 ? 3 : 2));
  eq(duel.energy[1], DUELS.energy.start + 2);
  eq(duel.round, 2);
});
await check('a reveal must match its seal; nobody can switch moves after seeing the other', async () => {
  const { duel, duelId } = await openDuel();
  await duel.apply(await duelMove(duelId, 'seal', 'satya', 1, [sealHash(DUELS, duelId, 1, 'satya', 'shield', SECRETS.satya)], D0 + 2000));
  await duel.apply(await duelMove(duelId, 'seal', 'nova', 1, [sealHash(DUELS, duelId, 1, 'nova', 'missile', SECRETS.nova)], D0 + 2100));
  await duel.apply(await duelMove(duelId, 'reveal', 'nova', 1, ['missile', SECRETS.nova], D0 + 2200));
  eq((await duel.apply(await duelMove(duelId, 'reveal', 'satya', 1, ['emp', SECRETS.satya], D0 + 2300))).reason,
    'the reveal does not match the seal');
});
await check('a reveal before both seals are final is refused', async () => {
  const { duel, duelId } = await openDuel();
  await duel.apply(await duelMove(duelId, 'seal', 'satya', 1, [sealHash(DUELS, duelId, 1, 'satya', 'laser', SECRETS.satya)], D0 + 2000));
  eq((await duel.apply(await duelMove(duelId, 'reveal', 'satya', 1, ['laser', SECRETS.satya], D0 + 2100))).reason,
    'nothing to reveal yet');
});
await check('a missed reveal forfeits the round once its deadline passes in block time', async () => {
  const { duel, duelId } = await openDuel();
  await duel.apply(await duelMove(duelId, 'seal', 'satya', 1, [sealHash(DUELS, duelId, 1, 'satya', 'laser', SECRETS.satya)], D0 + 2000));
  await duel.apply(await duelMove(duelId, 'seal', 'nova', 1, [sealHash(DUELS, duelId, 1, 'nova', 'laser', SECRETS.nova)], D0 + 2100));
  await duel.apply(await duelMove(duelId, 'reveal', 'satya', 1, ['laser', SECRETS.satya], D0 + 2200));
  const early = await duel.apply(await duelMove(duelId, 'forfeit', 'satya', 1, [], D0 + 2100 + DUELS.revealMs));
  eq(early.settled.length, 0, 'the deadline has not passed yet');
  const claim = await duel.apply(await duelMove(duelId, 'forfeit', 'satya', 1, [], D0 + 2100 + DUELS.revealMs + 1));
  eq(claim.settled.length, 1);
  eq(claim.settled[0].forfeited[1], true);
  eq(duel.hp[1], DUELS.hp - DUELS.forfeitDamage);
});
await check('when sealing times out, only the commander who did not seal is punished', async () => {
  const { duel, duelId } = await openDuel();
  await duel.apply(await duelMove(duelId, 'seal', 'satya', 1, [sealHash(DUELS, duelId, 1, 'satya', 'laser', SECRETS.satya)], D0 + 2000));
  const r = await duel.apply(await duelMove(duelId, 'forfeit', 'satya', 1, [], D0 + 1000 + DUELS.sealMs + 1));
  eq(JSON.stringify(r.settled[0].forfeited), JSON.stringify([false, true]));
  eq(duel.hp[0], DUELS.hp, 'the commander who sealed takes nothing');
  eq(duel.hp[1], DUELS.hp - DUELS.forfeitDamage);
});
await check('a missed seal forfeits too, and an unaffordable move counts as a forfeit', async () => {
  const { duel, duelId } = await openDuel();
  await duel.apply(await duelMove(duelId, 'seal', 'nova', 1, [sealHash(DUELS, duelId, 1, 'nova', 'laser', SECRETS.nova)], D0 + 2000));
  const r = await duel.apply(await duelMove(duelId, 'forfeit', 'nova', 1, [], D0 + 1000 + DUELS.sealMs + 1));
  eq(r.settled[0].forfeited[0], true, 'satya never sealed');
  eq(duel.hp[0], DUELS.hp - DUELS.forfeitDamage);
  // round 2 started at the deadline; satya has 2 energy, so a missile is fine but two are not
  const t = D0 + 1000 + DUELS.sealMs + 10;
  await playRound(duel, duelId, 'missile', 'laser', t);
  const third = await playRound(duel, duelId, 'missile', 'laser', t + 1000);
  eq(third.settled[0].forfeited[0], true, 'no energy left for a second missile');
});
await check('the duel ends at the last round or zero HP, and two browsers agree', async () => {
  const run = async () => {
    const { duel, duelId } = await openDuel(5);
    const plan = [['missile', 'shield'], ['recharge', 'laser'], ['missile', 'emp'], ['laser', 'laser'], ['laser', 'recharge']];
    let t = D0 + 2000;
    for (const [a, b] of plan) { await playRound(duel, duelId, a, b, t); t += 1000; }
    return duel;
  };
  height = 10_000;
  const one = await run();
  height = 10_000;
  const two = await run();
  eq(one.done, true);
  eq(JSON.stringify([one.hp, one.energy, one.winner]), JSON.stringify([two.hp, two.energy, two.winner]));
  eq(one.history.length, 5);
});


console.log('comet derby');

const RACE = 30_000_000; // a race slot index; its hour follows
const DH = Math.floor((RACE * DERBY.raceMs) / DERBY.hourMs);
const RT = RACE * DERBY.raceMs; // the slot's start
const HROOT = (k) => k.repeat(64).slice(0, 64);
let betNonce = 0;
async function bet(id, comet, stake, race = RACE) {
  const c = await commander(id);
  const n = ++betNonce;
  const sig = await c.sign(betStatement(DERBY, DH, id, n, race, comet, stake));
  return { t: 'bet', id, pub: c.pub, n, race, comet, stake, sig };
}
const rooted = (e, root) => ({ ...e, stateRoot: root });

await check('a race is an integer simulation: the same seed gives the same race everywhere', () => {
  const seed = raceSeed(DERBY, RACE, HROOT('a'));
  const one = runRace(seed);
  const two = runRace(seed);
  eq(JSON.stringify(one.order), JSON.stringify(two.order));
  eq(one.order.length, 6);
  eq(new Set(one.order).size, 6);
  assert(one.ticks > 900 && one.ticks < 2400, `ticks ${one.ticks}`);
  const winners = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => runRace(raceSeed(DERBY, RACE, HROOT(k))).order[0]));
  assert(winners.size > 1, 'different beacons give different winners');
});
await check('bets close at 45 s; the first block after the close is the beacon and seeds the race', async () => {
  height = 20_000;
  const d = new Derby(DERBY, DH);
  assert((await d.apply(rooted(entry(await bet('satya', 0, 100), RT + 5000), HROOT('1')), anyone)).accepted);
  assert((await d.apply(rooted(entry(await bet('nova', 1, 300), RT + 30_000), HROOT('2')), anyone)).accepted);
  const late = await d.apply(rooted(entry(await bet('vega', 2, 50), raceClose(DERBY, RACE) + 10), HROOT('3')), anyone);
  eq(late.accepted, false);
  eq(late.settled.length, 1, 'the late bet’s block is the beacon');
  const rec = d.races.get(RACE);
  eq(rec.beacon.stateRoot, HROOT('3'));
  eq(rec.beacon.seed, toHex(raceSeed(DERBY, RACE, HROOT('3'))));
  eq(rec.result.winner, runRace(raceSeed(DERBY, RACE, HROOT('3'))).order[0]);
  eq(late.reason, 'betting had closed when this was final');
});
await check('pari-mutuel payouts: winners split the whole pool; nobody backing the winner refunds everyone', async () => {
  height = 21_000;
  // find a beacon root whose race comet 0 wins, and one where comet 5 wins
  const rootFor = (comet) => { for (let k = 0; ; k++) { const r = toHex(blake2b(utf8(`w${k}`), 32)); if (runRace(raceSeed(DERBY, RACE, r)).order[0] === comet) return r; } };
  const d = new Derby(DERBY, DH);
  await d.apply(rooted(entry(await bet('satya', 0, 100), RT + 1000), HROOT('1')), anyone);
  await d.apply(rooted(entry(await bet('nova', 0, 300), RT + 2000), HROOT('2')), anyone);
  await d.apply(rooted(entry(await bet('vega', 3, 200), RT + 3000), HROOT('3')), anyone);
  await d.apply(rooted(entry({ t: 'go' }, raceClose(DERBY, RACE) + 500), rootFor(0)), anyone);
  eq(d.balance('satya'), 1000 - 100 + 150, 'satya: 100 × 600 / 400');
  eq(d.balance('nova'), 1000 - 300 + 450);
  eq(d.balance('vega'), 800);
  const e = new Derby(DERBY, DH);
  await e.apply(rooted(entry(await bet('satya', 0, 100), RT + 1000), HROOT('1')), anyone);
  await e.apply(rooted(entry({ t: 'go' }, raceClose(DERBY, RACE) + 500), rootFor(5)), anyone);
  eq(e.balance('satya'), 1000, 'refunded');
  eq(e.races.get(RACE).result.refunded, true);
});
await check('stakes are bounded by the rules and by your credits; replays and other keys are refused', async () => {
  height = 22_000;
  const d = new Derby(DERBY, DH);
  eq((await d.apply(rooted(entry(await bet('satya', 0, 501), RT + 1000), HROOT('1')), anyone)).reason, 'stakes are 10–500');
  eq((await d.apply(rooted(entry(await bet('satya', 9, 50), RT + 1100), HROOT('1')), anyone)).reason, 'no such comet');
  for (let i = 0; i < 2; i++) assert((await d.apply(rooted(entry(await bet('satya', 1, 500), RT + 1200 + i), HROOT('1')), anyone)).accepted);
  eq((await d.apply(rooted(entry(await bet('satya', 1, 10), RT + 1300), HROOT('1')), anyone)).reason, 'not enough credits');
  const replay = await bet('nova', 1, 50);
  assert((await d.apply(rooted(entry(replay, RT + 1400), HROOT('1')), anyone)).accepted);
  eq((await d.apply(rooted(entry(replay, RT + 1500), HROOT('1')), anyone)).reason, 'stale nonce (replayed)');
  const forged = { ...(await bet('nova', 2, 20)), pub: (await commander('mallory')).pub };
  eq((await d.apply(rooted(entry(forged, RT + 1600), HROOT('1')), anyone)).reason, 'signature does not verify');
});
await check('a race with no beacon before the hour ends is void and refunded', async () => {
  height = 23_000;
  const lastRace = Math.floor(((DH + 1) * DERBY.hourMs) / DERBY.raceMs) - 1;
  const d = new Derby(DERBY, DH);
  assert((await d.apply(rooted(entry(await bet('satya', 0, 200, lastRace), lastRace * DERBY.raceMs + 100), HROOT('1')), anyone)).accepted);
  eq(d.balance('satya'), 800);
  eq(d.closeHour().length, 1);
  eq(d.balance('satya'), 1000);
});

console.log('reef');

const XSEASON = 1_500_000;
const XS0 = XSEASON * REEF.seasonMs;
let reefNonce = 0;
async function seed(id, pattern, x, y, rot = 0) {
  const c = await commander(id);
  const n = ++reefNonce;
  const sig = await c.sign(seedStatement(REEF, XSEASON, id, n, pattern, x, y, rot));
  return { t: 'seed', id, pub: c.pub, n, pattern, x, y, rot, sig };
}

await check('the world rules: a blinker blinks, a glider glides, newborns take the majority species', () => {
  const W = REEF.width;
  const blank = () => new Uint8Array(W * REEF.height);
  const blinker = blank();
  for (const x of [10, 11, 12]) blinker[20 * W + x] = 1;
  const b1 = step(REEF, blinker, 1);
  eq([b1[19 * W + 11], b1[20 * W + 11], b1[21 * W + 11], b1[20 * W + 10]].join(), '1,1,1,0');
  eq(worldHash(step(REEF, b1, 2)), worldHash(blinker));
  const g = blank();
  stamp(REEF, g, { pattern: 'glider', rot: 0, x: 5, y: 5, species: 2 });
  let w = g;
  for (let i = 1; i <= 4; i++) w = step(REEF, w, i);
  const moved = blank();
  stamp(REEF, moved, { pattern: 'glider', rot: 0, x: 6, y: 6, species: 2 });
  eq(worldHash(w), worldHash(moved), 'one cell diagonally every 4 generations');
  const mixed = blank();
  mixed[0 * W + 1] = 3; mixed[1 * W + 0] = 3; mixed[1 * W + 2] = 4;
  eq(step(REEF, mixed, 1)[1 * W + 1], 3, 'two of three parents are species 3');
  eq(shape('glider', 1).length, 5);
});
await check('placements land at the generation their certified time names, paid for in spores', async () => {
  height = 30_000;
  const r = new Reef(REEF, XSEASON);
  const open = await r.apply(rooted(entry({ t: 'open' }, XS0 + 1000), HROOT('a')), anyone);
  eq(open.opened, true);
  const p = await r.apply(rooted(entry(await seed('satya', 'acorn', 40, 40), XS0 + 1000 + 2 * REEF.genMs + 50), HROOT('b')), anyone);
  eq(p.placement.gen, 3);
  eq(p.placement.species, 1);
  const q = await r.apply(rooted(entry(await seed('satya', 'acorn', 60, 40), XS0 + 1700), HROOT('c')), anyone);
  assert(q.accepted, 'a second acorn spends the last 3 spores');
  eq(r.players.get('satya').spores, 0, 'started with 6, spent 3 + 3');
  eq((await r.apply(rooted(entry(await seed('satya', 'glider', 1, 1), XS0 + 1800), HROOT('d')), anyone)).reason, 'needs 1 spores, has 0');
  assert((await r.apply(rooted(entry(await seed('satya', 'glider', 1, 1), XS0 + 1700 + REEF.spores.regenMs), HROOT('e')), anyone)).accepted,
    'a spore regrows every 3 s');
  const gun = await r.apply(rooted(entry(await seed('nova', 'gun', 1, 1), XS0 + 9000), HROOT('f')), anyone);
  eq(gun.reason, 'needs 8 spores, has 6');
  eq(r.players.size, 1, 'a refused first placement does not claim a species');
});
await check('six species per season; nothing after the season ends; a forged placement is refused', async () => {
  height = 31_000;
  const r = new Reef(REEF, XSEASON);
  await r.apply(rooted(entry({ t: 'open' }, XS0 + 10), HROOT('a')), anyone);
  for (const id of ['p1-x', 'p2-x', 'p3-x', 'p4-x', 'p5-x', 'p6-x']) {
    assert((await r.apply(rooted(entry(await seed(id, 'glider', 3, 3), XS0 + 2000), HROOT('b')), anyone)).accepted);
  }
  eq((await r.apply(rooted(entry(await seed('p7-x', 'glider', 3, 3), XS0 + 2100), HROOT('c')), anyone)).reason, 'the reef is full this season');
  const forged = { ...(await seed('p1-x', 'glider', 9, 9)), pub: (await commander('mallory')).pub };
  eq((await r.apply(rooted(entry(forged, XS0 + 2200), HROOT('c')), anyone)).reason, 'signature does not verify');
  eq((await r.apply(rooted(entry(await seed('p1-x', 'glider', 3, 3), XS0 + REEF.seasonMs + 5), HROOT('d')), anyone)).reason, 'outside this season');
});
await check('time travel: the world at any generation is the same however you get there', async () => {
  height = 32_000;
  const r = new Reef(REEF, XSEASON);
  await r.apply(rooted(entry({ t: 'open' }, XS0 + 10), HROOT('a')), anyone);
  await r.apply(rooted(entry(await seed('satya', 'rpent', 80, 50), XS0 + 10 + 30 * REEF.genMs), HROOT('b')), anyone);
  await r.apply(rooted(entry(await seed('nova', 'lwss', 20, 20), XS0 + 10 + 120 * REEF.genMs), HROOT('c')), anyone);
  // by hand
  let cells = soup(REEF, fromHex(r.origin.seed));
  for (let g = 1; g <= 300; g++) {
    cells = step(REEF, cells, g);
    for (const p of r.byGen.get(g) ?? []) stamp(REEF, cells, p);
  }
  const t1 = new Timeline(REEF, r);
  eq(worldHash(t1.at(300)), worldHash(cells), 'forward');
  t1.at(260);
  eq(worldHash(t1.at(300)), worldHash(cells), 'back to 260, then forward again');
  const t2 = new Timeline(REEF, r);
  for (let g = 0; g <= 300; g += 7) t2.at(g, 3); // a budgeted catch-up
  eq(worldHash(t2.at(300)), worldHash(cells), 'in small budgeted steps');
  eq(t1.populations.length, 301);
  eq(census(cells)[1] > 0 && census(cells)[2] > 0, true, 'both species alive');
  // a late placement rewrites the future, not the past
  const before = worldHash(t1.at(100));
  await r.apply(rooted(entry(await seed('satya', 'glider', 10, 70), XS0 + 10 + 200 * REEF.genMs), HROOT('d')), anyone);
  t1.invalidateFrom(r.placements.at(-1).gen);
  eq(worldHash(t1.at(100)), before);
  assert(worldHash(t1.at(300)) !== worldHash(cells), 'the future changed');
});

console.log('deep sonar');

const SR = rng(new Uint8Array(16).fill(9));
const fleetOf = (secret) => { const board = randomFleet(SONAR, SR.int); return { board, secret, root: fleetRoot(SONAR, board, secret) }; };
let sonarNonce = 0;
async function sonarLobby(kind, id, fleet, challenge) {
  const c = await commander(id);
  const n = ++sonarNonce;
  const fields = kind === 'challenge' ? [n, fleet.root] : [n, challenge, fleet.root];
  const sig = await c.sign(sonarStatement(SONAR, 'lobby', kind, id, ...fields));
  return { t: kind, id, pub: c.pub, n, root: fleet.root, ...(challenge ? { challenge } : {}), sig };
}
async function sonarMove(battleId, kind, id, fields, body) {
  const c = await commander(id);
  const sig = await c.sign(sonarStatement(SONAR, battleId, kind, id, ...fields));
  return { t: kind, id, ...body, sig };
}
const shot = (bid, id, k, cell) => sonarMove(bid, 'shot', id, [k, cell], { k, cell });
const answer = (bid, id, k, a) => sonarMove(bid, 'answer', id, [k, a.cell, a.ship, a.salt], { k, cell: a.cell, ship: a.ship, salt: a.salt, path: a.path });
async function openBattle(fa, fb, t0) {
  const lob = new SonarLobby(SONAR);
  const ch = entry(await sonarLobby('challenge', 'satya', fa), t0);
  await lob.apply(ch, anyone);
  const acc = entry(await sonarLobby('accept', 'nova', fb, ch.messageId), t0 + 1000);
  assert((await lob.apply(acc, anyone)).accepted);
  return new Battle(SONAR, ch.messageId, lob.challenges.get(ch.messageId));
}

await check('a fleet is a Merkle root: honest answers verify, a lie does not', () => {
  const f = fleetOf('cd'.repeat(32));
  assert(validFleet(SONAR, f.board));
  const levels = merkleLevels(SONAR, f.board, f.secret);
  for (let c = 0; c < 100; c++) {
    const a = answerFor(SONAR, f.board, f.secret, c, levels);
    assert(verifyAnswer(SONAR, f.root, c, a.ship, a.salt, a.path), `cell ${c}`);
  }
  const shipCell = f.board.findIndex((v) => v > 0);
  const a = answerFor(SONAR, f.board, f.secret, shipCell, levels);
  eq(verifyAnswer(SONAR, f.root, shipCell, 0, a.salt, a.path), false, '“miss” on a ship cell');
  const bent = [...f.board];
  bent[bent.indexOf(5)] = 0;
  eq(validFleet(SONAR, bent), false);
});
await check('a battle: alternate shots, proven answers, a refused lie, sinking the fleet, reveals and the result', async () => {
  height = 40_000;
  const fa = fleetOf('a1'.repeat(32));
  const fb = fleetOf('b2'.repeat(32));
  const T = 2_000_000_000_000;
  const b = await openBattle(fa, fb, T);
  const id = b.battleId;
  let t = T + 2000;
  eq((await b.apply(entry(await shot(id, 'nova', 1, 0), t))).reason, 'not your turn to fire');
  const shipsB = fb.board.flatMap((v, i) => (v ? [i] : []));
  const watersA = fa.board.flatMap((v, i) => (v ? [] : [i]));
  for (let k = 0; k < 17; k++) {
    // satya fires at nova's ships; nova answers
    const kk = b.k;
    assert((await b.apply(entry(await shot(id, 'satya', kk, shipsB[k]), t += 500))).accepted);
    if (k === 0) {
      const lie = { ...answerFor(SONAR, fb.board, fb.secret, shipsB[0]), ship: 0 };
      eq((await b.apply(entry(await answer(id, 'nova', kk, lie), t += 500))).reason, 'the answer does not match the committed fleet');
    }
    const r = await b.apply(entry(await answer(id, 'nova', kk, answerFor(SONAR, fb.board, fb.secret, shipsB[k])), t += 500));
    assert(r.accepted && r.record.ship > 0, 'hit');
    if (b.phase === 'reveal') break;
    // nova fires at satya's water; satya answers
    const k2 = b.k;
    assert((await b.apply(entry(await shot(id, 'nova', k2, watersA[k]), t += 500))).accepted);
    if (k === 0) eq((await b.apply(entry(await shot(id, 'nova', k2, watersA[k]), t += 10))).reason, 'not your turn to fire');
    assert((await b.apply(entry(await answer(id, 'satya', k2, answerFor(SONAR, fa.board, fa.secret, watersA[k])), t += 500))).accepted);
  }
  eq(b.phase, 'reveal');
  eq(b.hits[1], 17);
  eq(b.shots.filter((s) => s.sunk).length, 5, 'five ships sunk');
  const reveal = (who, f) => sonarMove(id, 'reveal', who, [f.board.join(''), f.secret], { board: f.board.join(''), secret: f.secret });
  assert((await b.apply(entry(await reveal('nova', fb), t += 500))).accepted);
  assert((await b.apply(entry(await reveal('satya', fa), t += 500))).accepted);
  eq(b.done, true);
  eq(b.winner, 0);
});
await check('a cheater’s fleet is caught: too few ship cells by the answers, a bad board at the reveal, a missed deadline', async () => {
  height = 41_000;
  const T = 2_100_000_000_000;
  const fa = fleetOf('a3'.repeat(32));
  // nova commits to an empty sea
  const empty = { board: new Array(100).fill(0), secret: 'b4'.repeat(32) };
  empty.root = fleetRoot(SONAR, empty.board, empty.secret);
  const b = await openBattle(fa, empty, T);
  const id = b.battleId;
  let t = T + 2000;
  const watersA = fa.board.flatMap((v, i) => (v ? [] : [i]));
  for (let k = 0; !b.done; k++) {
    await b.apply(entry(await shot(id, 'satya', b.k, k), t += 300));
    await b.apply(entry(await answer(id, 'nova', b.k, answerFor(SONAR, empty.board, empty.secret, k)), t += 300));
    if (b.done) break;
    await b.apply(entry(await shot(id, 'nova', b.k, watersA[k]), t += 300));
    await b.apply(entry(await answer(id, 'satya', b.k, answerFor(SONAR, fa.board, fa.secret, watersA[k])), t += 300));
  }
  eq(b.winner, 0);
  assert(/fewer ship cells/.test(b.reason), b.reason);
  eq(b.known[1].size, 84, 'caught at the 84th water answer');
  // a missed deadline loses, settled by the next message's certified time
  const c = await openBattle(fleetOf('a5'.repeat(32)), fleetOf('b6'.repeat(32)), T + 1e7);
  const late = await c.apply(entry(await sonarMove(c.battleId, 'forfeit', 'nova', [1], { k: 1 }), T + 1e7 + 1000 + SONAR.shotMs + 5000));
  eq(late.expired, 'timeout');
  eq(c.winner, 1);
});


console.log('neon rush');

const MS = 2_000_000;
const MT = MS * MOTO.seasonMs;
MOTO.generationId = '11'.repeat(32);
const motoIssuer = signerFromKey(await createSessionKey());
const motoSession = signerFromKey(await createSessionKey());
const motoDelegation = await issueDelegation({ chainId: MOTO.movesChain, generationId: MOTO.generationId,
  delegate: motoSession.publicKey, scope: 'games/neon-rush/', notBefore: MT, notAfter: MT + 3600000, issuer: motoIssuer });
async function motoEntry(move, timestamp, index = 0) {
  const record = entry(move, timestamp, index);
  record.bodyHex = hex(await signWrite({ chainId: MOTO.movesChain, generationId: MOTO.generationId,
    topic: `games/neon-rush/s${MS}`, payload: encodeCanonicalValue(move),
    nonce: record.height.toString(16).padStart(32, '0'), notAfter: MT + 3600000, delegation: motoDelegation }, [motoSession]));
  return record;
}
const ride = (track, steer = rider) => { const r = new Ride(track); const f = []; while (!r.over) { const b = steer(r); f.push(b); r.step(b); } return { frames: Uint8Array.from(f), finished: r.finished }; };
let rideNonce = 0;
async function rideRun(id, circuit, frames, claimed, seed = circuit.seed) {
  const c = await commander(id);
  const encoded = encodeInputs(frames);
  const n = ++rideNonce;
  const sig = await c.sign(rideStatement(MOTO, MS, seed, id, n, rideHash(encoded), claimed));
  return { t: 'run', id, pub: c.pub, n, seed, inputs: toHex(encoded), frames: claimed, sig };
}

await check('the city circuit comes from the seed: the same seed gives the same circuit', () => {
  const a = new Track(fromHex(circuitSeed(MOTO, MS, HROOT('a'))));
  const b = new Track(fromHex(circuitSeed(MOTO, MS, HROOT('a'))));
  const c = new Track(fromHex(circuitSeed(MOTO, MS, HROOT('b'))));
  const shape = (t) => JSON.stringify([t.segments.map((s) => s.curve), t.cars]);
  eq(shape(a), shape(b));
  assert(shape(a) !== shape(c), 'another root, another circuit');
  eq(a.segments.length, 640);
});
await check('a ride replays to the same frame; changed or cut inputs do not reach the same finish', () => {
  const track = new Track(fromHex(circuitSeed(MOTO, MS, HROOT('c'))));
  const { frames, finished } = ride(track);
  assert(finished && finished < 60 * 60, `finished at ${finished}`);
  eq(replayRide(track, frames).finished, finished);
  eq(replayRide(track, frames.slice(0, finished - 30)).finished, null, 'stopping short never finishes');
  const lazy = ride(track, () => GAS);
  assert(lazy.finished === null || lazy.finished > finished, 'flat out into every bend and car is slower');
});
await check('the season: a run counts only if its inputs replay to the claimed time; splits show riders live', async () => {
  height = 50_000;
  const circuit = new Circuit(MOTO, MS);
  const opened = await circuit.apply(rooted(await motoEntry({ t: 'open' }, MT + 1000), HROOT('d')), anyone);
  eq(opened.opened, true);
  const { frames, finished } = ride(circuit.track);
  const nova = await commander('nova');
  const splitSig = await nova.sign(splitStatement(MOTO, MS, 'nova', 1, 7, 3, 900));
  assert((await circuit.apply(rooted(await motoEntry({ t: 'split', id: 'nova', pub: nova.pub, n: 1, run: 7, cp: 3, frame: 900, sig: splitSig }, MT + 2000), HROOT('e')), anyone)).accepted);
  eq(circuit.liveRiders(MT + 3000).length, 1);
  const faster = await circuit.apply(rooted(await motoEntry(await rideRun('nova', circuit, frames, finished - 60), MT + 3000), HROOT('f')), anyone);
  eq(faster.accepted, false);
  assert(/does not replay/.test(faster.reason) || /bad inputs/.test(faster.reason), faster.reason);
  const honest = await rideRun('nova', circuit, frames, finished);
  const r = await circuit.apply(rooted(await motoEntry(honest, MT + 4000), HROOT('g')), anyone);
  assert(r.accepted, r.reason);
  eq(circuit.leaderboard()[0].frames, finished);
  eq(circuit.liveRiders(MT + 5000).length, 0, 'a finished rider is no longer live');
  eq((await circuit.apply(rooted(await motoEntry(honest, MT + 5000), HROOT('h')), anyone)).reason, 'stale nonce (replayed)');
  const elsewhere = await rideRun('satya', circuit, frames, finished, '00'.repeat(16));
  eq((await circuit.apply(rooted(await motoEntry(elsewhere, MT + 6000), HROOT('i')), anyone)).reason, 'ridden on another circuit');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
