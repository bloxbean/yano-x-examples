# 21 — Anchor Games (a game center on app ledgers)

One commander account, several browser games. Every move is a message on a
Yano X app ledger, final in about a second; every browser computes the same
game from the finalized log, with no game server; and the ledgers are sealed
on Cardano in the background. Any move, run or profile can be proven against
the Cardano anchor from inside the game.

**One state machine, many games, and the player signs.** Seven of the games
share one chain, `games-chain`, running the stock `ordered-log` machine. Its
topic registry protects the `games/` namespace: each game has its own entry
(`games/galaxy/`, `games/arcade/`, …) and every round, field, duel or season is
a topic below it. The members accept a move there only if the player's own
**session key** signed it, under a one-hour credential from the game
publisher's delegation service. Nobody else can move for a player, including the
member that relays the move. See [Session keys](#session-keys-the-player-signs-every-move).

The pages are static HTML, CSS and ES modules, with no build step and no npm
install. The only server-side piece is the small [delegation service](delegation/),
which holds the publisher's issuer key.

Requires **Yano X 0.1.0-pre6** or later (topic policies, ADR-038).

| Game | What it is | What the ledger does |
|---|---|---|
| [Anchor Galaxy](galaxy/) | Real-time space conquest: drag fleets of rockets between planets; 5-minute rounds, up to 8 commanders | Orders every launch; every browser simulates the same battles |
| [Anchor Arcade](arcade/) | A 60-second rocket shooter on a field of rocks, racing the ghosts of the best runs | Seeds each field, orders submitted runs; every browser replays every run, so scores cannot be faked |
| [Sealed Duels](duels/) | 1 v 1 rocket duels: both sides seal a move, then reveal; best of 5 or 7 | Orders seals before reveals, so nobody can peek or change their mind; the dice come from both players' secrets |
| [Sealed Duels · plugin edition](duels/?engine=plugin) | The same duels on a chain of their own | **Runs the rules itself:** a Java state machine ([`plugin/`](plugin/)) refuses broken moves and commits each duel to the state root |
| [Comet Derby](derby/) | Bet credits on six comets racing round a sun; a race every 75 s, everyone at once | **A random beacon nobody controls:** each race is seeded by a block certified after betting closed; every browser runs the same race and pays the same pool |
| [Reef](reef/) | Drop gliders, spaceships and glider guns into a shared multi-species Game of Life; 20-minute seasons | **The log is the world:** a few kilobytes of placements grow 16,000 cells on certified block time, identically everywhere — and any generation can be rebuilt (time travel) |
| [Deep Sonar](sonar/) | Battleship with hidden fleets, 1 v 1, 40 s turns | **Hidden information, no referee:** each fleet is a Merkle root; every hit or miss arrives with a Merkle proof against it |
| [Neon Rush](moto/) | A night-city motorbike time trial: two laps of neon streets, traffic and slipstreams; 15-minute seasons | **Replay-verified times, live rivals:** each circuit comes from a block; you submit inputs, every browser replays them for your time, and signed checkpoint splits show riders on your road about a second later. **Race lobbies** gather riders and start them together at a ledger time |
| [Land Rush](land/) | Found a capital and grow a realm on a hex map; hourly seasons, everyone at once | **Enforces the core rule itself:** each tile is a `PUT_IF_ABSENT`, so the members refuse a second claim; free tiles can be proven free |

| | |
|---|---|
| Accounts | call sign + password, on `authenticated-map-chain` (`attachments` collection); the password never leaves the browser |
| Moves | `games-chain` (stock `ordered-log`, topic policies on): `games/<game>/<round, field, duel or season>`, each move signed by the player's session key. Land Rush claims are entries on `authenticated-map-chain`; the duels' plugin edition uses `duels-chain` (the example's own `sealed-duels` machine) |
| Who may write a game topic | the publisher's issuer key, or a session key it delegated for that game (one hour, one game), checked by every member before a move is stored |
| Finality | a threshold of members, about one block a second |
| Anchoring | Cardano (devnet locally), script mode, in the background |
| Dependencies | none in the browser: WebCrypto (Ed25519, PBKDF2, AES-GCM), small CBOR and BLAKE2b helpers, and the release's topic client ([`shared/topic-client/`](shared/topic-client/)) |

## Play locally

You need Java 25, Node.js 20 or later, `curl` and `jq`, and the
**Yano X 0.1.0-pre6** JVM distribution extracted beside the examples
(`yano-x-jvm-0.1.0-pre6/`), or `YANO_X_DIST` pointing at it.

```bash
./cluster start            # builds the duels plugin if needed, seals and starts three members,
                           # anchors the chains, registers games/ and the seven game entries (~2 min first time)
node serve.mjs --local     # the site, a same-origin proxy and the delegation service
# open http://localhost:8787/?proxy=1
```

Create a commander on the hub page, then pick a game; the sign-in carries to
every game (same origin, same `localStorage`). The first time you open a game,
its page asks the delegation service for a session key; the side panel shows
it (`session 3f2a…91 · games/galaxy/ · until 14:05`). To play against
yourself, open `http://127.0.0.1:8787/?proxy=1` too: a different origin, so a
separate browser identity.

```bash
./cluster status           # stage, members, each chain's height and anchoring
./cluster topics           # the effective policy of games/ and every game entry
./cluster stop             # keep the chains, commanders and keys
./cluster clean            # stop and delete .yano/ (chains, member keys, publisher keys)
```

`./cluster start` runs the release's own setup commands, as three operators
would: `yano.sh appchain new games --from chain/games.template.yaml`, then
`request` for each member, `seal`, `join`, `start` (the lead first), and
`anchor` for each chain. The members run from `.yano/release/`, a private view
of the distribution whose `plugins/` holds the release's bundles plus the
sealed-duels JAR, so the extracted distribution is never modified. `seal` pins
every plugin digest and `join` refuses a member whose plugins differ.

Then [`delegation/setup.mjs`](delegation/setup.mjs) plays the game publisher:

1. It makes two keys in `.yano/games/secrets/` (owner-only): `publisher.seed`,
   which owns `games/`, and `issuer.seed`, the only writer of `games/` and the
   key that signs session credentials.
2. `games/` is a top-level namespace, so the members create it by vote:
   `topics plan`, then `topics approve` on every member's own node.
3. The seven game entries sit inside the publisher's namespace, so the
   publisher alone signs them: `topics plan`, `topics sign`, `topics submit`.
4. It writes `.yano/games/topics.json`, the public settings the pages read
   (chain, generation, issuer key, service endpoint), and
   `.yano/games/delegation.json` for the service.

`serve.mjs` refuses every path under a dot-directory, so `.yano/` (member keys,
API keys, the publisher's keys) is never served.

A cluster from the 0.1.0-pre2 era (`.yano/` with `appchain-cluster/`) cannot
be resumed by pre6: start a fresh one. The `duels-chain` migration notes for
pre2 are kept in [ADD_A_CHAIN.md](ADD_A_CHAIN.md).

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

## Session keys: the player signs every move

`games-chain` is sealed with a topic registry
([`chain/games.template.yaml`](chain/games.template.yaml)): new namespaces by
member vote, and changes take effect two blocks after they commit.

```
games/                    owner: the publisher · writer and delegator: the issuer · credentials ≤ 1 hour
├── games/galaxy/         2 KB moves      → games/galaxy/r<round>
├── games/arcade/         40 KB runs      → games/arcade/f<field>
├── games/duels/          2 KB moves      → games/duels/lobby.h<hour>, games/duels/d<duel>
├── games/derby/          2 KB bets       → games/derby/h<hour>
├── games/reef/           2 KB placements → games/reef/s<season>
├── games/sonar/          4 KB moves      → games/sonar/lobby.h<hour>, games/sonar/d<battle>
└── games/neon-rush/      40 KB rides     → games/neon-rush/s<season>
```

One registration per game is enough: a round's topic is covered by its game's
entry and inherits its policy, so nobody registers anything when a round
starts. The members check the policy from the committed registry, so every
member gives the same answer, and so does a replay.

**What a page does, once per game per hour** ([`shared/sessions.js`](shared/sessions.js)):

1. Makes a session key: a non-extractable Ed25519 WebCrypto key, kept in
   IndexedDB. It never leaves the browser and cannot be exported.
2. Asks the delegation service for a credential. The request carries the
   session public key and the game's scope, is valid for 60 seconds, has a
   nonce, and is signed by the commander key. The service
   ([`delegation/service.mjs`](delegation/service.mjs)) checks the signature,
   reads the commander's profile from a member it trusts (revision 1,
   self-signed, the same key), checks that its issuer still may delegate the
   scope, and returns the issuer's signature over (session key, scope, one
   hour).
3. Signs a **session pass** with the commander key: "this session key plays
   for nova in `games/galaxy/`". The pass travels inside every move, so every
   browser can tell who a session key belongs to. The credential cannot: it
   names a key, not a call sign.

From then on every move is a core topic frame: the JSON move plus pass,
signed by the session key alone. Over an hour the commander key signs two
things, the login request and the pass, and never a move.

**What the members check before storing a move** (`TopicWriteRules` in the
host): the body is a canonical frame, the session key's signature covers this
chain, generation, topic, payload, nonce and deadline, the credential is
signed by a delegator of both the topic's and the scope's effective policy,
it covers the topic and the block time, the write was not used before, and the
payload fits the game's limit. Anything else is refused with HTTP 400 and a
code, and never reaches the log:

| Try | Refused with |
|---|---|
| a plain JSON move, or anyone without a session key | `TOPIC_FRAME_INVALID` |
| a forged session signature | `TOPIC_WRITER_DENIED` |
| a credential not from the issuer, or a Galaxy session on a Derby topic | `TOPIC_DELEGATION_INVALID` (the page's client refuses to frame it first) |
| the same frame sent again | `TOPIC_PROOF_REPLAYED` |
| a 50 KB Galaxy move | `TOPIC_PAYLOAD_TOO_LARGE` |

**What every browser checks again** before its rules run
([`openMove`](shared/sessions.js)), without trusting the member that served
the bytes: every signature in the frame, that the issuer is the one this site
publishes in `topics.json`, that the credential's scope is exactly this game,
and that the pass is signed by the commander it names for exactly this session
key. The rules then see the move and its author, and only ask whether the
author is the commander the move names ([`shared/moves.js`](shared/moves.js)).
The profile check is unchanged, and it is what ties a call sign to a key: a pass
can claim any call sign, but only with the claimant's own key.

**Proofs** show the chain of keys for any move: the session key that signed
it, the issuer's credential for the game, and the commander's pass. Then the
usual message proof and the root anchored on Cardano.

**Sign-out** deletes the browser's session keys for that commander. A stolen
session key works for at most the rest of its hour, and only in its own game.
Renewing it needs a fresh login request signed by the commander key.

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
| A join must come from the commander's session, match their profile key, and that profile must be registered before the join | Nobody can play as you |
| A launch must come from the commander's session, from a planet they hold at that block's time | No moving someone else's ships |
| The members refuse a reused write; nonces strictly increase, and a refused move still burns its nonce | Replaying a signed move does nothing |
| At most 6 launches per commander per block; 8 commanders per round | Bounded work per block, a fair map |

**Inspect** (or `i`) any planet to see which finalized move took it — the
join or the capturing launch — and prove it: the session key's signature, the
issuer's credential and the commander's pass, the `finalized-message-v1` proof
at `latest-confirmed-anchor`, and the proven root against the Cardano anchor
transaction.

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
   the score you saw, signed by your session key for `games/arcade/`.
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
your session key; the secret stays in your browser. When both seals are
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
crossed the line, signed by the rider's session key. Every browser replays the inputs on
the season's circuit; a ride counts only if it crosses the line at exactly the
claimed frame ([`moto/js/races.js`](moto/js/races.js)).

**Live in about a second.** Each checkpoint you pass posts a signed split.
About a second later, when its block is final, every other rider's page shows
you on their road and in "Live on the circuit". Splits are only advisory — a
ride's own replay decides its splits.

**Prove a ride:** the circuit's opening block, the signature over the inputs
and time, a fresh replay here crossing the line at the same frame, and the
record under the root anchored on Cardano — or ▶ watch it replayed.

### Race together: lobbies

A rider opens a race on the season's circuit from **Race together**, choosing
how long it stays open (15, 30, 60 or 120 s), how many riders it takes (2–8,
host included) and what happens if nobody joins. Everyone on the page sees it,
with its countdown and its grid, and can join until it closes. Then the race
starts, the same moment in every browser, and every rider is held on the grid
until it does: a big 3-2-1-GO, with the other riders beside you.

The lobby is four more kinds of message on the season's topic, signed by the
session key like every other move, so the members order them with the rides:

```
lobby  {"t":"lobby","id","pub","n","wait","max","alone"}  open a race; this message's id names the race
join   {"t":"join","id","pub","n","race"}                 take a place on its grid
leave  {"t":"leave","id","pub","n","race"}                give it up; the host leaving cancels the race
start  {"t":"start","id","pub","n","race"}                the host closes the lobby now
```

**Every time is ledger time.** The lobby closes `wait` after the timestamp of
the block that finalized it (or at the host's `start`); the grid is everyone
whose join was finalized in a block stamped before that; the race starts five
seconds after the close. Those are block timestamps, so every browser folding
the same topic computes the same grid and the same start
([`lobbyPhase`](moto/js/races.js)). The five seconds are for the browsers: by
then each has seen the block that closed the lobby. A page keeps its own
estimate of ledger time, from the timestamps of the blocks it sees and of its
own moves, and counts down to that.

**A race ride is an ordinary ride, tagged with the race.** It counts for the
season like any other, and for the race too if it was finalized within the
window its own time allows after the start: no earlier than three seconds
before *start + ride time* (no jump start; the slack is for clocks), no later
than twenty seconds after (the start was missed, or the ride arrived too late).
The grid is placed by ridden time, because everyone started together; ties go
to the earlier message ([`raceStandings`](moto/js/races.js)). Splits carry the
race too, so riders see each other on the road, but they stay advisory.

| Situation | What happens |
|---|---|
| A join finalized at or after the close | Refused: the lobby has closed. Every browser agrees, because the block's timestamp decides. |
| The same rider joins twice, or a full grid | Refused: already on this grid / the grid is full. |
| Nobody joins by the close | The host's choice: **wait once more** (the lobby stays open for another `wait`, then is cancelled if still alone) — the default; **ride alone** (a solo race against the clock); or **cancel**. |
| The host wants to go before the close | **Start now** closes the lobby at that block; the race starts five seconds later. |
| A rider leaves before the close | Their place is free again. If the host leaves, the race is cancelled. After the close nobody can leave: not finishing is a DNF. |
| A rider is on two grids | Refused: one race at a time, until your ride in it counts or it ends. |
| A browser reloads or reconnects before the start | It rebuilds the lobby from the ledger, finds you on the grid and puts you back on it for the countdown. |
| A rider arrives after the start | The page offers to ride at once, and says how late; the ride counts for the race if it still lands in its window (twenty seconds of slack), otherwise only for the season. |
| The connection drops mid-ride | The ride goes on in the tab; at the finish the page keeps resubmitting until the race window closes. |
| The tab closes mid-ride | The inputs lived in that tab; the rider is a DNF. Their other rides are unaffected. |
| The season is about to change | A lobby can only be opened if its longest possible race ends within the season; the page says so and greys the button. |

Limits: at most eight races under way per season, eight riders per grid, and
a lobby message is well under the game entry's 40 KB payload limit. Lobbies
are per season, so the next circuit starts with none; the page lists races to
come and under way, and the ones that ended in the last five minutes.

#### Try it: two browsers, one race

1. `./cluster start` and `node serve.mjs --local`, then open
   `http://localhost:8787/moto/?proxy=1` in two browser profiles (or one normal
   and one private window) and sign up a different commander in each.
2. In the first, under **Race together**, keep *30 s*, *4 riders*, *wait once
   more*, and press **Open a race**. Both pages list *Race xxxxxx by you · open
   · closes in 0:30*.
3. In the second, press **Join**. Both grids now list both riders, and both
   prompts say when the lobby closes. Reload the second page: it is still on
   the grid.
4. At the close both pages hold their bikes on the grid with *starts in 0:05*,
   then count 3-2-1-GO together. Ride (or add `&autopilot` to the URLs to let
   the attract mode's rider steer — its rides are ordinary, signed and
   replayed). Each rider appears on the other's road from their splits.
5. When both finish, the race card shows the same places and times in both
   browsers; ▶ replays a ride from the ledger and a name proves it.

Run with two headless browsers on one machine, the grids matched (also after
a reload), GO fired 11 ms apart, each rider saw the other live, and both
pages showed the same places and times.

## Sealed Duels · plugin edition

The same game, with the rules moved from the browsers to the members. Open
`duels/?engine=plugin` (or the hub's yellow card). Moves go to `duels-chain`,
whose members run [`plugin/`](plugin/): a Java port of `duels.js` packaged as
a state-machine plugin. The page still runs `duels.js` too, but only to check
the members' work.

| | Browser edition (`games-chain`) | Plugin edition (`duels-chain`) |
|---|---|---|
| Who runs the rules | every browser | every member; browsers check |
| Who signs a move | the player's session key; the members check the frame | the commander key; the plugin checks the signature |
| A forged move | refused before it is stored: `TOPIC_WRITER_DENIED`, `TOPIC_FRAME_INVALID`… | refused before it is stored: `BAD_SIGNATURE` |
| A legal-looking but foreign or mismatched move | stored, then ignored by every browser | refused before it is stored: `NOT_IN_DUEL`, `REVEAL_MISMATCH`… |
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
   the commander), `connectMoves` (session-signed reads and writes),
   `ProofPanel`, and `proveProfile` / `typedProof` / `authorshipChecks`.
2. Give it an entry in `TOPIC_ENTRIES` in [`shared/config.js`](shared/config.js)
   (`games/<game>/` and its payload limit) and set `sessions: true` and `scope`
   in its config. `./cluster start` registers the entry, signed by the
   publisher, and the delegation service starts issuing credentials for it.
3. Write the game as a deterministic fold over finalized messages: integer
   maths, no clock, no unseeded randomness. Read moves with `moveBody` and
   check authors with `authentic` ([`shared/moves.js`](shared/moves.js)). Add
   tests in `test/run.mjs`.
4. Add an entry to `GAMES` in [`shared/config.js`](shared/config.js) and a
   preview in [`hub.js`](hub.js).

## What it does not guarantee

- **The ledger enforces who writes, not the game rules — except first-come in
  Land Rush and the duels' plugin edition.** The topic policy guarantees that
  every stored move comes from a player's session under the publisher's
  credential, so forged, replayed and anonymous moves never reach the log. But
  `ordered-log` does not read a move: a player's own illegal move is ignored
  by every browser identically, but still stored. A topic schema could
  also make the members refuse malformed payloads; these games keep JSON
  payloads and no schema. In Land Rush the
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
  live rider can jump slightly when a split arrives. In a race, a rider
  without a split yet is drawn at your pace. As with the arcade, replay
  cannot tell a human from a bot (`&autopilot` makes that plain).
- **A race starts together only as well as the clocks agree.** The start is a
  ledger time; each page counts down to its estimate of it, which can be off
  by about the network latency. The window a race ride must land in absorbs
  that, but it also means a rider can start a second or two late and still
  count: places come from ridden time, not from who crossed the line first in
  the world.
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
- **The delegation service is the publisher's gate.** It checks a commander's
  profile and signature before it issues a credential, but whoever holds the
  issuer key can authorize any session key. The members only enforce that some
  credential from the issuer covers the write; browsers add the session pass,
  which ties a session key to a commander, and the profile check, which ties
  the commander to a call sign. The reference service keeps its replay cache in
  memory, for one instance; a replicated service needs a shared store.
- **A session key is good for its hour.** Sign-out deletes it from the
  browser, but a copied credential and key stay usable until the credential
  expires. The owners can revoke one sooner with a `revoke` registry command
  (`yano.sh appchain topics`), and the members then refuse it in the next block.
- **Only signed-in players post markers.** A season's or field's opening
  message, and Derby's beacon `go`, are writes like any other, so they need a
  session; spectators can watch but not open a round.

## Tests

```bash
npm test                                          # 80 checks, no cluster needed
node --no-warnings test/duel-vectors.mjs          # rewrite the browser rules' duel vectors for the plugin
(cd plugin && ./gradlew test)                     # the plugin agrees with them (6 tests)
```

The authenticated-map envelope is checked byte for byte against the release
CLI. The session keys are tested with real frames from the release's topic
client: a move opens with its author, while a tampered payload, a plain or
direct write, a foreign issuer, a credential for the whole namespace or
another game, a pass signed by someone else and a pass copied to another
session do not. The delegation service issues a one-hour, one-game credential
for a fresh request from the profile's key, and refuses replayed, forged,
borrowed, stale, unknown, out-of-scope and inactive-issuer requests. A page's
`Moves` signs one login and one pass, then frames every move with the session
key, and the frames open and apply in Galaxy. Every session game writes under
its own registered entry. The rest cover the keystore; Galaxy's simulation (map determinism,
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
refused, live splits, replayed and wrong-circuit rides; and its race lobbies:
joins in order up to the millisecond before the close and refused at it, the
start a fixed lead after the close and the same in two independent folds,
duplicate joins, a full grid, one race at a time, stale nonces, the host's
early start, the three answers to a solo lobby, leaving and the host's leave
cancelling, race rides placed by ridden time while a jump start, a missed
start and a rider off the grid count for the season only, DNFs, and a race
that would outlast its season).

## Files

```
index.html, hub.js, hub.css   the game center: sign in once, pick a game
shared/                       what every game uses
  config.js                   members, chains, accounts, the games/ registry entries, the list of games
  auth.js                     the sign-in panel and the commander session
  sessions.js                 session keys: credentials, passes, openMove (verify a move), Moves (read and write)
  moves.js                    what a game's rules use: moveBody and authentic
  topic-client/               the release's browser topic client (frames, credentials), copied unchanged
  accounts.js                 PBKDF2 + AES-GCM keystore, profiles
  profiles.js                 profile lookup, registration, the cross-chain check
  proofs.js                   typed proofs, profile proofs, authorship (session, credential, pass), the anchored root
  ledger.js                   REST client: by-topic, blocks, submit, SSE, plugin routes
  authmap.js                  PUT_IF_ABSENT bytes and entry decoding
  ui.js, base.css             proof panel, toasts, shared styles
  cbor.js, blake2b.js, crypto.js, rng.js
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
delegation/                   the game publisher's side: service.mjs (who gets a credential), server.mjs
                              (POST /delegations), setup.mjs (registers games/ and the game entries)
serve.mjs                     static server + same-origin proxy; --local adds the delegation service
cluster, chain/               the local application: games.template.yaml, sealed and run with yano.sh appchain
ADD_A_CHAIN.md                historical (0.1.0-pre2): how duels-chain joined a running pre2 cluster
test/run.mjs                  npm test
test/duel-vectors.mjs         the shared duel vectors for the plugin's tests
```
