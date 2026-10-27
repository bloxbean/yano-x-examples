# Adding a game chain to a running cluster

How `duels-chain`, which runs the [Sealed Duels plugin](plugin/), joined a
cluster that already had history, without restarting the other chains from
genesis. First on the local cluster (done and verified), then on the five-member
preprod showcase (a written procedure, not yet executed).

## Why this is safe

Every chain on a member is independent: it has its own genesis id, store
(`appchain-chainstate/<chain>`), consensus and anchor thread. A new
`chains[n]` entry starts at height 0 next to the others. The other chains keep
their identity, `(commitment-profile, format-fingerprint, genesis-id)`, and
continue from their retained height.

Three things do change:

1. **Plugins are loaded at start-up.** There is no hot reload, so every member
   restarts once with the JAR in its plugins directory and the bundle in
   `yano.plugins.allow-list`.
2. **Every member must run the byte-identical JAR.** It decides the new chain's
   roots.
3. **Operator tooling pins the chain list.** The local launcher records the
   chains in `.yano/data/cluster-appchain-identity.json` and refuses to start
   when the configuration names a different list (exit 10). The showcase
   deployer's status gate counts chains (`locked_chain_count`).

What must not change: the order, ids and settings of the existing chain
entries. Append only.

## Local cluster

```bash
(cd plugin && ./gradlew build)   # test, then the JAR (signed: see plugin/README.md)
./cluster stop                   # keeps every chain's data
./cluster migrate                # back up .yano/data, record the new chain in the identity marker
./cluster start 3                # stages the plugins, restarts all three members
```

[`chain/application-appchain.yml`](chain/application-appchain.yml) adds
`plugin-bundle.sealed-duels` to the allow-list and `chains[2]`, with its own
genesis id (`sha256("yano-x-examples/21-anchor-game-center/duels-chain")`).

What [`./cluster`](cluster) does:

- **`start` stages the plugins.** The node refuses a symlinked plugins
  directory, and the distribution stays untouched. So the script copies the
  release's plugins plus `plugin/build/libs/sealed-duels-yano-plugin.jar` into
  `.yano/node-plugins/`, and the shared helper points
  `YANO_PLUGINS_DIRECTORY` there (`EXAMPLE_PLUGINS_DIRECTORY`).
- **`migrate` changes nothing until it has checked.** It refuses while a member
  runs. The configured chains must be the recorded ones, in order, plus new
  ones at the end; removing, renaming or reordering is refused. It copies
  `.yano/data` to `.yano/backups/data-<UTC time>/`, then rewrites the marker in
  the launcher's canonical form (0600, written and fsynced, then renamed). Run
  again, it reports nothing to do.
- **The anchor bootstrap mints duels-chain's thread NFT.** After `start`, the
  shared helper bootstraps every chain that has no anchor yet. On devnet the
  launcher funds the anchor wallet from the faucet.

What was checked on 2026-10-21 (three members, Yano X 0.1.0-pre2, host 0.1.0-pre15):

| | Before | After |
|---|---|---|
| orders-chain | tip 112, root `9d02f7a9…`, anchored | tip 112, same root, anchoring continues |
| authenticated-map-chain | tip 28, root `63eaf88e…` | tip 28, same root; commanders sign in unchanged |
| duels-chain | — | `sealed-duels`, height 0, anchor bootstrapped; then duels played, all members agreeing |

One quirk: the bootstrap runs while the followers are already up. On this
host version they kept refusing the new chain's co-sign requests ("sign request
does not spend my anchor UTxO"), so duels-chain stayed anchored at height 1.
One more `./cluster stop && ./cluster start 3` made them re-read the thread
from L1, and anchoring went on normally. Watch for that line after any anchor
bootstrap on a running cluster.

## The showcase (preprod, five members)

This is a procedure, not a record. Nothing here has been run against the
showcase. The anchor bootstrap spends real preprod test ADA, and the restart
briefly stops all fifteen chains, so each step needs the operator's explicit
go-ahead.

The showcase is the stock `yano-x-deploy` 0.1.0-pre3 render plus an
operator-owned overlay, run through `pre3-ops/reconcile.sh`. The released
deployer, its render lock and the release artifacts are never edited. Two
precedents in `pre3-ops` set the shape. Binding chains 13 and 14 were added to
running members as overlay properties, with fresh genesis ids and a
coordinated restart. The issue-26 bridge hotfix put a digest-pinned JAR on
every member with an owned playbook.

