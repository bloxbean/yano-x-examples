# Shared tooling

Things every example reuses. You do not need to read this to run an example —
it exists so the examples themselves stay short.

## `lib/example-cluster.sh`

Gives each example its own isolated chain without touching the extracted
distribution.

When you run `./cluster start 3` inside an example, this script:

1. Finds the Yano X distribution (`YANO_X_DIST`, or `yano-x-jvm-*` in the repo
   root).
2. Builds a private Yano home at `<example>/.yano/`:
   - `config/` is a **copy** of the distribution's config, with the example's
     own `chain/application-appchain.yml` dropped in — so the example owns its
     chain definitions.
   - Everything else (`yano.jar`, `plugins/`, `tools/`, the cluster launcher)
     is **symlinked** back to the distribution.
3. Runs the bundled `appchain-cluster/cluster.sh` against that home, with the
   example's own data directory and port range.

This is the same pattern the distribution's own showcase uses. The result:

- the extracted distribution is never modified
- two examples can run side by side on different ports
- `./cluster clean` wipes one example without affecting anything else

### Used by an example

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"

export EXAMPLE_HTTP_BASE=7100        # this example's port range
export EXAMPLE_SERVER_BASE=13400

. "$HERE/../00-shared/lib/example-cluster.sh"
example_cluster "$HERE" "$@"
```

### Port assignments

Keep these distinct so examples can run at the same time.

| Example | HTTP | n2n |
|---|---|---|
| 01 — audit log | 7100–7102 | 13400–13402 |
| 02 — service registry | 7110–7112 | 13410–13412 |
| 03 — batch release | 7130–7132 | 13430–13432 |

### Environment

| Variable | Meaning |
|---|---|
| `YANO_X_DIST` | Path to the extracted distribution. Defaults to `yano-x-jvm-*` in the repo root. |
| `EXAMPLE_HTTP_BASE` | First HTTP port; node *i* listens on base + *i*. |
| `EXAMPLE_SERVER_BASE` | First node-to-node port. |
| `YANO_CLUSTER_API_KEY` | Admin API key. Defaults to the launcher's known local-demo key — fine on a laptop, never on a shared machine. |

## A note on the demo keys

The cluster launcher uses deterministic demo identities: node *i*'s seed is the
byte `i+1` repeated 32 times. They are published in the distribution's own
documentation. They exist so an example starts in one command.

They are not secret and must never be used for anything real.
