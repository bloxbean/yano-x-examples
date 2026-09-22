#!/usr/bin/env bash
# Guided walkthrough of example 03 — pharmaceutical batch release.
#
#   ./demo.sh          run the story, pausing between steps
#   ./demo.sh --fast   run it without pauses
#
# Assumes the chain is up:  ./cluster start 3 --anchor-mode metadata
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
cd "$HERE"

APP=(java -jar target/batch-release.jar)
BATCH="${BATCH:-BATCH-2026-0042}"
BATCH2="${BATCH2:-BATCH-2026-0043}"
PAUSE=1
[ "${1:-}" = "--fast" ] && PAUSE=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m── %s\033[0m\n\n' "$*"; }
pause() { [ "$PAUSE" = 1 ] && { printf '\n\033[2m[enter to continue]\033[0m'; read -r _; } || true; }
run()   { dim "\$ batch ${*:3}"; "$@"; }
# A command we EXPECT to be refused.
expect_refused() { dim "\$ batch ${*:3}"; if "$@"; then echo "UNEXPECTED: that should have been refused"; exit 1; fi; }

[ -f target/batch-release.jar ] || { bold "Building ..."; mvn -q -B package 2>/dev/null || { mvn -B package; exit 1; }; }

curl -fsS "http://127.0.0.1:7130/api/v1/app-chain/chains/batch-release-chain/status" >/dev/null 2>&1 || {
  printf 'error: batch-release-chain is not reachable on 127.0.0.1:7130\n' >&2
  printf '       start it with:  ./cluster start 3 --anchor-mode metadata\n' >&2
  exit 1
}

clear
bold "Pharmaceutical batch release"
cat <<'TXT'

Before a medicine reaches a patient, a batch passes three sign-offs:

  QC  Quality Control    — release testing, by two analysts
  QA  Quality Assurance  — deviations and batch-record review
  QP  Qualified Person   — the named individual who certifies the batch
                           for release and is personally liable for it

The people who sign are not the machines that run the chain. Three member
nodes transport and finalize commands; the signatures come from named people
with their own keys, in three different organizations.

And people change. This scenario also replaces the Qualified Person midway,
which is an ordinary event in a real plant — and shows what happens to the
batches she already certified.
TXT
pause

step "1. The cast, and what each stage requires"
run "${APP[@]}" cast
pause

step "2. Stage 1 — Quality Control, needs TWO analysts"
run "${APP[@]}" open "$BATCH" --stage qc-results
run "${APP[@]}" sign "$BATCH" --stage qc-results --actor qc-anna
cat <<'TXT'

Still PENDING. One analyst is not enough.
TXT
pause

step "3. The same analyst signing twice does not count twice"
run "${APP[@]}" sign "$BATCH" --stage qc-results --actor qc-anna --via 2
cat <<'TXT'

Anna signed again, relayed by a different member node this time. Still one
decision. The clause counts DISTINCT ACTORS, so a person cannot be their own
second pair of eyes — and routing the command through another node changes
nothing, because the node is not who is signing.
TXT
pause

step "4. A second, different analyst completes the stage"
run "${APP[@]}" sign "$BATCH" --stage qc-results --actor qc-ben --via 1
pause

step "5. Stage 3 cannot start before stage 2"
expect_refused "${APP[@]}" open "$BATCH" --stage qp-release
cat <<'TXT'

The application refused to build the record, because each stage's signed
payload commits to the previous stage's proposal and hash. There is nothing
valid to chain to yet.

Worth being precise: that check is the APPLICATION's. A policy is an unordered
AND of clauses and cannot express "stage 2 before stage 3". See the Future
enhancements section in the README.
TXT
pause

step "6. Stage 2 — Quality Assurance"
run "${APP[@]}" open "$BATCH" --stage qa-review
run "${APP[@]}" sign "$BATCH" --stage qa-review --actor qa-dev
pause

step "7. Stage 3 — the Qualified Person certifies"
run "${APP[@]}" open "$BATCH" --stage qp-release
run "${APP[@]}" sign "$BATCH" --stage qp-release --actor qp-elena
run "${APP[@]}" sign "$BATCH" --stage qp-release --actor auditor-gita
cat <<'TXT'

Elena has certified and Gita has reviewed. Still pending: the policy wants TWO
independent auditors.
TXT
pause

step "8. Two auditors from the SAME firm are not two independent reviews"
run "${APP[@]}" sign "$BATCH" --stage qp-release --actor auditor-iris
cat <<'TXT'

Iris works at Helix Labs — so does Gita. Her decision was not accepted at all;
the count is unchanged.

This clause counts DISTINCT ORGANIZATIONS. It is the difference between "two
signatures" and "two independent opinions", and it is enforced by every member
rather than by whoever operates the registry.
TXT
pause

step "9. An auditor from a different firm completes the release"
run "${APP[@]}" sign "$BATCH" --stage qp-release --actor auditor-hugo --via 2
pause

step "10. The full trail"
run "${APP[@]}" show "$BATCH"
cat <<'TXT'

Every decision carries who signed, for which organization, under which role,
at which actor revision, with which key, and at what height.
TXT
pause

step "11. The Qualified Person leaves. Her successor takes over."
run "${APP[@]}" replace --leaving qp-elena --joining qp-farid
pause

step "12. The departed QP can no longer certify anything"
run "${APP[@]}" open "$BATCH2" --stage qc-results
run "${APP[@]}" sign "$BATCH2" --stage qc-results --actor qc-anna
run "${APP[@]}" sign "$BATCH2" --stage qc-results --actor qc-cleo
run "${APP[@]}" open "$BATCH2" --stage qa-review
run "${APP[@]}" sign "$BATCH2" --stage qa-review --actor qa-dev
run "${APP[@]}" open "$BATCH2" --stage qp-release
run "${APP[@]}" sign "$BATCH2" --stage qp-release --actor qp-elena
cat <<'TXT'

Elena's signature is cryptographically valid and was relayed normally. It was
not accepted, because her current registry revision is REVOKED. A statement
must name the actor's current revision, so an old one cannot be replayed.
TXT
pause

step "13. Her successor can"
run "${APP[@]}" sign "$BATCH2" --stage qp-release --actor qp-farid
run "${APP[@]}" sign "$BATCH2" --stage qp-release --actor auditor-gita
run "${APP[@]}" sign "$BATCH2" --stage qp-release --actor auditor-hugo --via 1
pause

step "14. And the batch Elena certified is still certified"
run "${APP[@]}" show "$BATCH" --stage qp-release
cat <<'TXT'

This is the point of the whole example.

Revocation stops FUTURE decisions. It cannot rewrite a finalized authorization.
Elena's certification of the first batch still names her, her organization, her
revision at the time, and her key — and still proves APPROVED.

A regulator asking "who released this batch, and were they authorized then?"
gets an answer that does not depend on who works there now.
TXT
pause

step "15. Anchored to Cardano"
# The anchor wallet is funded from the devnet faucet. On a public network you
# would fund it yourself and guard the key — see README.md.
ANCHOR_ADDR="$("${APP[@]}" anchor 2>/dev/null | awk '/anchor wallet/{print $3}')"
if [ -n "$ANCHOR_ADDR" ] && [ "$("${APP[@]}" anchor 2>/dev/null | awk '/anchored count/{print $3}')" = "0" ]; then
  dim "\$ curl -X POST .../devnet/fund  (faucet, devnet only)"
  curl -s -X POST "http://localhost:7130/api/v1/devnet/fund" \
    -H 'Content-Type: application/json' \
    -d "{\"address\":\"$ANCHOR_ADDR\",\"ada\":500}" >/dev/null || true
  printf '  waiting for the first anchor transaction'
  for _ in $(seq 1 30); do
    [ "$("${APP[@]}" anchor 2>/dev/null | awk '/anchored count/{print $3}')" != "0" ] && break
    printf '.'; sleep 5
  done
  printf '\n\n'
fi
run "${APP[@]}" anchor
pause

step "Done"
cat <<'TXT'
What this demonstrated:

  * business actors signing independently of the member nodes that relay them
  * a multi-stage release: QC (2 analysts) -> QA -> QP + 2 independent auditors
  * DISTINCT ACTOR vs DISTINCT ORGANIZATION, and why both exist
  * stages chained by payload, so a later stage names the earlier one
  * replacing a role holder on a running chain, with proof-of-possession
  * revocation blocking new decisions while past ones stay valid
  * the whole history committed in a Cardano transaction

Try it yourself:

  java -jar target/batch-release.jar cast
  java -jar target/batch-release.jar show BATCH-2026-0042
  java -jar target/batch-release.jar onboard qc-cleo
  ./cluster status

  ./cluster stop      stop, keep the data
  ./cluster clean     stop and wipe

See DEMO.md for the narrated version and README.md for how it works.
TXT
