# Sealed Duels — the state-machine plugin

The same duel rules as [`../duels/js/duels.js`](../duels/js/duels.js), run by
the members instead of the browsers. It is a Yano app-state machine
(`sealed-duels`) in one small JAR, for a chain of its own: `duels-chain`.

| | |
|---|---|
| Bundle | `plugin-bundle.sealed-duels` 1.0.0, Yano API major 3 (min level 4) |
| Contribution | `app-state-machine` `sealed-duels` → `SealedDuelsStateMachineProvider` |
| Catalog capability | `state:sealed-duels`, signed (`appchain-component-catalog-v1.sig.json`) |
| Dependencies | none; compiles against the host API only, so the JAR packages no Yano classes |

## What the members do

| Hook | What happens |
|---|---|
| `validateForBlock` | checks a move against **committed** state before it is pooled or proposed; a broken move is never stored |
| `apply` | runs the rules on every finalized message, in order, with the block's certified timestamp; writes the duel record |
| `query("duel", <id>)` | the committed duel record, as JSON |
| `query("admit", <topic> LF <body>)` | the members' verdict on a move before it is sent: `{"accepted":false,"code","reason"}` |

Refusal codes: `MALFORMED`, `WRONG_TOPIC`, `NOT_A_MOVE`, `BAD_SIGNATURE`,
`STALE_NONCE`, `WRONG_KEY`, `BAD_LENGTH`, `NO_SUCH_CHALLENGE`,
`ALREADY_ACCEPTED`, `CHALLENGE_EXPIRED`, `OWN_CHALLENGE`, `NO_SUCH_DUEL`,
`NOT_IN_DUEL`, `DUEL_OVER`, `WRONG_ROUND`, `SEALING_CLOSED`, `ALREADY_SEALED`,
`NOTHING_TO_REVEAL`, `ALREADY_REVEALED`, `REVEAL_MISMATCH`.

On a host from Yano 0.1.0-pre17 a refused submission gets HTTP 400 with the
code. An older host (the 0.1.0-pre2 distribution runs 0.1.0-pre15) accepts the
submission with 202, and the proposer drops the move when it builds the block,
so it never reaches the log. The page asks `admit` first, so players see the
code either way.

State keys (UTF-8):

| Key | Value |
|---|---|
| `duel/<64-hex id>` | the duel record: players and keys, round, phase, deadlines, HP, energy, seals, reveals, settled rounds, winner |
| `topic/<16-hex>` | the duel id that owns a duel topic |
| `nonce/<call sign>` | the commander's last lobby nonce |
| `key/<call sign>` | the first key that used the call sign on this chain |

## One rule differs: who owns a call sign

A state machine sees only its own chain's state. It cannot read the commander
profiles on `authenticated-map-chain`, so it cannot apply the browser edition's
"profile registered before the move" check. Instead, the first key to use a
call sign on `duels-chain` owns it there, and a later message with another key
is refused with `WRONG_KEY`. The browser fold applies the same rule in the
plugin edition (`keyBinding: 'first-seen'`), so the two still agree exactly.

Tying a call sign to its profile would need the profile as an input the
members agree on, such as a binding or observer that brings the profile fact
into this chain. Reading another chain from inside `apply` would not do that.

## Determinism

Every member must compute the same root from the same messages:

- No wall clock, randomness or I/O. Time is the block's certified timestamp,
  and the dice are BLAKE2b of both players' secrets.
- Integer arithmetic only. JSON numbers must be integers (`Json.java` rejects
  anything else).
- Records serialize canonically (fixed field order, no whitespace), and a
  block's writes go to the writer in sorted key order.
- A malformed message never throws: it changes nothing.
- Writes become readable only after the block commits, so `apply` keeps the
  block's own writes for the later messages of the same block.

## Build, test, sign

```bash
./gradlew build          # compiles against ../../yano-x-jvm-*/yano.jar; or -PyanoJar=…, or -PyanoVersion=<host version>
```

The tests replay vectors produced by the browser rules, then require the same
accept/refuse decision on every message and the same final duel. Both cheats
are refused with their codes: a reveal that does not match its seal, and a
borrowed call sign.

```bash
node --no-warnings ../test/duel-vectors.mjs   # regenerate src/test/resources/duel-vectors.json after a rules change
./gradlew test
```

Sign the catalog and runtime manifest, then rebuild so the signature is inside
the JAR. Keep the 32-byte publisher seed as 64 hex characters, outside the
repository. The local example keeps one in the git-ignored `../.yano/`:

```bash
D=../../yano-x-jvm-0.1.0-pre2
R=src/main/resources/META-INF/yano
$D/yano.sh appchain plugin sign --catalog $R/appchain-component-catalog-v1.json \
  --runtime-manifest $R/plugins/plugin-bundle.sealed-duels.json \
  --seed-file ../.yano/plugin-publisher.seed --key-id examples-duels-2026 \
  --output $R/appchain-component-catalog-v1.sig.json
./gradlew build
$D/yano.sh appchain plugin validate build/libs/sealed-duels-yano-plugin.jar \
  --trust-key "$(cat ../.yano/plugin-publisher.trust)"
$D/tools/yano-plugins/bin/yano-plugins validate build/libs/sealed-duels-yano-plugin.jar
```

The signature covers the catalog, the runtime manifest and the publisher key
id. It does not approve the code. The members run the plugin as trusted
consensus code, so its operators must review it as they would any other.

## Changing the rules

Never roll new rule logic into a chain that already has history. During a
rollout the members compute different roots and the chain stops finalizing.
Afterwards, replaying old blocks with the new code no longer matches the signed
roots. A rules change belongs on a new chain (a new genesis id, here a new
`chains[n]` entry), or behind an explicit, height-activated version of the
rules. Code that does not touch `apply` or `validateForBlock`, such as a new
`query` path, can ship as a new JAR on every member at once.
