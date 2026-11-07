# Topic client (copied from the release)

The browser topic-policy client from **Yano X 0.1.0-pre6**, copied unchanged
from the JVM distribution's `studio/assets/topics/` (the source is
`sdk/javascript/` in the yano-x repository, tag `v0.1.0-pre6`). Dependency-free
ES modules: core topic frames, write statements, delegations (session
credentials), the `DelegatedSession` that keeps a non-extractable session key,
and `submitFrame`. They work in browsers with WebCrypto Ed25519 and in Node.

The game center uses it through [`../sessions.js`](../sessions.js) (pages) and
[`../../delegation/`](../../delegation/) (the issuer). Do not edit these files;
copy a newer release's folder over them instead. MIT licensed (LICENSE).

| File | SHA-256 |
|---|---|
| `blake2b.mjs` | `da70623e97654053caeaa4d8dc1158d53083cf2ce3c8b28ef8d46a2127edc15e` |
| `canonical-value.mjs` | `0716535f0e0f723378489f64c8c2e012c20586bdd586e6127998f4e44bd29c1d` |
| `cbor.mjs` | `edf1335bfa4061d6bbd89d485fb85ed1e2791bdf670adf5dbcb7b11d8a683d95` |
| `topic-wire.mjs` | `f1952341461116359b3bc5fa97bcc9397eb86a0b7dccb730e482ee7d62a6145f` |
| `topics.mjs` | `6af964b140803812b06be3497348b72342ff9b10e10643b133249ab99d27f5f5` |
