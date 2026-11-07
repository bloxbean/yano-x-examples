# 20 — Anchor Canvas (a browser game)

A shared 32×32 pixel wall. Every pixel is a message on a Yano X app ledger,
finalized by 4 of 5 members and periodically sealed on Cardano. Click a pixel
to see who painted it and prove it against the Cardano anchor.

It is a single static page — HTML, CSS and ES modules, no build step, no
backend, no npm install — so it can be hosted on GitHub Pages as is.

| | |
|---|---|
| App ledger | `orders-chain` on the Yano X preprod showcase (stock `ordered-log`) |
| Topic | `anchor-canvas.s1` |
| Identity | CIP-30 wallet (`signData`, once per session) or guest |
| Finality | 4 of 5 members, about one block a second |
| Anchoring | Cardano preprod, every 30 blocks or hourly (Plutus V3 thread NFT) |
| Dependencies | none — WebCrypto Ed25519 plus small CBOR and BLAKE2b helpers |

## Play

**Locally, against the live showcase** (works today):

```bash
node serve.mjs
# open http://localhost:8787/?proxy=1
```

`serve.mjs` serves the page and forwards `/proxy/<n>/…` to member *n*, so the
browser only talks to its own origin.

**Fully offline**, with a private three-member `orders-chain` and a local
devnet anchor (needs Yano X 0.1.0-pre6, Java, `curl` and `jq`):

```bash
./cluster start 3    # seals chain/orders.template.yaml; a minute or two the first time
YANO_NODES=http://127.0.0.1:7200,http://127.0.0.1:7201,http://127.0.0.1:7202 node serve.mjs
# open http://localhost:8787/?proxy=1
./cluster clean      # when you're done
```

No wallet in the browser? Add `&mockwallet` on localhost to get a throwaway
CIP-30 wallet that produces real COSE signatures.

**On GitHub Pages:** publish this folder (Settings → Pages → deploy from
branch). There is nothing to build. The page then calls the members directly,
which a browser only allows if the members name the page's origin in CORS:

```properties
quarkus.http.cors.enabled=true          # YANO_HTTP_CORS_ENABLED=true
quarkus.http.cors.origins=https://bloxbean.github.io
```

The showcase members currently answer preflights but list no external origin,
so a Pages-hosted copy shows a "can't reach the members" banner until this is
set. Read endpoints, `POST …/messages` and the SSE stream all need it.

## How it works

```
 browser                                      Yano X app ledger (5 members)
 ───────                                      ─────────────────────────────
 wallet.signData(session key)  ── join ──▶    ordered-log: one agreed order,
 session key signs each pixel  ── px ───▶     certified by 4 of 5, never reads bodies
                                                         │
 fold(finalized log) = wall    ◀── by-topic + blocks ────┤
                                                         │ every 30 blocks
 "prove this pixel"            ◀── finalized-message-v1 ─┤
                                    proof at the anchor  ▼
                                              Cardano preprod: anchor tx + state root
```

1. **Join.** The wallet signs, once, a short JSON statement authorizing a fresh
   browser-held Ed25519 *session key* for up to 12 hours. The join message
   carries the raw COSE_Sign1 and COSE_Key.
2. **Paint.** The session key signs `app|chain|px|key|nonce|x|y|c`. No popup.
3. **Order.** The page posts the message to the member you pick; it is
   finalized in the next block. `202` is admission, not success.
4. **Fold.** Every browser replays the finalized log
   (`messages/by-topic` + `blocks/{h}` for the certified timestamps) through
   [`js/game.js`](js/game.js). The fold is deterministic, so every player sees
   the same wall without anyone running a game server.
5. **Seal.** The cluster anchors the chain's state root on Cardano. The side
   panel shows the wall as of the last anchor, and unsealed pixels carry a
   white corner until the next one.
6. **Prove.** *Inspect* a pixel and the page asks for the typed
   `finalized-message-v1` proof at `latest-confirmed-anchor`, then checks that
   the proven root is the one in the Cardano anchor transaction.

### Rules (all enforced by the fold, not the ledger)

| Rule | Why |
|---|---|
| A join must verify as CIP-8 **and** BLAKE2b-224(key) must be the address's key hash | Otherwise anyone could sign with their own key and claim your address |
| A session binds once; it expires by **block** time; at most 24 h | No re-binding a session to another wallet; no wall clock in the fold |
| A pixel must verify against its session key | The relaying member signs the envelope, but that only says who admitted it |
| Nonces strictly increase per session — a refused pixel still burns its nonce | Replaying an old (or refused) signed pixel does nothing |
| Cooldown per player by certified block timestamp: wallet 3 s, guest 8 s | Fairness, decided by time every member agreed on |
| The later finalized pixel wins a cell | The ledger's order *is* the tie-break |

Changing any rule changes the wall, so it is a new season: change `topic` in
[`js/config.js`](js/config.js) too.

## What it does not guarantee

- **The ledger does not enforce the rules.** `ordered-log` accepts any body on
  any topic. Junk is ignored by every client identically, but it is still
  stored. A production game would put the fold in a state-machine plugin so
  members refuse bad moves at admission.
- **Identities are cheap.** Guests are free, and so are fresh wallet addresses.
  The cooldown is per player, not per human.
- **The proof is checked by the node that served it.** The page compares the
  proven root with the anchor, but it does not verify the MPF proof or the
  anchor datum itself. [Example 09](../09-anchor-verify-java/) does that with
  nothing but Cardano.
- **The session key sits in `localStorage`.** It can paint as you for at most
  12 hours and can do nothing else; the wallet's own keys are never exposed.
- **Traffic is not free for the cluster.** Every 30 blocks of play leads to one
  anchor transaction on preprod, paid by the cluster's anchor wallet.

## Tests

```bash
npm test     # 20 checks, no cluster needed
```

They cover BLAKE2b against RFC 7693, a **real wallet's** `signData` output
(from cardano-client-lib's CIP-30 tests), and the rejections that matter:
forged address binding, script addresses, hashed payloads, tampered pixels,
replays, burnt nonces, cooldowns, expiry, re-binding, another game's join, and
two independent folds reaching the same wall.

## Files

```
index.html, style.css     the page
js/config.js              cluster, chain, topic and game rules
js/game.js                the deterministic fold — read this first
js/cip8.js                CIP-30 signData (COSE_Sign1) verification + address binding
js/wallet.js              CIP-30 discovery and browser session keys
js/ledger.js              REST client: by-topic, blocks, submit, SSE, typed proofs
js/cbor.js, blake2b.js,   just enough CBOR, BLAKE2b-224/256, Ed25519 and bech32
  crypto.js
serve.mjs                 static server + same-origin proxy for local play
cluster                   start / stop / status for an optional private orders-chain
chain/orders.template.yaml  that chain as an app-chain template (commented)
test/run.mjs              npm test
test/mock-wallet.js       a throwaway CIP-30 wallet for localhost testing
```
