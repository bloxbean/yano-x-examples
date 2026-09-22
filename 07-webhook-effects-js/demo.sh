#!/usr/bin/env bash
# Guided walkthrough of example 07 — webhook effects.
#
#   ./demo.sh          run the story, pausing between steps
#   ./demo.sh --fast   run it without pauses
#
# Assumes the chain is up:  ./cluster start 3
# Starts and stops its own ERP receiver.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
cd "$HERE"

ERP=(node src/cli.js)
LOG=/tmp/yano-example-07-receiver.log
PAUSE=1
[ "${1:-}" = "--fast" ] && PAUSE=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m── %s\033[0m\n\n' "$*"; }
pause() { [ "$PAUSE" = 1 ] && { printf '\n\033[2m[enter to continue]\033[0m'; read -r _; } || true; }
run()   { dim "\$ erp ${*:3}"; "$@"; }

RECEIVER_PID=""
start_receiver() {
  stop_receiver
  : > "$LOG"
  node receiver.js "$@" >> "$LOG" 2>&1 &
  RECEIVER_PID=$!
  sleep 1
}
stop_receiver() {
  [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null || true
  RECEIVER_PID=""
}
# Node buffers stdout to a file, so give it a moment before reading.
erp_log() { sleep 2; sed 's/^/  │ /' "$LOG"; }
trap stop_receiver EXIT

curl -fsS "http://127.0.0.1:7160/api/v1/app-chain/chains/release-chain/status" >/dev/null 2>&1 || {
  printf 'error: release-chain is not reachable on 127.0.0.1:7160\n' >&2
  printf '       start it with:  ./cluster start 3\n' >&2
  exit 1
}

ORDER="ORD-$RANDOM"
FAILING="ORD-$RANDOM"
FLAKY="ORD-$RANDOM"

clear
bold "Approvals that actually do something"
cat <<'TXT'

Every approval system eventually has to call something. An order is released,
a payment is queued, a ticket is closed. That call is where systems usually
come apart:

  the chain says APPROVED, and the ERP was never called
  the ERP was called twice, and the order shipped twice
  the call failed, and nobody can tell whether it ever succeeded

Yano treats the outside call as part of the ledger. A finalized approval emits
an EFFECT; one member performs it; and the outcome is written back into
consensus, where every member agrees on it.

Delivery is at-least-once. Incorporating the outcome is exactly-once.
TXT
pause

step "1. Only one member calls the ERP"
run "${ERP[@]}" members
cat <<'TXT'

Two different scopes, and this is the crux of the configuration:

  "reaching approval emits an effect"   consensus — every member, in the chain YAML
  "and I am the one who performs it"    node-local — one member, in its own overlay

If performing it were consensus config, three members would each call the ERP.
TXT
pause

step "2. Start the ERP — a separate system that knows nothing about Yano"
start_receiver
dim '$ node receiver.js'
erp_log
pause

step "3. Propose a release needing two approvals"
run "${ERP[@]}" release "$ORDER" --required 2
pause

step "4. One approval is not enough — and nothing is called"
run "${ERP[@]}" approve "$ORDER" --as 0
dim '$ # the ERP log, unchanged:'
erp_log
pause

step "5. The second approval emits the effect"
run "${ERP[@]}" approve "$ORDER" --as 1
pause

step "6. What the ERP actually received"
erp_log
cat <<'TXT'

Three things worth pointing at:

  Idempotency-Key   deterministic — derived from the effect identity, not
                    random. The same effect always carries the same key, which
                    is what lets a receiver deduplicate.
  X-Effect-Id       chain/height/ordinal — where in the ledger this came from.
  body              exactly the bytes the approval carried. The approvals
                    machine never interpreted them; it only carried them.
TXT
pause

step "7. The outcome went back into consensus"
run "${ERP[@]}" show "$ORDER"
cat <<'TXT'

Two records, deliberately separate:

  the decision   APPROVED — what the members agreed to do
  the effect     CONFIRMED — whether the outside world actually did it

Both are committed state. Every member agrees the ERP answered 2xx, even
though only one of them made the call.
TXT
pause

step "8. When the ERP rejects the request (4xx)"
start_receiver --fail-4xx
run "${ERP[@]}" release "$FAILING" --required 2
"${ERP[@]}" approve "$FAILING" --as 0 >/dev/null
run "${ERP[@]}" approve "$FAILING" --as 2
pause

step "9. The approval is still APPROVED"
run "${ERP[@]}" show "$FAILING"
cat <<'TXT'

This is the separation earning its keep. A 4xx means the request was wrong —
retrying will not help, so it is not retried. But the members did approve the
release, and that fact does not evaporate because a downstream system said no.

Operationally, "APPROVED but the effect FAILED" is exactly the state a human
needs to see. Collapsing the two into one status would hide it.
TXT
pause

step "10. When the ERP is merely unavailable (5xx)"
start_receiver --fail-5xx 2
run "${ERP[@]}" release "$FLAKY" --required 2
"${ERP[@]}" approve "$FLAKY" --as 0 >/dev/null
run "${ERP[@]}" approve "$FLAKY" --as 1
pause

step "11. It was retried, and the receiver saw every attempt"
erp_log
cat <<'TXT'

Two 503s, then success — retried with bounded backoff, because a 5xx says
"not now" rather than "no".

Note the receiver deduplicates on what it has ACTED on, not on what it has
seen. A retry after a transient failure is a fresh attempt at work that never
happened; treating it as a duplicate would silently drop the release.
TXT
pause

step "Done"
cat <<'TXT'
What this demonstrated:

  * a finalized approval emitting an effect, as part of consensus
  * one member performing it, while all three agree it happened
  * a deterministic Idempotency-Key, so at-least-once delivery is safe
  * the outcome written BACK into committed state — exactly once
  * 4xx as permanent, 5xx as retryable, and the approval surviving both
  * decision and effect kept as separate facts

What it does NOT do:

  * It does not make the external system transactional. The chain records
    what the ERP said; it cannot undo what the ERP did.
  * The receiver must deduplicate. Delivery is at-least-once by design, and
    no amount of chain-side care changes that.

Try it yourself:

  node src/cli.js effects
  node src/cli.js show <orderId>
  node receiver.js --fail-4xx      # then approve something

  ./cluster stop      stop, keep data
  ./cluster clean     stop and wipe

See DEMO.md for the narrated version and README.md for how it works.
TXT
