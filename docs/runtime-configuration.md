# Desktop Runtime Configuration

Read this before changing desktop configuration, profiles, runtime storage, development environment variables, onboarding, secrets, update simulations, or profiling builds.

- Store all desktop configuration and state under `~/.pwragent/`.
- This directory is the **PwrAgent root**.
- For isolated E2E or development work, override the root with `PWRAGENT_HOME=/path/to/root`.
- Select a named profile with `PWRAGENT_PROFILE=<name>`.
- If the variable is not set, use the `default` profile.
- Store profile settings in `~/.pwragent/profiles/<name>/config.toml`.
- Store profile state in `~/.pwragent/profiles/<name>/state/state.db`.
- Before an incompatible TOML shape change, read [config-file-evolution.md](config-file-evolution.md).
- Apply all of these configuration evolution rules:
  - Read fallback.
  - Lazy conversion.
  - Legacy comment.
  - Dual write.
- Do not use `PWRAGNT_STATE_ROOT` or `PWRAGNT_CONFIG_PATH`.
- The application does not read those removed variables.
- Multiple instances can safely share one profile database through SQLite WAL mode.
- Do not add a lock file for this database.

### Provider context configuration

Codex model providers use independent App Server processes and private runtime
catalogs. Runtime preparation uses the same bounded, authenticated `/models`
discovery as the picker; it does not require a saved connection test. Fresh
serving limits supersede saved context observations. Saved verified tool
capabilities remain separate from discovery.

`meta.n_ctx` is llama-server's active slot limit and takes precedence over
`context_window` and `context_length`. `meta.n_ctx_train` is training capacity
and never supplies an execution limit. Invalid values are ignored individually;
accepted limits are integer token counts from 1,024 through 2,000,000.

The optional provider `contextWindowCap` is stored as `context_window_cap` on
its existing `models.codex.providers` row. This is additive; no legacy shape is
replaced. A cap never raises a discovered limit. Loopback, local, and Bonsai
providers default to 65,536 tokens. Remote providers use discovered limits,
falling back to the former 272,000-token unknown-model budget. Bonsai's adapter
still has a 65,536-token ceiling. Execution budgets never overwrite the saved
upstream metadata.

Each private catalog sets the effective context as both `context_window` and
`max_context_window`, with a 75% auto-compaction threshold. Process overrides
take precedence over inherited Codex context settings: the context override is
the largest model budget, clamped by Codex to each model's catalog maximum;
the compaction override is 75% of the smallest budget. This conservative
provider-wide threshold also covers model switches within one process. A
65,536-token local budget therefore compacts at 49,152 tokens. No generated
context setting is installed on the primary process or another provider, and
the local stream idle timeout remains 15 minutes.

### Dev-only env vars

These variables are for development only.

- A build is packaged when `app.isPackaged === true`.
- Production operators must not set these variables.
- A packaged build ignores each variable.
- If a packaged build finds one, startup writes a `mainLog.error` entry.
- The packaged build then treats the variable as unset.

`PWRAGENT_PROFILE_AUTO_CREATE=1`

- Skip the onboarding prompt when a named profile does not exist.
- Use this variable for E2E fixtures and replay harnesses that need a profile directory.
- Production launches must use the onboarding wizard.
- The wizard prevents an unrequested mapping to a Codex authentication profile.
- Issue #524 explains this requirement.

`PWRAGENT_DEV_DISABLE_SECRET_STORAGE=1`

- Skip all `safeStorage` operations.
- The wizard silently discards secrets that the operator enters.
- Secret pills on the Settings screen report `unavailable`.
- Use this workaround only for unsigned development builds on macOS.
- Those builds can show a `Keychain Not Found` dialog because they have no stable signing identity.
- Signed release builds do not have this problem.
- After development, enter the secrets again in **Settings → Models** on a signed build.

`PWRAGENT_DEV_SQLITE_WRITE_METRICS=1`

- Count process-level SQLite commits, statements, rows, WAL growth, and table activity.
- `StateDb.open` installs the metrics wrapper after schema setup.
- Set `PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE=<path>` to select an output file.
- The metrics file gets one JSON line of totals for each source.
- Read "Sqlite Write-Volume Instrumentation" in [apps/desktop/AGENTS.md](../apps/desktop/AGENTS.md#sqlite-write-volume-instrumentation).

`PWRAGENT_DEV_REACT_DEVTOOLS=1`

- Load the standalone React DevTools backend as the renderer's first `<head>` script.
- `PWRAGENT_DEV_REACT_DEVTOOLS_HOST` and `PWRAGENT_DEV_REACT_DEVTOOLS_PORT` select the endpoint.
- Default the endpoint to `localhost:8097`.
- Give each checkout its own port when profiling more than one at a time.
- This variable is read by [electron.vite.config.ts](../apps/desktop/electron.vite.config.ts) at build time, not by the app process.
- A build made with this variable set must never ship.
- `verify-asar-contents.mjs` fails packaging when renderer HTML loads a remote script.

`PWRAGENT_DEV_REACT_PROFILING=1`

- Alias `react-dom/client` to `react-dom/profiling` for `electron-vite build`.
- Use this variable only when an absolute millisecond number must be trustworthy.
- The dev server already serves a profilable `react-dom`, so this variable is a no-op there.
- Use the dev build to find re-render storms. It carries richer render attribution.
- Read "Profiling the Renderer with React DevTools" in [apps/desktop/AGENTS.md](../apps/desktop/AGENTS.md#profiling-the-renderer-with-react-devtools).

`PWRAGENT_DEV_FAKE_UPDATE=1`

- Walk a fake update check instead of answering `skipped` in development.
- Real auto-update runs in packaged builds only, so this is the only way to
  see the update progress card, its byte meter, and Cancel without cutting a
  release.
- The fake applies to operator-initiated checks only. Startup and periodic
  checks still answer `skipped`, so an opted-in dev launch raises nothing on
  its own.
- The offered version is `420.0.0`. Restart declines it; nothing was
  downloaded to install.
- Set `PWRAGENT_DEV_FAKE_UPDATE_STEP_MS=<ms>` to pace the walk. The default is
  300 ms per step. `e2e/update-check.spec.ts` slows it so the mid-download
  Cancel button is a target rather than a race.
- Read the [update feature guidance](../apps/desktop/src/renderer/src/features/update/AGENTS.md)
  for why the fake is opt-in here and not in PwrGit.
