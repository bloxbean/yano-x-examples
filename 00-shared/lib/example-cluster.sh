#!/usr/bin/env bash
# Shared cluster facade for the examples in this repository.
#
# Every example gets its own isolated Yano home under <example>/.yano so the
# extracted distribution is never modified and two examples can run at the
# same time on different ports. The layout follows the same pattern the
# bundled showcase uses: a real config/ directory plus symlinks back to the
# distribution for the jar, plugins, tools and the cluster launcher.
#
# Sourced by each example's ./cluster script:
#
#   . "$REPO/00-shared/lib/example-cluster.sh"
#   example_cluster "$EXAMPLE_DIR" "$@"

set -euo pipefail

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# Locate the extracted Yano X JVM distribution.
#   $1 = repository root
resolve_distribution() {
  local repo="$1" candidate

  if [ -n "${YANO_X_DIST:-}" ]; then
    [ -f "$YANO_X_DIST/yano.jar" ] \
      || die "YANO_X_DIST=$YANO_X_DIST does not contain yano.jar"
    (cd "$YANO_X_DIST" && pwd -P)
    return
  fi

  for candidate in "$repo"/yano-x-jvm-*; do
    [ -f "$candidate/yano.jar" ] || continue
    (cd "$candidate" && pwd -P)
    return
  done

  die "no Yano X JVM distribution found under $repo. Extract one there, or set YANO_X_DIST."
}

# Build <example>/.yano: a private Yano home whose config/ is the
# distribution's config with this example's chain definitions overlaid.
#   $1 = example directory   $2 = distribution root
prepare_yano_home() {
  local example="$1" dist="$2" home="$1/.yano" entry name

  [ -f "$example/chain/application-appchain.yml" ] \
    || die "missing $example/chain/application-appchain.yml"

  mkdir -p "$home"

  # config/ is a real copy so the example can own its chain definitions.
  # Refresh it on every start: the example's YAML is the source of truth.
  rm -rf "$home/config"
  cp -R "$dist/config" "$home/config"
  cp "$example/chain/application-appchain.yml" "$home/config/application-appchain.yml"

  # Everything else points back at the distribution.
  for entry in "$dist"/*; do
    name="${entry##*/}"
    case "$name" in config|examples) continue;; esac
    [ -e "$home/$name" ] || [ -L "$home/$name" ] || ln -s "$entry" "$home/$name"
  done

  printf '%s\n' "$home"
}

# Run the bundled cluster launcher against this example's private home.
#   $1 = example directory, rest = cluster.sh arguments
example_cluster() {
  local example="$1"; shift
  local repo dist home data http_base server_base

  example="$(cd "$example" && pwd -P)"
  repo="$(cd "$example/.." && pwd -P)"

  need java; need python3; need curl; need jq

  dist="$(resolve_distribution "$repo")"
  home="$(prepare_yano_home "$example" "$dist")"
  data="$example/.yano/data"

  # Per-example port ranges keep concurrent examples from colliding.
  http_base="${EXAMPLE_HTTP_BASE:-7070}"
  server_base="${EXAMPLE_SERVER_BASE:-13337}"

  [ $# -gt 0 ] || die "usage: ./cluster <start [N]|status|stop|clean|submit|logs|...>"

  # The node refuses a symlinked plugin directory; hand it the real path.
  export YANO_PLUGINS_DIRECTORY="$dist/plugins"
  export YANO_HOME="$home"

  local -a args=("$1"); shift
  case "${args[0]}" in
    start)
      # Pass the example's fixed ports and data directory on start only;
      # later commands read them back from <data>/cluster.env.
      while [ $# -gt 0 ]; do args+=("$1"); shift; done
      args+=(--data-dir "$data" --http-base "$http_base" --server-base "$server_base")
      ;;
    *)
      while [ $# -gt 0 ]; do args+=("$1"); shift; done
      args+=(--data-dir "$data")
      ;;
  esac

  exec "$home/appchain-cluster/cluster.sh" "${args[@]}"
}
