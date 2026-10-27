# Topic SDK snapshot

These unchanged ES modules come from Yano X `sdk/javascript`, implementing
ADR app-layer/038 MX2 against host `0.1.0-pre19-7f92fbe6a-SNAPSHOT`.
`provenance.json` records the source base and SHA-256 digest of every module;
the implementation changes are uncommitted during coordinated development.
The MIT license is included. No package install or sibling checkout is needed.

Run `node scripts/check-topic-client.mjs` from the game center to check the
inventory and bytes. Maintainers can additionally compare an explicit source
directory with `--source /path/to/yano-x/sdk/javascript`. Refresh this snapshot
and its hashes together when adopting a reviewed SDK change; do not patch a
vendored module independently.

The original SDK tests cover all 33 valid and 23 malformed core wire vectors,
strict Ed25519 checks, canonical CBOR, session lifetime and transport bounds.
The example tests exercise the copies with the delegation service and game.
