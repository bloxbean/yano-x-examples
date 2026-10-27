# 21 — Anchor Games (a game center on app ledgers)

One commander account, several browser games. Every move is a message on a
Yano X app ledger, final in about a second; every browser computes the same
game from the finalized log, with no game server; and the ledgers are sealed
on Cardano in the background. Any move, run or profile can be proven against
the Cardano anchor from inside the game.

The games use static HTML, CSS and ES modules with no build step or npm
install. Neon Rush additionally uses the small external
[delegation service](delegation/README.md) to authorize temporary session keys.

| Game | What it is | What the ledger does |
|---|---|---|
| [Anchor Galaxy](galaxy/) | Real-time space conquest: drag fleets of rockets between planets; 5-minute rounds, up to 8 commanders | Orders every launch; every browser simulates the same battles |
| [Anchor Arcade](arcade/) | A 60-second rocket shooter on a field of rocks, racing the ghosts of the best runs | Seeds each field, orders submitted runs; every browser replays every run, so scores cannot be faked |
| [Sealed Duels](duels/) | 1 v 1 rocket duels: both sides seal a move, then reveal; best of 5 or 7 | Orders seals before reveals, so nobody can peek or change their mind; the dice come from both players' secrets |
| [Sealed Duels · plugin edition](duels/?engine=plugin) | The same duels on a chain of their own | **Runs the rules itself:** a Java state machine ([`plugin/`](plugin/)) refuses broken moves and commits each duel to the state root |
| [Comet Derby](derby/) | Bet credits on six comets racing round a sun; a race every 75 s, everyone at once | **A random beacon nobody controls:** each race is seeded by a block certified after betting closed; every browser runs the same race and pays the same pool |
| [Reef](reef/) | Drop gliders, spaceships and glider guns into a shared multi-species Game of Life; 20-minute seasons | **The log is the world:** a few kilobytes of placements grow 16,000 cells on certified block time, identically everywhere — and any generation can be rebuilt (time travel) |
| [Deep Sonar](sonar/) | Battleship with hidden fleets, 1 v 1, 40 s turns | **Hidden information, no referee:** each fleet is a Merkle root; every hit or miss arrives with a Merkle proof against it |
| [Neon Rush](moto/) | A night-city motorbike time trial: two laps of neon streets, traffic and slipstreams; 15-minute seasons | **Replay-verified times, live rivals:** each circuit comes from a block; you submit inputs, every browser replays them for your time, and signed checkpoint splits show riders on your road about a second later |
| [Land Rush](land/) | Found a capital and grow a realm on a hex map; hourly seasons, everyone at once | **Enforces the core rule itself:** each tile is a `PUT_IF_ABSENT`, so the members refuse a second claim; free tiles can be proven free |

| | |
|---|---|
| Accounts | call sign + password, on `authenticated-map-chain` (`attachments` collection); the password never leaves the browser |
| Moves | `orders-chain` for most games; `neon-rush-chain` for protected Neon Rush topics; Land Rush claims on `authenticated-map-chain`; the duels' plugin edition on `duels-chain` |
| Finality | a threshold of members, about one block a second |
| Anchoring | Cardano (devnet locally, preprod on the showcase), in the background |
| Dependencies | none — WebCrypto (Ed25519, PBKDF2, AES-GCM) plus small CBOR and BLAKE2b helpers |

## Play locally

```bash
(cd plugin && ./gradlew build)   # the sealed-duels plugin for duels-chain (Java 25)
./cluster start 3          # four chains; devnet anchoring (~1 min first time)
YANO_NODES=http://127.0.0.1:7210,http://127.0.0.1:7211,http://127.0.0.1:7212 node serve.mjs
# open http://localhost:8787/?proxy=1
```

Create a commander on the hub page, then pick a game; the sign-in carries to
every game (same origin, same `localStorage`). To play against yourself, open
`http://127.0.0.1:8787/?proxy=1` too — a different origin, so a separate
browser identity.

