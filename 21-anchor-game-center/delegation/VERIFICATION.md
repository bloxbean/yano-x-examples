# ADR-038 MX5 / V4 verification

The final three-member qualification passed on 2026-10-26, from
16:39:53 UTC to 16:42:06 UTC. All members were stopped afterwards. This was a
new isolated local devnet on HTTP ports 28970–28972, with anchoring disabled.
No retained deployment, user key, or public-network transaction was used.

## Exact inputs

| Input | Identity |
| --- | --- |
| Yano host | `0.1.0-pre19-7f92fbe6a-SNAPSHOT` |
| Host revision | `7f92fbe6a150fa1320ac089a88f1a3334efd71e1` |
| Yano X distribution | `yano-x-jvm-0.1.0-pre4.zip` |
| ZIP SHA-256 | `1cc44e322d7eec6d59f3ec81b747cf906cff2ab122bb4543b133a2024107e407` |
| Packaged runner JAR SHA-256 | `a93465df0a9f363caf4fc01e9c3b43065cd878462bc1f123ded9f39e5ed337c6` |
| Ride schema hash | `4c7c6732977a8fb971e13200d87f39679634bc07e7b5499c8e87aa24e8de5b50` |

The browser SDK is vendored with file digests in
[`shared/topic-client/provenance.json`](../shared/topic-client/provenance.json).
`node scripts/check-topic-client.mjs` verifies these release copies without a
Yano or Yano X source checkout. The qualification additionally compared them
with the MX2 SDK sources.

## Results

`npm test` passed all 66 game checks and 13 Node tests. These cover bounded
delegation requests, possession proof, duplicate/concurrent requests, nonce
capacity and expiry, private key-file handling, immutable profile generation
checks, browser session storage, bootstrap guards, the plugin launcher, and
static-file path and symlink guards. The SDK gates passed 78 JavaScript tests
and 91 Java client tests, including all 33 valid and 23 malformed core wire
vectors.

The packaged [`live-v4.mjs`](../test/topics/live-v4.mjs) run passed all 23
checks recorded in [`report.json`](evidence/v4/report.json):

- A real revision-one commander profile authenticated a fresh signed service
  request. A public profile or copied request could not authorize a new key.
- A non-extractable browser-compatible session key signed a canonical CBOR
  ride. The peer accepted the frame; reads preserved its message ID, height
  and index. The test verified the commander signature and replayed all
  2,200 game frames.
- All three hosts refused forged signatures, malformed frames, reused write
  proofs, expired proofs, schema-invalid rides and out-of-scope credentials.
  The negative frames reached the node APIs; SDK-side rejection alone was
  not counted as admission evidence.
- Block and parent certificates were verified cryptographically against the
  configured two-of-three member keys. The complete delegated-authorship
  proof verified against those pinned block and parent roots.
- Issuer rotation invalidated the old credential; the new issuer's refreshed
  session wrote successfully. Threshold governance recovered topic ownership,
  and the replacement owner then updated the policy. The ride schema remained
  active through rotation, recovery and restart.
- Two members finalized another framed write while the third was stopped.
  On restart, the follower retrieved that missed frame. All three members
  agreed on the final height, root, commitment profile, genesis, generation
  and capability-manifest digest on both chains. Full restart also preserved
  the original ride's body, height, index and verified historical roots.

The final Neon state was height **17**, root
`370e57904ad47ba5c6ef47b76051d84d309398f9326ec4de84acb9a866581a08`.
The profile chain was height **1**, root
`f4fcfd52b05c7f42f9e6f92c99dc6869e67c8e8eb287e80846e65bd04fd90171`.
Full identity and capability digests are recorded in the report and
[`after-restart-status.json`](evidence/v4/after-restart-status.json).
The pre-restart status file contains the two active quorum members while the
follower was stopped; the post-restart file contains all three.

## Offline proof and trust

After stopping all members, the packaged CLI verified the copied public
bundle again, producing [`offline-verification.json`](evidence/v4/offline-verification.json):

```bash
yano.sh appchain topics verify \
  073e7a46272774b7d838401a89f87b9e2f9dcd9d85216041146937dd8dc1adc8 \
  --bundle delegation/evidence/v4/authorship-bundle.json \
  --trusted-block delegation/evidence/v4/trusted-block.json
```

The result is `verified: true`, `writerKind: delegated`, and
`trust: CALLER_PINNED_BLOCK_AND_PARENT_ROOT`. The driver established that pin
by verifying threshold certificates against the configured member keys in
[`cluster-public-identity.json`](evidence/v4/cluster-public-identity.json).
The original ride-block certificate and inclusion evidence are retained in
[`message-package.json`](evidence/v4/message-package.json). This local run
does not claim a Cardano anchor or durable availability; the CLI correctly
reports `availability: NOT_PROVEN`.

Only public proof/status artifacts and the sanitized run/stop logs are copied
under [`evidence/v4`](evidence/v4/). Their SHA-256 digests are recorded in
[`SHA256SUMS`](evidence/v4/SHA256SUMS). Private service/member files and node
stores remain outside the source tree.

## Independent review and iteration

Separate review agents examined the SDK, delegation service, browser use,
static server, launch helper and live driver. Their findings led to regression
tests and fixes for asynchronous signer-output aliasing, encoded static paths,
internal symlink aliases, missing profile-generation pinning, and schema
preservation during policy replacement. The reviewed launcher fix preserves
the distribution default while honoring the reference's staged plugin
directory. Reviewers reran the relevant tests and reported no remaining
P0–P2 findings in those reviewed paths.

This reference deliberately uses a fresh prerelease chain. It does not qualify
migration of retained prerelease state, a replicated delegation-service nonce
store, or browser verification of historical issuer policy. The runbook states
these boundaries and describes the complete offline proof path.
