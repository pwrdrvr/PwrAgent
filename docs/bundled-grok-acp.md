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
remains preferred. When Settings → AI Providers → Grok → PwrAgent build is on,
PwrAgent checks the public downstream release feed and prefers the newest
compatible managed build ahead of system installations and the embedded copy.
Both managed and bundled launch descriptors set `GROK_INSTALLER=pwragent`,
preventing an xAI updater from replacing a PwrAgent-owned runtime.

## Managed runtime updates

Managed builds use the same four-platform asset contract as release packaging.
PwrAgent downloads the platform archive and `SHA256SUMS`, requires the checksum
to agree with the GitHub asset digest when GitHub supplies one, validates the
bundle contents, and installs it under `~/.pwragent/agents/grok/versions/` (or
the active `PWRAGENT_HOME`). The selected release is machine-wide, so profiles
and dev checkouts on the same machine reuse the verified download.

`pwragent-v1.0.4-pwragent.2` is the minimum managed release because it is the
first release produced by the signed Grok pipeline. Older tags are neither
downloaded nor accepted from cache. In packaged PwrAgent builds, macOS verifies
the Grok code signature against the Apple team identifier read from the running
PwrAgent executable. Windows requires valid Authenticode signatures on both
executables and exact matching certificate subject and issuer identities. The
same checks run again before a cached runtime is accepted, so an unsigned dev
cache cannot cross into a packaged launch.

Cache metadata includes the platform-specific asset name; a cache restored on
an incompatible platform or architecture is rejected and repaired from the
matching release asset. A broken same-tag directory is displaced and replaced
only after the new archive passes checksum, contents, signature, and version
validation. Activation markers retain versions selected by other live PwrAgent
processes, while cleanup keeps only the current version, live selections, and
one rolling-upgrade compatibility version.

Development runs enable managed builds by default and check once per Electron
process, which makes a fresh `pnpm dev` pick up a newly published downstream
build. Packaged apps keep the setting off by default, require the PwrDrvr Apple
or Windows signing identity when it is turned on, and check at most once per 24
hours. The provider's Refresh button forces a check.
Offline and failed checks retain the last verified managed build; if none is
cached, ordinary PATH and bundled discovery continue unchanged. Disabling Grok
also disables release checks. Operators can turn off only the managed-build
behavior without disabling Grok itself.

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