Neon Rush requires its fresh-chain topic setup and service configuration in
[delegation/README.md](delegation/README.md). The page reports a missing setup
instead of sending unframed writes. The configured public showcase has not
been changed by this reference implementation.

```bash
./cluster stop             # keep the chains and the commanders
./cluster clean            # stop and wipe .yano/
```

`./cluster start` generates the authenticated-map genesis for the local
membership with the release's own generator and hands it to each node as a
per-node property overlay. The chain file allow-lists the validator bundle,
which authenticated-map requires before it will start, and the duels plugin.
`start` stages the release's plugins plus the duels JAR in
`.yano/node-plugins/`, leaving the distribution untouched.

A cluster started before `duels-chain` existed keeps its chains:
`./cluster stop && ./cluster migrate && ./cluster start 3` appends the new
chain and leaves the others at their heights. See
[ADD_A_CHAIN.md](ADD_A_CHAIN.md), which also covers the showcase.

Against the showcase: `node serve.mjs` without `YANO_NODES` proxies the five
showcase members, which run both stock chains with the same `attachments`
collection. They do not run `duels-chain` until it is installed there
([ADD_A_CHAIN.md](ADD_A_CHAIN.md)). A copy on GitHub Pages needs the members to allow its origin in
CORS (see example 20).

## Commanders: one account for every game

Creating a commander generates a random Ed25519 key in the browser, locks it
with AES-GCM under a key derived from the password (PBKDF2-SHA256, 600,000
rounds), and stores `{call sign, public key, salt, locked key, self-signature}`
with `PUT_IF_ABSENT` — so the ledger itself refuses a taken call sign. Signing
in on another device fetches the profile, re-derives the lock key and unlocks
the signing key. The unlocked key is remembered in `localStorage` until you
sign out.

A game accepts a commander's first move only if the profile holds the move's
key and was registered *before* the move. The two chains share no clock, so
this compares certified block timestamps from both; an absent profile is
certified absent at some height, and if that block is no older than the move,
nothing registered later can count ([`shared/profiles.js`](shared/profiles.js)).

## Anchor Galaxy

Drag from your planet to any planet (or tap one, then the target). Fleets of
small rockets stream across the map; the larger force wins on arrival. The
commander holding the most planets when the round ends wins.

[`galaxy/js/galaxy.js`](galaxy/js/galaxy.js) is a deterministic simulation:
integers only (ships in thousandths), no trigonometry, no wall clock, no
`Math.random`; each round's map comes from BLAKE2b of the round number; fleet
arrivals between blocks are computed exactly from certified time. Between
blocks the page draws a copy run ahead to the present.

| Rule | Why |
|---|---|
| A join must be signed by, and match, the commander's profile key, registered before the join | Nobody can play as you |
| A launch must be signed by the commander, from a planet they hold at that block's time | No moving someone else's ships |
| Nonces strictly increase; a refused move still burns its nonce | Replaying a signed move does nothing |
| At most 6 launches per commander per block; 8 commanders per round | Bounded work per block, a fair map |

**Inspect** (or `i`) any planet to see which finalized move took it — the
join or the capturing launch — and prove it: the move's signature against the
commander's key, the `finalized-message-v1` proof at `latest-confirmed-anchor`,
and the proven root against the Cardano anchor transaction.

## Anchor Arcade

Sixty seconds, ← → to turn, ↑ to thrust, space to fire (touch buttons on
phones). Rocks split as you hit them; quick kills build a combo up to ×8; a
crash costs 250. The best runs on the field race you as translucent ghosts.

**Why the leaderboard can't be faked:**

1. **Seed from the ledger.** Time is cut into 15-minute fields, each with its
   own topic. A field's rocks come from BLAKE2b of the state root of the block
   that finalized its first message — unknowable until that block exists, and
   the same for everyone.