### 1. Build against the showcase's host

Read the host version from the pre3 distribution's
`yano-distribution-v1.json`. Build and check the plugin against that exact API:

```bash
./gradlew build -PyanoJar=<extracted yano-x-jvm-0.1.0-pre3>/yano.jar
<pre3 dist>/tools/yano-plugins/bin/yano-plugins validate --api-major 3 --api-level <host level> \
  build/libs/sealed-duels-yano-plugin.jar
```

Sign the catalog with a publisher key kept with the other operator secrets,
never in a repository. Validate with `--trust-key`. Record the JAR's SHA-256:
it is the only artifact the members may run for this chain.

### 2. Put the JAR on every member, without a restart

Add an owned playbook modelled on `ansible/hotfix.yml`, with `serial: 1` and
`any_errors_fatal`. It should:

1. Check the local JAR against the pinned digest.
2. Copy it into the active plugins directory under `/opt/yano/active`, next to
   the release bundles, owned like them.
3. Verify the digest on the member, and **not** restart.

Stock `deploy.yml` re-copies the release plugins, so `reconcile.sh` has to run
this playbook after `deploy.yml`, as it already does for the hotfix. Keep the
JAR and a provenance note under `pre3-ops/plugins/`.

### 3. Extend the overlay

All of these go in `ansible/templates/pre3-overlay.properties.j2`, which loads
at `config_ordinal=410`, above every stock source:

- **The allow-list.** The render's list has nine entries (indices 0–8), so add
  `yano.plugins.allow-list[9]=plugin-bundle.sealed-duels`. Restating the whole
  list in the overlay is clearer still.
- **The new chain, as index 15**, mirroring the binding-chain block, with
  `state-machine=sealed-duels` and no composite settings:
  - `chain-id=duels-chain`
  - `state.commitment-profile=mpf-blake2b256-v1`
  - `state.format-fingerprint=91ee14091200f1e24659112d640e877e9177779dcc81dd06117f013e9190082b`
  - `state.genesis-id`, a fresh one under the showcase's convention:
    `sha256("yano-x/preprod-contabo/pre3-20260926/genesis/duels-chain")`,
    recorded in `overlay/fresh-genesis-ids.{txt,yml}`
  - membership, members, threshold and peers
  - the sequencer settings
  - `block.interval-ms=1000`
  - the anchor settings on the anchor leader
- **Capacity for 16 chains.** The peer-connection overlay derives from the
  chain count, max(16, chains + 4) per peer.
- **`COUNT=16` in `reconcile.sh`**, so the status gate expects the new chain.

Test the template offline with `scripts/test-overlay-template.sh`, then check
that `reconcile.sh render` and `doctor` still pass.

### 4. Coordinated restart

```bash
pre3-ops/reconcile.sh overlay-restart   # all members restart together, then status with the chain count
```

The existing fifteen chains come back from retained state with unchanged
genesis ids. duels-chain starts at height 0 on all five members.

### 5. Verify before announcing

- `scripts/verify_matrix.py`: identical height and root for all sixteen chains
  on every member, and the same capability-manifest digest.
- `GET /api/v1/app-chain/chains/duels-chain/status` on each member:
  `stateMachine` is `sealed-duels`, and the same members and threshold.
- A plain `admit` query answers: `POST …/duels-chain/query/admit`.
- One test duel, with the record identical on every member
  (`POST …/query/duel`).

### 6. Anchor (preprod transaction, needs authorization)

```bash
pre3-ops/reconcile.sh anchors duels-chain   # mints duels-chain's thread NFT on preprod
```

Then check that co-sign rounds complete and `anchor/commitment` advances. If the
followers log "sign request does not spend my anchor UTxO" (seen locally on host
0.1.0-pre15), restart the followers once.

### 7. The page

[`shared/config.js`](shared/config.js) already names `duelsChain:
'duels-chain'`, so the plugin edition's hub card works as soon as the chain is
up. CORS is configured per origin, not per chain (`api.cors.allowedOrigins`,
see example 20). Whatever origin may call the showcase today may call
duels-chain too, and `node serve.mjs` needs no CORS at all.

### Undo

Remove the chain block and the allow-list entry from the overlay, restore
`COUNT=15`, and run `overlay-restart`. The other chains are untouched. Leave
duels-chain's store on disk and never reuse its genesis id: re-adding the chain
later means a new genesis id and an empty chain.
