#!/usr/bin/env bash
# Guided walkthrough of example 01 — shared access-change audit log.
#
#   ./demo.sh          run the story, pausing between steps
#   ./demo.sh --fast   run it without pauses (CI, screen recordings)
#
# Assumes the chain is already up:  ./cluster start 3
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
cd "$HERE"

APP=(java -jar target/audit-log.jar)
PAUSE=1
[ "${1:-}" = "--fast" ] && PAUSE=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m── %s\033[0m\n\n' "$*"; }
pause() { [ "$PAUSE" = 1 ] && { printf '\n\033[2m[enter to continue]\033[0m'; read -r _; } || true; }

run()   { dim "\$ $*"; "$@"; }

# --- preflight ---------------------------------------------------------------

[ -f target/audit-log.jar ] || {
  bold "Building the example first ..."
  # Maven on JDK 25 prints its own unrelated warnings; keep the demo readable.
  mvn -q -B package 2>/dev/null || { mvn -B package; exit 1; }
}

curl -fsS "http://127.0.0.1:7100/api/v1/app-chain/chains/access-log-chain/status" >/dev/null 2>&1 || {
  printf 'error: access-log-chain is not reachable on 127.0.0.1:7100\n' >&2
  printf '       start it with:  ./cluster start 3\n' >&2
  exit 1
}

# --- the story ---------------------------------------------------------------

clear
bold "Shared access-change audit log"
cat <<'TXT'

Two organizations and an auditor need one shared record of who was granted
access to what. Whoever owns the database owns the truth — so nobody wants to
own it, and nobody trusts the party who does.

Three members run this chain. Every entry is co-signed by a threshold of them
before it counts, and any of them can later prove a single entry to an outsider
without the outsider trusting that member.
TXT
pause

step "1. Three members, one history"
run "${APP[@]}" tips
cat <<'TXT'

Same height, same state root, on all three. The state root is a commitment to
everything the chain has recorded; agreement here means nobody is holding a
different version of the log.
TXT
pause

step "2. Org A records an access grant"
run "${APP[@]}" record grant \
  --subject bob --resource prod-db --by alice \
  --reason "oncall rotation 2026-W38" --node 0
cat <<'TXT'

The HTTP call returned a message id immediately — that is admission to the
pending pool, not finality. The command then waited for a threshold of members
to finalize it, which is why a height and index came back.
TXT
pause

step "3. Org B and the auditor record their own changes"
run "${APP[@]}" record revoke \
  --subject bob --resource prod-db --by carol \
  --reason "rotation ended" --node 1
run "${APP[@]}" record grant \
  --subject dave --resource billing-api --by alice \
  --reason "new finance integration" --node 2
cat <<'TXT'

Each submission entered through a different member, and each entry carries the
key of the member that relayed it. "We never sent that" stops being an argument
you can have.
TXT
pause

step "4. The shared log"
run "${APP[@]}" list --limit 10
pause

step "5. Prove one entry — without trusting the node that serves it"
MESSAGE_ID="$("${APP[@]}" list --limit 1 | awk 'NR==4 {print $NF}')"
cat <<TXT

An auditor takes one entry and checks it. The proof comes from node 2. The
state root it is checked against comes from node 0 — a different member, its
own copy of the block at the height the proof commits to.

TXT
run "${APP[@]}" prove "$MESSAGE_ID" --from 2 --against 0
cat <<'TXT'

The last line is the one that matters. The record was served by one member and
validated against a root that a different member arrived at independently, and
a one-bit change to the logged event breaks it.

In production the trusted root should come from something stronger than a peer:
a threshold certificate under membership you pinned yourself, or a Cardano
anchor transaction. Example 09 does exactly that.
TXT
pause

step "Done"
cat <<'TXT'
What this demonstrated:

  * a shared append-only log no single party can reorder or rewrite
  * threshold finality — an entry counts once enough members co-sign it
  * per-entry proofs that verify against an independently obtained state root
  * tamper evidence — altering a recorded event invalidates its proof

Keep exploring:

  ./cluster status                    per-member tips and roots
  java -jar target/audit-log.jar tips
  ./cluster logs 0 -f                 watch a member work
  ./cluster stop                      stop, keep the data
  ./cluster clean                     stop and wipe

See DEMO.md for the narrated version and README.md for how it is built.
TXT