2. **Inputs, not scores.** A run is one input byte per frame (3,600 frames,
   run-length encoded — typically a few hundred bytes to a few kilobytes) plus
   the score you saw, signed by your commander key.
3. **Every browser replays.** [`arcade/js/sim.js`](arcade/js/sim.js) runs at a
   fixed 60 Hz in fixed-point integers, with a sine table baked into the
   source and a seeded xoshiro128** — no `Math.sin`, no `Math.random`. A run
   counts only if replaying its inputs reaches exactly the claimed score.
4. **Sealed on Cardano.** Click any leaderboard name to prove the run: the
   signature, a fresh replay in your browser, the `finalized-message-v1`
   proof, and the anchored root — or ▶ watch the run replayed from the ledger.

What replay does not prove: that a human pressed the keys rather than a bot.

## Land Rush

Click any free tile to found your capital; after that, click glowing tiles
next to your land. Crystal is worth 5, peaks 3, forest 2, plains 1; your score
is your land's value plus 2 × your largest connected realm. Stamina: one claim
every 4 seconds, up to 8 banked.

**The ledger enforces first-come.** A claim is an authenticated-map
`PUT_IF_ABSENT` on the tile's key, so when two commanders click the same tile
in the same second the members apply one and refuse the other with
`ALREADY_EXISTS` — the loser sees "nova reached Ashreach first". No game code
runs on the members; it is the stock machine's rule.
[`land/js/land.js`](land/js/land.js) mirrors that decision while folding the
chain's commands in order, and asks the ledger's receipt for any command shape
it does not mirror itself (a batch, a plain `PUT`).

**Browsers enforce the rest, identically:** a claim's value is
`{"v":1,"id","pub","sig"}`, signed by the commander's key; the commander's
profile must appear earlier in the same log (one chain, so no cross-chain
timing); the first valid claim is the capital, later ones must touch your land;
stamina refills by certified block time. A first claim that breaks a rule still
holds the key on the ledger, so the tile is **scorched** — it counts for nobody
this season.

**Seasons can't be planned or griefed in advance.** Each season's tile keys
and terrain come from the state root of the first block on the chain in that
season (anyone may open a quiet season with a marker write). Until that block
exists, nobody knows the keys, so nobody can pre-claim or pre-scorch the map.

**Proofs, including absence.** Inspect (or `i`) any tile: a claimed tile is
proven at revision 1 — the first and only claim — with the value digest of the
exact signed claim; a free tile is proven **absent** under the root anchored
on Cardano (an exclusion proof).

## Sealed Duels

Post a challenge (best of 5 or 7) in the lobby, or accept one — the first
valid accept on the ledger wins it, and both browsers jump into the duel. Each
round you pick Laser, Missile, Shield, EMP or Recharge (energy limits what you
can afford) and press **Seal**.

**Hidden moves without a server.** A seal is `BLAKE2b(move ‖ secret)`, signed by
your commander key; the secret stays in your browser. When both seals are
final, both browsers post their reveals automatically, and every browser checks
each reveal against its seal ([`duels/js/duels.js`](duels/js/duels.js)). Nobody
— not even the members — can see a move before it is revealed, and nobody can
change it after seeing the other's.

**Fair dice.** Each round's die is BLAKE2b of both secrets; a 6 is a critical
hit (×1.5). Neither player, nor any member, can steer it.

