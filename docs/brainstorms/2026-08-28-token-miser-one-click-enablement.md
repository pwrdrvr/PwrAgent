# Token Miser one-click enablement requirements

Date: 2026-08-28

## Outcome

An operator can enable Token Miser with the **Make Token Miser available**
switch and immediately use it. The operator does not install or select a Codex
binary, run a terminal command, or approve a hook with `/hooks`.

## Runtime ownership

- PwrAgent downloads a compatible PwrDrvr-signed Codex distribution on demand.
- The experimental availability switch is the outer gate for acquisition and
  update checks. PwrAgent makes no Token Miser Codex network request while the
  switch is off.
- While the switch is on, the managed Codex distribution wins selection over
  every automatically discovered Codex version. A newer upstream Codex must
  not silently displace it.
- A previously verified managed distribution remains usable when an update
  check is offline or rate limited.
- Installation is staged, checksum-verified, platform-signature-verified in a
  packaged build, and activated atomically.
- PwrAgent periodically checks for compatible updates only while the switch is
  on. An update applies at a safe Codex process boundary without interrupting
  a live turn.

## Codex contract

- The custom Codex runtime advertises an explicit capability for the native or
  narrowly scoped managed Token Miser interception path.
- Enabling that path must not disable hook trust globally or trust unrelated
  plugin hooks.
- PwrAgent verifies the capability before reporting Token Miser as active.
- Unsupported or incomplete runtimes never receive custom configuration.

## User experience

- Enabling the switch waits for a usable managed runtime before committing the
  setting. A failed first install leaves the switch off and reports the error.
- Settings distinguishes downloading, waiting for a safe runtime switch,
  active, and unavailable states without implementation narration.
- Per-thread default and override behavior remains inside the global
  availability gate.
- Disabling availability stops update checks, removes Token Miser config and
  tools from subsequent Codex sessions, and returns Codex selection to the
  operator's normal configured or discovered runtime.

## Distribution contract

- Releases are immutable `pwragent-v*` tags in `pwrdrvr/codex`.
- Every release publishes platform/architecture archives plus `SHA256SUMS`.
- Each archive contains the Codex CLI, app server, Code Mode host, provenance,
  license notices, and platform helpers required by that runtime.
- Executable version banners and the provenance version must agree.

