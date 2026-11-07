#!/usr/bin/env bash
# Shared cluster facade for the examples in this repository (Yano X 0.1.0-pre6+).
#
# Each example describes its application as an app-chain template,
# chain/<app>.template.yaml, and this script sets it up the way real operators
# would, with the ordinary setup commands of the release:
#
#   yano.sh appchain new <app> --from chain/<app>.template.yaml   the draft
#   yano.sh appchain request <draft>        per member: its key and member card
#   yano.sh appchain seal <draft>           the sealed <app>.chain
#   yano.sh appchain join <app>.chain       per member: check it and set up the node
#   yano.sh appchain start                  per member
#   yano.sh appchain anchor <app> --chain   anchor each chain to Cardano (lead)
#
# All members run on one machine, on a private Cardano devnet produced by the
# lead (node0). Everything lives in <example>/.yano; the extracted distribution
# is never modified: the members run from .yano/release, a private copy whose
# plugins/ holds the release's bundles plus any JARs the example adds.
#
# Sourced by each example's ./cluster script:
#
#   export EXAMPLE_HTTP_BASE=7100 EXAMPLE_SERVER_BASE=13400
#   . "$REPO/00-shared/lib/example-cluster.sh"
#   example_cluster "$EXAMPLE_DIR" "$@"
#
# Optional, set by the example before example_cluster:
#   EXAMPLE_PLUGIN_JARS      space-separated plugin JARs to add to plugins/
#   example_local_config     a shell function called as  example_local_config <n> <node-dir>
#                            after join; it may write <node-dir>/config/local.yaml
#                            (node-local settings such as an effect executor)
#   example_after_start      a shell function called after the members are live
#                            and anchoring has started (e.g. one-time bootstrap)

set -euo pipefail

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# Locate the extracted Yano X JVM distribution: $YANO_X_DIST, else the newest
# yano-x-jvm-* in the repository that has the app-chain setup tool (pre6+).
#   $1 = repository root
resolve_distribution() {
  local repo="$1" candidate best=""

  if [ -n "${YANO_X_DIST:-}" ]; then
    [ -x "$YANO_X_DIST/tools/yano-appchain/bin/yano-appchain" ] \
      || die "YANO_X_DIST=$YANO_X_DIST is not a Yano X 0.1.0-pre6 (or later) distribution"
    (cd "$YANO_X_DIST" && pwd -P)
    return
  fi

  for candidate in "$repo"/yano-x-jvm-*/; do
    [ -x "$candidate/tools/yano-appchain/bin/yano-appchain" ] || continue
    best="$candidate"   # glob order: the last match is the newest prerelease
  done
  [ -n "$best" ] || die "no Yano X 0.1.0-pre6 (or later) distribution under $repo. Extract one there, or set YANO_X_DIST."
  (cd "$best" && pwd -P)
}

# .yano/release: yano.sh copied (it takes its home from its own directory),
# every other entry linked back to the distribution, and a real plugins/
# directory with the release's bundles plus the example's own JARs. seal pins
# every bundle's digest and join refuses a node whose plugins differ, so all
# members share this one directory.
#   $1 = distribution root   $2 = release directory
prepare_release() {
  local dist="$1" release="$2" entry name jar keep
  mkdir -p "$release/plugins"
  for entry in "$dist"/*; do
    name="${entry##*/}"
    case "$name" in yano.sh|plugins) continue ;; esac
    [ -e "$release/$name" ] || [ -L "$release/$name" ] || ln -s "$entry" "$release/$name"
  done
  cmp -s "$dist/yano.sh" "$release/yano.sh" 2>/dev/null || cp "$dist/yano.sh" "$release/yano.sh"
  for jar in "$release"/plugins/*.jar; do
    [ -e "$jar" ] || continue
    keep=0
    [ -f "$dist/plugins/${jar##*/}" ] && keep=1
    for name in ${EXAMPLE_PLUGIN_JARS:-}; do [ "${name##*/}" = "${jar##*/}" ] && keep=1; done
    [ "$keep" = 1 ] || rm -f "$jar"
  done
  for jar in "$dist"/plugins/*.jar ${EXAMPLE_PLUGIN_JARS:-}; do
    [ -f "$jar" ] || die "plugin JAR not found: $jar"
    cmp -s "$jar" "$release/plugins/${jar##*/}" || cp "$jar" "$release/plugins/"
  done
}