**Deadlines in block time.** Seal within 30 s of a round starting, reveal within
15 s of both seals being final. A missed deadline is settled by the next message
on the duel's topic whose certified timestamp is past it — the waiting browser
posts a `forfeit` claim automatically — so every browser settles it
identically. Missing a seal or reveal (or revealing a move you can't afford)
costs 4 HP; sealing in time is never punished.

**Prove a round** from the ledger log: each seal was final before the other's
reveal, each reveal hashes to its seal, the die recomputes from both secrets,
every message is signed, and all four are recorded under the root anchored on
Cardano.

## Comet Derby

Pick a comet and a stake (10–500 credits) while betting is open. Every
commander starts each hour with 1,000 credits; there is no house: the winners
split the whole pool in proportion to their stakes, and if nobody backed the
winner every stake comes back.

**Why nobody can fix a race.** A bet counts only if its block was certified
before the 45 s close. The race's seed is BLAKE2b of the state root of the
first block on the hour's topic certified *after* the close — the "beacon".
That root did not exist while anyone was betting, so no player could know the
outcome; once it is final, every browser agrees on it. Any browser posts a
`{"t":"go"}` after the close so a beacon block always comes.

**Every browser races.** [`derby/js/derby.js`](derby/js/derby.js) is an integer
simulation: six comets, three laps, boost pads, gravity wells that slingshot or
snare, solar flares, drafting — all drawn from a xoshiro128** seeded by the
beacon. Each browser plays the race in sync, starting two seconds after the
beacon block's certified time, and the sidebar keeps the result hidden until
the race has finished on screen.

**Prove a race:** the bet's signature, that it was final before the close, the
beacon block certified after it and its root, the seed recomputed, the race
re-run here with the same winner, the payout from the pool, and the bet and
beacon recorded under the root anchored on Cardano.

## Reef

A 160 × 100 torus runs a multi-species Game of Life (B3/S23; a newborn takes the
species most of its three parents share) at five generations a second of
certified block time. Click to drop a pattern — glider, spaceship,
R-pentomino, diehard, acorn, or a glider gun — paid for in spores that regrow
one every 3 s. Up to six commanders get a species each season; the largest
population at the end wins.

**The log is the world.** Only placements are stored. The season's first block
seeds the primordial soup (BLAKE2b of its state root); a placement joins at the
generation its block's certified timestamp names. Every browser grows the same
16,000 cells from those few kilobytes and shows the same **world hash**.

**Time travel.** Drag the timeline (or ⏮ / ▶) to any generation: it is rebuilt
from the log, with a checkpoint every 50 generations, and the world hash
matches what every other browser gets at that generation. A whole season
recomputes in under a second.

**Proofs:** a placement (its signature, its block, the generation that block
names), or the whole world at the generation on show (the soup's opening
block, every placement up to there, the world hash, and the anchored root).

## Deep Sonar

Battleship against another commander, with no referee and nothing hidden on
a server. Shuffle your fleet, then challenge or accept in the lobby.

**Commit.** Your fleet becomes one hash: the Merkle root of 100 cells (padded to
128 leaves), each leaf BLAKE2b(cell ‖ ship id ‖ salt), with every salt derived
from a secret that stays in your browser. The lobby message carries only the
root.

**Answer with a proof.** Shots alternate. When you are shot at, your page
answers automatically with the cell's ship id, salt and 7-hash path, and every
browser climbs that path to your committed root — so "miss" on a ship cell, or a
ship moved mid-battle, does not hash. The side panel shows each climb. A fleet
with too many cells of a ship, or too few ship cells overall, is caught by the
answers alone. When a fleet is sunk, both pages reveal their whole board and
secret; every browser rebuilds both roots and checks the five straight ships.

**Block-time deadlines:** 40 s to fire, 20 s to answer, 60 s to reveal; a
missed deadline loses, settled by the next message's certified time (the
waiting page posts a claim).

**Prove a shot:** the commitment block before the shot, the leaf and each of
the 7 levels to exactly the committed root, and the commitment, shot and
answer recorded under the root anchored on Cardano. **Prove the result:** both
reveals rebuild their roots, both fleets are legal, and who won.

## Neon Rush

Neon Rush writes canonical CBOR inside session-signed core topic frames on
`neon-rush-chain`, under `games/neon-rush/`. The members enforce the writer
policy, one-hour delegation, payload schema, write expiry and proof replay
checks before storing a move. Commander signatures and replayed game rules
remain browser checks. [Set up the service and policy](delegation/README.md)
before playing; the issuer key stays outside both the static site and members.

