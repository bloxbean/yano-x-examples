#!/usr/bin/env bash
# Guided walkthrough of example 04 — Catalyst-style milestone disbursement.
#
#   ./demo.sh          run the story, pausing between steps
#   ./demo.sh --fast   run it without pauses
#
# Assumes the chain is up:  ./cluster start 3 --anchor-mode metadata
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
cd "$HERE"

APP=(java -jar target/disbursement.jar)
M1="${M1:-M1-alpha}"
M2="${M2:-M2-beta}"
PAYEE="${PAYEE:-addr_test1qqagkw45tlrf7nnl94qetz3h3chadpec9rrqzrzlra58x4wlf2c8g97fguatqq6pjc49vpu8p76u5ugmj07t9f7aw4psgy9gtn}"
PAUSE=1
[ "${1:-}" = "--fast" ] && PAUSE=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m── %s\033[0m\n\n' "$*"; }
pause() { [ "$PAUSE" = 1 ] && { printf '\n\033[2m[enter to continue]\033[0m'; read -r _; } || true; }
run()   { dim "\$ disburse ${*:3}"; "$@"; }
expect_refused() { dim "\$ disburse ${*:3}"; if "$@"; then echo "UNEXPECTED: that should have been refused"; exit 1; fi; }

[ -f target/disbursement.jar ] || { bold "Building ..."; mvn -q -B package 2>/dev/null || { mvn -B package; exit 1; }; }

curl -fsS "http://127.0.0.1:7140/api/v1/app-chain/chains/disbursement-chain/status" >/dev/null 2>&1 || {
  printf 'error: disbursement-chain is not reachable on 127.0.0.1:7140\n' >&2
  printf '       start it with:  ./cluster start 3 --anchor-mode metadata\n' >&2
  exit 1
}

clear
bold "Catalyst-style milestone disbursement"
cat <<'TXT'

A fund pays a project when a milestone is accepted. Two questions have to be
answered honestly afterwards:

  Who approved this payment?        — and were they entitled to?
  Is this the payment they approved? — or a different one?

The second question is where approval workflows usually go vague. An approval
records "milestone 1 accepted"; a separate system then builds and sends a
transaction. Nothing ties the two together, so nothing stops the amount or the
recipient changing in between.

This example removes that gap: what reviewers sign is the payout transaction's
id — which IS the hash of its body. The approval names one exact payment, and
anyone can check it against Cardano.
TXT
pause

step "1. The reviewers"
run "${APP[@]}" cast
pause

step "2. The fund's treasury on Cardano"
run "${APP[@]}" treasury --fund 2000
cat <<'TXT'

The node running the app chain is also a Cardano node, and its REST API is
Blockfrost-shaped — so an ordinary Cardano library builds and submits against
it with no extra service. On devnet the faucet tops up the treasury.
TXT
pause

step "3. Build the payout — unsigned"
run "${APP[@]}" prepare "$M1" --to "$PAYEE" --ada 500
cat <<'TXT'

Note what has NOT happened: the treasury key has not signed anything. The
transaction exists, it has an id, and that id is what reviewers will authorize.
TXT
pause

step "4. Nothing can be paid before it is reviewed"
expect_refused "${APP[@]}" execute "$M1"
pause

step "5. Open the payout for review"
run "${APP[@]}" propose "$M1"
cat <<'TXT'

The payload hash on the chain is the transaction id from step 3. The payload
domain says what that hash means: a Cardano transaction id.
TXT
pause

step "6. One reviewer is not enough"
run "${APP[@]}" review "$M1" --actor reviewer-omar
pause

step "7. And a second reviewer from the SAME guild is still not enough"
run "${APP[@]}" review "$M1" --actor reviewer-quinn --via 1
cat <<'TXT'

Quinn's decision was not accepted at all. Omar and Quinn are both Guild North,
and the clause counts DISTINCT ORGANIZATIONS.

Money moves on this decision, so "two signatures" is not the control — "two
independent organizations" is. Every member enforces that identically.
TXT
pause

step "8. A reviewer from a different guild completes it"
run "${APP[@]}" review "$M1" --actor reviewer-pia --via 2
pause

step "9. Now someone quietly raises the amount"
run "${APP[@]}" tamper "$M1" --ada 900
cat <<'TXT'

The payout has been swapped for a larger one, after approval. This is the
attack the whole design is aimed at.
TXT
pause

step "10. The payment is refused"
expect_refused "${APP[@]}" execute "$M1"
cat <<'TXT'

Changing the amount changed the transaction body, so it changed the
transaction id — and the id no longer matches what reviewers approved.

No policy engine and no extra check had to notice the amount specifically.
Any change at all to the payment produces a different id.
TXT
pause

step "11. Restore the approved payout and pay it"
run "${APP[@]}" prepare "$M1" --to "$PAYEE" --ada 500
cat <<'TXT'

Rebuilding the same payment reproduces the same id, so a reviewer could
independently reconstruct the transaction and confirm what they are signing.

TXT
run "${APP[@]}" execute "$M1"
pause

step "12. Check it from the outside"
run "${APP[@]}" show "$M1"
cat <<'TXT'

The approved hash on the app chain and the transaction id on Cardano are the
same value. An auditor needs no access to the fund's systems: look up the
transaction on chain, look up the approval record, compare.
TXT
pause

step "Done"
cat <<'TXT'
What this demonstrated:

  * an approval that names one exact payment, because the approved hash IS
    the Cardano transaction id
  * reviewers signing independently of the nodes that relay their decisions
  * two reviewers required from DISTINCT ORGANIZATIONS before money moves
  * the treasury key signing only after approval — witnesses sit outside the
    transaction body, so signing cannot change the id
  * a payout altered after approval being refused, without any rule that
    mentions amounts
  * an end-to-end check anyone can repeat against Cardano

What it does NOT do:

  * It does not stop whoever holds the treasury key from paying without an
    approval. This is a provable authorization record, not on-chain
    enforcement. README explains what enforcement would take.

Try it yourself:

  java -jar target/disbursement.jar prepare M2-beta --to <addr> --ada 250
  java -jar target/disbursement.jar review M2-beta --actor reviewer-pia
  java -jar target/disbursement.jar show M2-beta

  ./cluster stop      stop, keep data
  ./cluster clean     stop and wipe

See DEMO.md for the narrated version and README.md for how it works.
TXT
