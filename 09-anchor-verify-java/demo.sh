#!/usr/bin/env bash
# Guided walkthrough of example 09 — anchor and verify.
#
#   ./demo.sh          run the story, pausing between steps
#   ./demo.sh --fast   run it without pauses
#
# Assumes the chain is up:  ./cluster start 3
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
cd "$HERE"

APP=(java -jar target/anchor-verify.jar)
PAUSE=1
[ "${1:-}" = "--fast" ] && PAUSE=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m── %s\033[0m\n\n' "$*"; }
pause() { [ "$PAUSE" = 1 ] && { printf '\n\033[2m[enter to continue]\033[0m'; read -r _; } || true; }
run()   { dim "\$ anchor ${*:3}"; "$@"; }
expect_refused() { dim "\$ anchor ${*:3}"; if "$@"; then echo "UNEXPECTED: that should have been refused"; exit 1; fi; }

[ -f target/anchor-verify.jar ] || { bold "Building ..."; mvn -q -B package 2>/dev/null || { mvn -B package; exit 1; }; }

curl -fsS "http://127.0.0.1:7150/api/v1/app-chain/chains/evidence-chain/status" >/dev/null 2>&1 || {
  printf 'error: evidence-chain is not reachable on 127.0.0.1:7150\n' >&2
  printf '       start it with:  ./cluster start 3\n' >&2
  exit 1
}

clear
bold "Anchor and verify"
cat <<'TXT'

Every other example in this repo ends the same way: "verified — against a root
we got from somewhere." Example 01 compares against a peer member's root.
Example 02 checks signatures against member keys pinned in a config file.

Both leave a question open: where did that root, or that key list, come from?
Ask a node, and a dishonest node can answer. Pin them by hand, and someone has
to keep the pin correct.

This example closes it. The verifier reads Cardano and nothing else — and
Cardano carries not just the state root, but the member set and threshold too.
TXT
pause

step "1. Write something worth proving later"
run "${APP[@]}" record "inspection certificate C-8841 issued 2026-09-22"
pause

step "2. Wait for it to be anchored"
printf '  waiting for the next anchor transaction'
for _ in $(seq 1 40); do
  [ "$(curl -fsS http://127.0.0.1:7150/api/v1/app-chain/chains/evidence-chain/status | jq -r '.anchor.anchoredCount')" != "0" ] && break
  printf '.'; sleep 2
done
printf '\n\n'
run "${APP[@]}" status
pause

step "3. Pin the chain identity — the one out-of-band step"
run "${APP[@]}" trust init
pause

step "4. What Cardano actually says"
run "${APP[@]}" inspect
pause

step "5. Export a claim about one record"
MESSAGE_ID="$(curl -fsS http://127.0.0.1:7150/api/v1/app-chain/chains/evidence-chain/blocks/1 | jq -r '.messages[0].messageId')"
run "${APP[@]}" export "$MESSAGE_ID" --note "inspection certificate C-8841"
pause

step "6. Verify it — Cardano only"
run "${APP[@]}" verify bundle.json
cat <<'TXT'

Read the checks again, because the order is the argument:

  Cardano holds a UTxO carrying this chain's thread token, and its datum
  says that at height 1 the state root was 9d357b52…, under these three
  members with a threshold of two.

  The bundle's proof reconciles this record against that exact root.

No Yano node was asked anything. If every member disappeared tomorrow, this
still verifies.
TXT
pause

step "7. Change one bit of the record"
run "${APP[@]}" tamper bundle.json
pause

step "8. And it is refused"
expect_refused "${APP[@]}" verify bundle.json
cat <<'TXT'

Same height, same root, same proof bytes — only the recorded value moved, and
the proof no longer reconciles with what Cardano carries.
TXT
pause

step "9. Other things a forged bundle might try"
"${APP[@]}" export "$MESSAGE_ID" --note "inspection certificate C-8841" >/dev/null

dim '$ # claim a height Cardano never anchored'
python3 - <<'PY'
import json, pathlib
d = json.loads(pathlib.Path('bundle.json').read_text()); d['height'] = 99
pathlib.Path('forged-height.json').write_text(json.dumps(d, indent=2))
PY
expect_refused "${APP[@]}" verify forged-height.json

dim '$ # claim a different state root'
python3 - <<'PY'
import json, pathlib
d = json.loads(pathlib.Path('bundle.json').read_text()); d['stateRootHex'] = 'ff' * 32
pathlib.Path('forged-root.json').write_text(json.dumps(d, indent=2))
PY
expect_refused "${APP[@]}" verify forged-root.json

dim '$ # claim to be from another chain entirely'
python3 - <<'PY'
import json, pathlib
d = json.loads(pathlib.Path('bundle.json').read_text()); d['chainId'] = 'some-other-chain'
pathlib.Path('forged-chain.json').write_text(json.dumps(d, indent=2))
PY
expect_refused "${APP[@]}" verify forged-chain.json
rm -f forged-height.json forged-root.json forged-chain.json
cat <<'TXT'

Each is caught by a different check, and each names which one failed. Notice
that a bundle cannot say where its own anchor lives — if it could, a forged
bundle would simply point at a forged anchor.
TXT
pause

step "Done"
cat <<'TXT'
What this demonstrated:

  * a state root committed to Cardano by a Plutus thread-NFT anchor
  * the member set and threshold carried in the anchor datum, so a verifier
    is not told separately who was allowed to sign
  * an evidence bundle verified against that anchor with NO Yano node involved
  * a tampered record, a wrong height, a wrong root and a wrong chain each
    refused, each naming the check that caught it

This is the strongest of the three trust levels the other examples mention:

  a peer member's root          trust that peer          example 01
  a threshold certificate       trust pinned member keys example 02
  a Cardano anchor              trust Cardano            THIS example

Try it yourself:

  java -jar target/anchor-verify.jar record "another certificate"
  java -jar target/anchor-verify.jar status
  java -jar target/anchor-verify.jar inspect
  cat anchor-trust.json bundle.json

  ./cluster stop      stop, keep data
  ./cluster clean     stop and wipe

See DEMO.md for the narrated version and README.md for how it works.
TXT