Two laps through a neon city at night: ↑ throttle, ↓ brake, ← → lean (touch
buttons on phones). Bends throw you outwards with the square of your speed, so
the tightest ones need you to ease off; tuck in a car's slipstream for a
higher top speed, but touch its bumper and you lose most of it. The ghosts of
the fastest rides race with you.

**A circuit nobody saw coming.** Each 15-minute season has its own topic. The
first message opens it, and BLAKE2b of that block's state root generates the
streets: bends, rolling hills, the traffic and the buildings along the road.
Nobody can practise a circuit before that block exists.

**Inputs, not times.** [`moto/js/sim.js`](moto/js/sim.js) steps the bike at a
fixed 60 Hz in integers from one input byte per frame. A finished ride submits
those bytes (run-length encoded — about 2 KB for two laps) and the frame it
crossed the line, signed by the commander. Every browser replays the inputs on
the season's circuit; a ride counts only if it crosses the line at exactly the
claimed frame ([`moto/js/races.js`](moto/js/races.js)).

**Live in about a second.** Each checkpoint you pass posts a signed split.
About a second later, when its block is final, every other rider's page shows
you on their road and in "Live on the circuit". Splits are only advisory — a
ride's own replay decides its splits.

**Prove a ride:** the circuit's opening block, the signature over the inputs
and time, a fresh replay here crossing the line at the same frame, and the
record under the root anchored on Cardano — or ▶ watch it replayed.

## Sealed Duels · plugin edition

