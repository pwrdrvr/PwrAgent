# PwrAgent Codex build

Settings → Models → Codex → **PwrAgent build** downloads, verifies and installs
PwrAgent's own Codex build from
[pwrdrvr/codex](https://github.com/pwrdrvr/codex/releases) and uses it for new
threads. Token Miser requires it, so the switch is locked on while Token Miser
is on. PwrAgent checks for a new build at most once per 24 hours; **Check for
updates** forces a check.

## Build tracks: Latest and Prerelease

The build follows the same two tracks as the managed Grok build (see
[bundled-grok-acp.md](bundled-grok-acp.md#build-tracks-latest-and-prerelease)).
Select a track in Settings → Models → Codex → **Build track**. PwrAgent stores
it as `[models.codex] managed_build_channel`:

- **Latest** (default) installs only promoted releases. A promoted release is a
  GitHub release whose Pre-release flag is clear.
- **Prerelease** installs the newest release, promoted or not.

To ship a build, publish it as a GitHub pre-release, run it on the Prerelease
track, then mark the release Latest when it is ready. Operators on Latest do
not get the build until it is promoted.

The two tracks follow the same rules as Grok's:

- Semantic-version precedence picks the build, not the order GitHub returns.
- Prerelease stays selectable when both tracks name the same version.
- A rate-limited check falls back to the Atom feed. That fallback serves only
  the Prerelease track, because the feed cannot tell which releases are
  promoted. The Latest track keeps its cached build for that cycle.
- Each check records what both tracks resolved to. Settings shows each track's
  version from that record, or `Unavailable` when no check has observed it.

Switching the track saves the setting, checks that track immediately, and
installs its build before the write returns. That includes a step back: moving
from Prerelease to Latest is a downgrade on purpose. New threads use the new
build; a running turn finishes on the build it started with.

The verified download is machine-wide. When another profile on the same machine
follows the other track, the cached build can belong to the wrong track. Codex
handles that case differently from Grok. Startup never waits on a download, so
a launch still runs the cached build. The re-check for its own track starts
immediately, instead of waiting out the 24-hour window, and the next discovery
picks up that track's build.
