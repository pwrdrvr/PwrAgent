# Bundled Grok ACP runtime

PwrAgent desktop releases embed a downstream build from
[`pwrdrvr/grok-build`](https://github.com/pwrdrvr/grok-build). This is not an
official xAI binary.

## Release contract

`apps/desktop/grok-bundle.json` pins one immutable downstream tag and its four
release asset names:

- macOS universal (Intel and Apple Silicon)
- Linux x86_64
- Linux aarch64
- Windows x86_64

The desktop release workflow downloads the matching asset and `SHA256SUMS`,
verifies the archive, and stages it before Electron packaging and macOS
signing. Packaging fails closed when the expected executable is absent. The
archive's Apache license, third-party notices, upstream `SOURCE_REV`, and
downstream provenance remain alongside the executable under
`Resources/agents/grok/`.

At runtime, the bundled executable is a final fallback. A valid explicit path
or system installation remains preferred. Only the bundled launch descriptor
sets `GROK_INSTALLER=pwragent`, preventing an xAI updater from replacing an
embedded, signed resource.

## Updating the pin

1. Sync and test the `pwragent` branch of the downstream Grok fork.
2. Publish a new signed `pwragent-v<upstream>-pwragent.<revision>` tag.
3. Wait for all four assets and `SHA256SUMS` to be published.
4. Update `apps/desktop/grok-bundle.json` to the new immutable tag and exact
   asset names.
5. Run ACP discovery tests and a PwrAgent package dry run before cutting the
   desktop release.

Do not reuse or replace an existing Grok release tag. The fork workflow rejects
attempts to overwrite an existing downstream release.