The same game, with the rules moved from the browsers to the members. Open
`duels/?engine=plugin` (or the hub's yellow card). Moves go to `duels-chain`,
whose members run [`plugin/`](plugin/): a Java port of `duels.js` packaged as
a state-machine plugin. The page still runs `duels.js` too, but only to check
the members' work.

| | Browser edition (`orders-chain`) | Plugin edition (`duels-chain`) |
|---|---|---|
| Who runs the rules | every browser | every member; browsers check |
| A forged, foreign or mismatched move | stored, then ignored by every browser | refused before it is stored: `BAD_SIGNATURE`, `NOT_IN_DUEL`, `REVEAL_MISMATCH`… |
| Game state | replayed from the topic in each browser | a committed record, `duel/<id>`, in the state root; `POST …/query/duel` |
| Proving a result | prove every move, recompute every round | one state proof of the record against the anchored root |
| Who owns a call sign | the profile on `authenticated-map-chain` (a cross-chain check) | the first key to use it on `duels-chain`: a machine sees only its own chain |
| Changing the rules | ship new JavaScript under a new `app` id | install a new JAR on every member at once; new logic means a new chain |
| Who can deploy it | anyone with a web page | the members' operators (trusted consensus code) |
| Cost on the members | ordering bytes | an Ed25519 check and some hashing per move, on every member |

What the page shows in this edition:

- **The members' verdict before sending.** The page asks the read-only
  `admit` query on committed state and does not send a refused move. The log
  shows the code. Try editing your saved move in `localStorage` after sealing:
  the reveal comes back `REVEAL_MISMATCH`.
- **The members' record next to your replay.** "Who runs the rules" shows HP,
  energy, round and phase as committed, with the height and root, and says
  whether this browser's replay of the same moves agrees.
- **Prove this duel.** A single state proof of `duel/<id>`, at the anchored
  height once sealed. The value must be this duel's record, between these
  keys, with the result this browser replayed, under the root anchored on
  Cardano. Round proofs use the host's generic message inclusion proof, since
  the stock `finalized-message-v1` subject comes with the stock machines. They
  are tied to the anchor through the same record, which holds every settled
  round.

Both rule sets are pinned to each other. `test/duel-vectors.mjs` runs a
scripted duel full of edge cases through `duels.js` and writes every decision
and the final state. The plugin's tests replay the same messages and must
agree on all of it (see [plugin/README.md](plugin/README.md)).

## Adding a game

1. Create a folder with an `index.html` that links `../shared/base.css` and a
   module that imports from `../../shared/`: `Ledger`, `Session` (sign-in and
   the commander), `ProofPanel`, and `proveProfile` / `typedProof`.
2. Pick an `app` id and topics on `orders-chain`, and write the game as a
   deterministic fold over finalized messages — integer maths, no clock, no
   unseeded randomness — with tests in `test/run.mjs`.
3. Add an entry to `GAMES` in [`shared/config.js`](shared/config.js) and a
   preview in [`hub.js`](hub.js).

## What it does not guarantee

- **The ledger does not enforce game rules — except first-come in Land Rush
  and the duels' plugin edition.** `ordered-log` accepts any move. Invalid ones
  are ignored by every browser identically, but still stored. In Land Rush the
  ledger refuses double claims, but a cheater's invalid claim still occupies
  (scorches) a tile. The plugin edition shows the alternative: the members run
  the rules, at the price of trusted code on every member.
- **The plugin edition binds call signs per chain.** Its machine cannot read
  the profile chain, so whoever first uses a call sign on `duels-chain` owns it
  there. A squatter could take your call sign on that chain before you play
  there.
- **Comet Derby's beacon is only as unpredictable as the block.** No player
  can know a future state root, but the member proposing the beacon block
  chooses which pending messages it includes, and so could try several
  orderings to steer the root. A stronger beacon would mix in a commit–reveal
  among the members or a VRF.
- **Neon Rush's live riders are estimates.** A split says where a rider was;
  the page extrapolates from their average speed until the next one, so a
  live rider can jump slightly when a split arrives. As with the arcade,
  replay cannot tell a human from a bot.
- **Reef and Derby replay their topic on load.** An hour of bets or a season
  of placements is small, but a long-lived world would checkpoint.
- **Deep Sonar needs the browser that holds your fleet.** The board and secret
  live in that browser's `localStorage`; another device cannot answer shots
  for you, and you lose the battle on the answer deadline.
- **Land Rush reads the profiles chain from the start.** Profiles and claims
  share that chain, so a page replays it from height 0 on load. Fine for a
  demo; a long-lived deployment would checkpoint.
- **The locked key is public.** A weak password can be guessed offline, as
  with a leaked password hash; hence the 10-character minimum and 600,000
  rounds. The unlocked key sits in `localStorage` on devices you sign in on.
- **The profile check can wait.** If a browser's view of the profile chain is
  behind a move, it pauses that game's replay and asks again; after six
  seconds it refuses the move. A browser that cannot see a just-registered
  profile for that long would diverge — a gap a game plugin would close.
- **Two devices, one commander.** Nonces come from each device's clock; a
  device whose clock is far behind will have its moves refused as stale.

## Tests

```bash
npm test                                          # 66 game checks + service/session/bootstrap tests; no Yano cluster
node --no-warnings test/duel-vectors.mjs          # rewrite the browser rules' duel vectors for the plugin
(cd plugin && ./gradlew test)                     # the plugin agrees with them (6 tests)
```

The authenticated-map envelope is checked byte for byte against the release
CLI. The rest cover the keystore; Galaxy's simulation (map determinism,
production, arrivals, captures, forged and replayed moves, the cross-chain
profile check, round boundaries, the per-block cap, two replays reaching the
same winner); and the Arcade (the sine table, input encoding, identical
replays, live play equal to replay, field seeding, an honest run accepted, an
inflated score refused, tampered inputs, another field's run, replayed run
messages, and the profile check); and Land Rush (season seeding and maps, the
envelope shape, first claim wins and the loser recorded, profile-before-claim,
forged signatures, adjacency, stamina refills, receipt-settled command shapes,
the season window, scoring, and two replays reaching the same map); and Sealed
Duels (the damage table, lobby acceptance and expiry, reveals bound to seals,
reveal-before-seal refused, deadline forfeits in block time, sealing in time
never punished, unaffordable moves, the plugin edition's call-sign rule, and two
replays agreeing on a whole duel); Comet Derby (deterministic races, the close
and the beacon, pari-mutuel payouts and refunds, stake and credit limits,
replays and forgeries, void races at the hour's end); Reef (blinkers, gliders and
majority births, placements at the generation their time names, spores, six
species, forged and late placements, and time travel reaching the same world
forward, backward and in small budgeted steps); and Deep Sonar (honest Merkle
answers verify and lies do not, fleet legality, a whole battle with a refused
lie, sinking and reveals, a fleet with too few ship cells caught by its answers,
and a missed deadline); and Neon Rush (circuits from seeds, rides replaying to
the same frame while changed or cut inputs do not, a faster claimed time
refused, live splits, replayed and wrong-circuit rides).

