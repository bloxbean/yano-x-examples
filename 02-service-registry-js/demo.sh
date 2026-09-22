#!/usr/bin/env bash
# Guided walkthrough of example 02 — consortium service registry.
#
#   ./demo.sh          run the story, pausing between steps
#   ./demo.sh --fast   run it without pauses
#
# Assumes the chain is up:  ./cluster start 3
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
cd "$HERE"

R=(node src/cli.js)
PAUSE=1
[ "${1:-}" = "--fast" ] && PAUSE=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m── %s\033[0m\n\n' "$*"; }
pause() { [ "$PAUSE" = 1 ] && { printf '\n\033[2m[enter to continue]\033[0m'; read -r _; } || true; }
run()   { dim "\$ registry ${*:3}"; "$@"; }

curl -fsS "http://127.0.0.1:7110/api/v1/app-chain/chains/service-registry-chain/status" >/dev/null 2>&1 || {
  printf 'error: service-registry-chain is not reachable on 127.0.0.1:7110\n' >&2
  printf '       start it with:  ./cluster start 3\n' >&2
  exit 1
}

clear
bold "Consortium service registry"
cat <<'TXT'

Three banks in a clearing consortium publish the API endpoint each of them
settles against. Everyone needs the current list. Nobody may change anybody
else's entry — repointing a rival's settlement endpoint would be an attack,
not a typo.

There is no Yano SDK for JavaScript, and this example does not use one. It is
plain fetch() against the members' REST API, plus about 200 lines that verify
the answers for itself.
TXT
pause

step "1. What this application trusts"
run "${R[@]}" members
cat <<'TXT'

That is the whole trust input: three public keys and a threshold, pinned in
trust.json. The application never asks a node who the members are — that would
let a node nominate its own signers.
TXT
pause

step "2. Acme Bank publishes its settlement endpoint"
run "${R[@]}" publish clearing.acme-bank https://api.acme-bank.example/v1 --as acme-bank
cat <<'TXT'

Acme submitted through its own node, so Acme's member key owns that entry.
TXT
pause

step "3. Borealis tries to repoint Acme's endpoint"
run "${R[@]}" update clearing.acme-bank https://evil.borealis.example/steal --as borealis-bank
cat <<'TXT'

Read that carefully — this is the part worth understanding.

The command was FINALIZED. It is in the chain forever, signed by a threshold of
members. And it changed nothing.

kv-registry's rule is "first writer owns the key". A write by anyone else is a
deterministic no-op, not an error. Every member applies that rule identically,
so there is no node to compromise and no race to win.

There is no error message here because nothing went wrong: the chain did
exactly what every member agreed it should do. This is why "my transaction was
accepted" never means "my change was applied" — you read the state back.
TXT
pause

step "4. Both banks' entries, and every attempt on record"
run "${R[@]}" publish clearing.borealis https://api.borealis.example/v2 --as borealis-bank
run "${R[@]}" log
cat <<'TXT'

The failed hijack is right there at height 2, attributed to the member that
tried it. A registry that silently dropped rejected writes would have lost that
evidence.
TXT
pause

step "5. A consumer retrieves an endpoint — and verifies it"
cat <<'TXT'
Now the part that matters for an application. A payment service is about to
send money to whatever endpoint the registry names, so "some node told me" is
not good enough.

It asks ONE member, then checks the answer against the keys it pinned itself.

TXT
run "${R[@]}" get clearing.acme-bank --from clearing-house
cat <<'TXT'

Nothing in that check trusted the node that answered:

  * the block header was re-hashed from its own fields, in JavaScript;
  * the finality certificate's Ed25519 signatures were verified against the
    pinned member keys;
  * a threshold of those members signed that exact state root at that height.

A node serving a made-up value would have to forge signatures from members
whose keys it does not have.
TXT
pause

step "6. What happens when you release a key"
run "${R[@]}" remove clearing.acme-bank --as acme-bank
run "${R[@]}" publish clearing.acme-bank https://api.borealis.example/took-it --as borealis-bank
cat <<'TXT'

Deleting releases the key, and the next writer owns it — including a rival.

That is deliberate in kv-registry, and it is a real limitation: delete-then-
recreate is NOT a safe ownership transfer. If ownership must move under
control, that rule belongs in a state machine, not in an off-chain convention.
DEMO.md says more.
TXT
pause

step "Done"
cat <<'TXT'
What this demonstrated:

  * a shared registry where each member owns its own entries
  * an unauthorized write finalizing as a message and changing nothing
  * the difference between "accepted" and "applied"
  * retrieving a value and verifying it in the application, with no Yano
    library and no trust in the answering node

Try it yourself:

  node src/cli.js get clearing.borealis --from acme-bank
  node src/cli.js get clearing.nothing-here        # exclusion proof
  node src/cli.js tips
  npm test                                          # verifier self-test

  ./cluster stop      stop, keep the data
  ./cluster clean     stop and wipe

See DEMO.md for the narrated version, README.md for how the verification works.
TXT
