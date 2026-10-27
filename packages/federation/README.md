# Federation protocol core

Host-independent code shared by the Electron desktop and Node headless CLI.
This package owns Noise encryption, signed enrollment/reconnect, frame bounds,
capability policy, sessions, envelope routing and RPC correlation. It imports no
desktop services and opens no listener at import time.

Hosts supply a `FederationStore`, identity keys, transport callbacks, and optional
diagnostics through `configureFederationObservability`. Desktop compatibility
wrappers retain the prior import paths and configure the existing traffic/logging
hooks. The headless host supplies a private JSON store and bundles this package
with `ws`. Optional `supportedCapabilities` restricts a smaller host's grants;
signature verification still uses the peer's complete original advertisement.

The desktop federation tests exercise this shared implementation through those
wrappers. The headless tests exercise actual encrypted sockets, copied invites,
relay routing, capability limits and reconnects with a mocked Codex executable.