## Files

```
index.html, hub.js, hub.css   the game center: sign in once, pick a game
shared/                       what every game uses
  config.js                   members, chains, accounts, the list of games
  auth.js                     the sign-in panel and the commander session
  accounts.js                 PBKDF2 + AES-GCM keystore, profiles
  profiles.js                 profile lookup, registration, the cross-chain check
  proofs.js                   typed proofs, profile proofs, the anchored-root check
  ledger.js                   REST client: by-topic, blocks, submit, SSE, plugin routes
  authmap.js                  PUT_IF_ABSENT bytes and entry decoding
  ui.js, base.css             proof panel, toasts, shared styles
  cbor.js, blake2b.js, crypto.js, rng.js
  neon-auth.js, topic-client/  bound login requests and verified, vendored topic SDK modules
galaxy/                       Anchor Galaxy: galaxy.js (the simulation), render.js, app.js, proofs.js
arcade/                       Anchor Arcade: sim.js (the shooter), runs.js (fields, replay
                              verification, leaderboard), render.js (rockets), app.js, proofs.js
duels/                        Sealed Duels: duels.js (lobby, commit–reveal rounds, deadlines, dice),
                              render.js (the arena), app.js (both editions), proofs.js (round and duel proofs)
plugin/                       the sealed-duels state machine (Java 25, Gradle): Duels.java (the rules),
                              SealedDuelsStateMachineProvider.java (host wiring), tests against the vectors
land/                         Land Rush: land.js (seasons, maps, the claim fold), render.js (hex map),
                              app.js, proofs.js (tile and absence proofs)
derby/                        Comet Derby: derby.js (the race, bets, beacons, payouts), render.js (nebula,
                              comets, particles), app.js, proofs.js (race proofs)
reef/                         Reef: reef.js (the world rules, placements, the timeline), render.js
                              (glowing cells, population chart), app.js, proofs.js (placement and world proofs)
moto/                         Neon Rush: sim.js (the bike, traffic and circuit generator), races.js (rides,
                              splits, leaderboard), render.js (the pseudo-3D city), app.js, proofs.js
sonar/                        Deep Sonar: sonar.js (fleet commitments, Merkle answers, lobby, battle),
                              render.js (your sea and the sonar screen), app.js, proofs.js (shot and battle proofs)
serve.mjs                     static server + same-origin proxy for local play
delegation/                   external key-file service, fresh-chain bootstrap, ride schema, operator runbook
cluster, chain/               local four-chain configuration (Neon topics use a fresh chain)
ADD_A_CHAIN.md                adding duels-chain to a running cluster: local, and the showcase procedure
test/run.mjs                  npm test
test/duel-vectors.mjs         the shared duel vectors for the plugin's tests
test/topics/                  session/service/path/bootstrap tests and isolated three-node V4 driver
scripts/check-topic-client.mjs  vendored SDK digest and optional explicit source comparison
```