example_cluster() {
  local example="$1"; shift
  example="$(cd "$example" && pwd -P)"

  local repo="${example%/*}"
  local state="$example/.yano"
  local release="$state/release"
  local appdir="$state/app"
  local http_base="${EXAMPLE_HTTP_BASE:-7070}"
  local server_base="${EXAMPLE_SERVER_BASE:-13337}"
  local template app

  template="$(ls "$example"/chain/*.template.yaml 2>/dev/null | head -1)"
  [ -n "$template" ] || die "missing $example/chain/<app>.template.yaml"
  app="${EXAMPLE_APP:-$(basename "$template" .template.yaml)}"

  node_dir() { printf '%s/node%s' "$state" "$1"; }
  appchain() { "$release/yano.sh" appchain "$@"; }
  members() {
    local n=0
    while [ -d "$(node_dir "$n")" ]; do n=$((n + 1)); done
    printf '%s' "$n"
  }
  running() {
    curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$((http_base + $1))/api/v1/app-chain/chains" 2>/dev/null
  }
  chain_ids() {
    appchain inspect "$appdir/$app.chain" --json | jq -r '.application.genesis.chains[].id'
  }

  local command="${1:-}"
  [ $# -gt 0 ] && shift

  case "$command" in
    start)
      local nodes=3 anchoring=1 arg
      for arg in "$@"; do
        case "$arg" in
          --no-anchor) anchoring=0 ;;
          ''|*[!0-9]*) die "unknown option: $arg (usage: ./cluster start [members] [--no-anchor])" ;;
          *) nodes="$arg" ;;
        esac
      done
      [ "$nodes" -ge 1 ] || die "need at least one member"
      need java; need jq; need curl

      local dist
      dist="$(resolve_distribution "$repo")"
      note "$(basename "$example") on $(basename "$dist")"
      prepare_release "$dist" "$release"
      mkdir -p "$appdir"
      chmod 700 "$state"

      # new -> request per member -> seal. Skipped once sealed.
      local draft="$appdir/$app.draft.yaml" sealed="$appdir/$app.chain" i operators=""
      if [ -f "$sealed" ]; then
        local have
        have="$(appchain inspect "$sealed" --json | jq '.application.genesis.members | length')"
        [ "$have" = "$nodes" ] || die "this example is sealed with $have members; ./cluster clean first to change that"
      else
        for ((i = 0; i < nodes; i++)); do operators+="${operators:+,}node$i"; done
        if [ ! -f "$draft" ]; then
          appchain new "$app" --from "$template" --network devnet --operators "$operators" \
            --threshold majority --output "$appdir" --yes >/dev/null || die "could not write the draft"
        fi
        for ((i = 0; i < nodes; i++)); do
          [ -f "$appdir/node$i.member" ] && continue
          appchain request "$draft" --name "node$i" --host 127.0.0.1 --node-port $((server_base + i)) \
            --http-port $((http_base + i)) --node-dir "$(node_dir "$i")" --output "$appdir" --yes >/dev/null \
            || die "node$i could not make its member card"
        done
        appchain seal "$draft" --output "$appdir" >/dev/null || die "could not seal $draft"
      fi

      # join per member, against the fingerprint the coordinator read out.
      local fingerprint
      fingerprint="$(appchain inspect "$sealed" --json | jq -r .displayFingerprint)"
      for ((i = 0; i < nodes; i++)); do
        if [ ! -f "$(node_dir "$i")/apps/$app.chain" ]; then
          appchain join "$sealed" --expect-fingerprint "$fingerprint" --node-dir "$(node_dir "$i")" --yes >/dev/null \
            || die "node$i could not join $app"
        fi
        if declare -F example_local_config >/dev/null; then
          example_local_config "$i" "$(node_dir "$i")"
        fi
      done
      note "  $app sealed: fingerprint $fingerprint"

      # The lead (node0) starts first: on a devnet its node produces Cardano.
      for ((i = 0; i < nodes; i++)); do
        if running "$i"; then
          note "  node$i is already running"
          continue
        fi
        appchain start --node-dir "$(node_dir "$i")" --timeout 300 | grep -v -e "^Next:" -e "^$" | sed "s/^/  /" \
          || die "node$i did not start; ./cluster logs $i"
      done
      appchain status "$app" --node-dir "$(node_dir 0)" --wait live --timeout 300 >/dev/null \
        || die "the application did not go live; ./cluster status"

      # Anchor every chain to Cardano in script mode: a Plutus V3 thread NFT whose
      # datum chain the validator enforces, co-signed by a threshold of members.
      if [ "$anchoring" = 1 ]; then
        local chain out
        for chain in $(chain_ids); do
          if out="$(appchain anchor "$app" --chain "$chain" --node-dir "$(node_dir 0)" --yes --timeout 300 2>&1)"; then
            note "  anchor: $chain in script mode, led by node0"
          else
            printf '%s\n' "$out" | tail -3 | sed 's/^/  /'
            note "  anchor: $chain did not start anchoring; ./cluster logs 0"
          fi
        done
      fi

      if declare -F example_after_start >/dev/null; then
        example_after_start
      fi
      note "  members: HTTP $http_base..$((http_base + nodes - 1))"
      ;;

    status)
      [ -d "$(node_dir 0)" ] || die "not set up yet: ./cluster start"
      appchain status "$app" --node-dir "$(node_dir 0)" || true
      # Every member's tip and state root, chain by chain: they should agree.
      local chain i n body
      n="$(members)"
      for chain in $(chain_ids); do
        note ""
        note "$chain"
        for ((i = 0; i < n; i++)); do
          if body="$(curl -fsS --max-time 3 "http://127.0.0.1:$((http_base + i))/api/v1/app-chain/chains/$chain/status" 2>/dev/null)"; then
            printf '  node%s  height %-7s root %s\n' "$i" \
              "$(jq -r '.tipHeight // "?"' <<<"$body")" \
              "$(jq -r '(.stateRoot // .stateCommitment.root // "?") | .[0:16]' <<<"$body")"
          else
            printf '  node%s  not answering on :%s\n' "$i" "$((http_base + i))"
          fi
        done
      done
      ;;

    stop)
      local i
      if [ -n "${1:-}" ]; then          # ./cluster stop <n>: just that member
        [ -d "$(node_dir "$1")" ] || die "no member $1"
        appchain stop --node-dir "$(node_dir "$1")" | sed 's/^/  /'
        return
      fi
      for ((i = $(members) - 1; i >= 0; i--)); do
        appchain stop --node-dir "$(node_dir "$i")" | sed 's/^/  /'
      done
      ;;

    logs)
      [ -n "${1:-}" ] || die "usage: ./cluster logs <member number> [-f]"
      local log
      log="$(node_dir "$1")/logs/node.log"
      [ -f "$log" ] || die "no log for member $1 yet"
      if [ "${2:-}" = "-f" ]; then exec tail -F "$log"; else tail -n 200 "$log"; fi
      ;;

    clean)
      if [ -d "$state" ]; then
        local i
        for ((i = $(members) - 1; i >= 0; i--)); do
          appchain stop --node-dir "$(node_dir "$i")" >/dev/null 2>&1 || true
        done
        rm -rf "$state"
      fi
      note "Removed $state"
      ;;

    *)
      cat >&2 <<EOF
usage: ./cluster <command>
  start [members] [--no-anchor]   seal and start the application (3 members by default)
  status                          the application's stage, and every member's tip and root
  logs <n> [-f]                   member n's log
  stop [n]                        stop the members (or just member n), keep the data
  clean                           stop and delete .yano/ (chains, keys, devnet)
EOF
      exit 2
      ;;
  esac
}
