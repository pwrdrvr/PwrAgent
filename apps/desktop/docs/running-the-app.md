# Running and Targeting the Desktop App

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Running the App for Development

Choose the target checkout and profile before starting or controlling an app.
For a checkout-bound `dev` profile, use the project-local
[`pwragent-dev-profile` skill](../../../.agents/skills/pwragent-dev-profile/SKILL.md):

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh status --root "$PWD"
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh restart --root "$PWD"
```

Run `status` first and only `restart` when a new process is actually wanted.
The skill supplies both `PWRAGENT_PROFILE=dev` and
`PWRAGENT_INSTANCE_ROOT="$PWD"` so it manages the instance for this checkout.
Use the
[`pwragent-dev-restart` skill](../../../.agents/skills/pwragent-dev-restart/SKILL.md)
for a delayed restart that must survive the current in-app Agent session.

To launch the desktop app with live threads and real user state, run from the **repo root** (or worktree root):

```bash
pnpm dev
```

- Do **not** override `HOME` or set `NODE_ENV` — the app needs the real user data directory to load saved threads and Keychain secrets.
- Messaging adapters are guarded by a profile-scoped sqlite lease. A shared runtime lease manager records the owning PID, runtime instance ID, and start time once, then verifies that identity against the existing profile runtime marker when another instance challenges the lease. A matching live identity remains authoritative across wall-clock corrections. Once the identity is absent, an owner that predates the current OS boot, or one the host proved gone (the Outpost names the earlier holders of its kernel-released headless lock, since every container owner is PID 1), is reclaimed immediately; otherwise the first confirmed absence is persisted and a one-minute reclaim grace protects a temporarily hung process. PID reuse cannot revive the dead owner. If another live instance already owns messaging for the active profile, this process stays usable but leaves messaging stopped.
- The federation runtime asks the same lease manager for a parallel profile-scoped lease (lease key `profile-federation`, independent of the messaging lease). If another live instance already runs federation for the active profile, this process keeps its federation runtime stopped and reports the holder in federation health instead of fighting over the shared instance identity.
- Scheduled automations use the profile `background` lease (lease key `profile-background`), the lease for work that must run in one instance but has no setting of its own. Only its holder evaluates schedules and moves missed schedule windows forward at startup, so a second instance on the profile, such as `pnpm dev` beside the installed app, never runs a schedule window the holder already ran. The other instance still serves Run now and inspection, ends runs whose owning process is proved dead at its own startup, and retries the lease so it takes over when the holder exits. Its Automations button rests muted with the paused dot, and its tooltip names the holder's directory and process ID. Before each schedule evaluation the holder also ends runs a stopped instance left in progress, and whichever process ends a running run starts the next run in that automation's lane. Inbound-message runs need no extra gate: only the messaging lease holder receives messages.
- Use `pnpm dev:no-messaging` when you explicitly want to guarantee that this app process never starts messaging adapters.
- For visual verification of UI changes, either command can show real threads in the sidebar and thread detail pane; prefer `dev:no-messaging` when the UI work does not need live messaging.
- If the app starts but shows no threads, you are likely running from the wrong directory or with overridden env vars.

### Targeting an Existing Electron App

- Confirm the intended checkout/profile with the dev-profile skill before
  driving a window. Dev builds run as the generic `Electron` process and share
  the `com.github.Electron` bundle id with every other unsigned Electron app.
  **Never target either generic identity.** Do not target the installed
  `com.pwrdrvr.pwragent` bundle either: it is a packaged build and does not
  contain the checkout's code.
- Launch or inspect with the project-local dev-profile skill. Its successful
  `status` / `restart` / `verify` output includes a `Computer Use target` line
  with the checkout-local Electron main PID, exact `Electron.app` path,
  expected native window title (`PwrAgent`), and renderer URL/port. For Computer
  Use, target that exact app path, then confirm the returned window title and
  AX URL match before clicking anything. The title alone is not unique when
  another PwrAgent checkout is open; the port alone is not enough without the
  checkout-local executable and `--app-path` process evidence.
- If the target cannot be resolved unambiguously, stop instead of guessing.
  An ambiguous lookup can raise or operate a sibling Pwr app, another checkout,
  or an unrelated project's broken default Electron window.
- With a Codex browser/Electron controller, select and reuse the existing
  PwrAgent Electron target and its window/page binding. With persistent
  `node_repl` Playwright, reuse the existing `electronApp` and `appWindow`
  handles. Playwright's `_electron.launch()` always creates a new process; it
  cannot attach those handles to an arbitrary Electron app that was started
  elsewhere, so use Computer Use or an existing controller binding instead.
- If a separate Playwright-owned instance is explicitly required, prefer the
  repository's E2E/inspect commands. A manual Playwright launch must pass the
  PwrAgent package entry: `.` with `cwd` set to `apps/desktop`, or
  `apps/desktop` with `cwd` set to the repository root, plus the intended
  `PWRAGENT_PROFILE` and `PWRAGENT_INSTANCE_ROOT` environment.
- **Never launch `Electron.app`, its `Contents/MacOS/Electron` executable, or
  the repo's Electron binary without the PwrAgent app entry/path.** A bare
  Electron launch opens Electron's default shell, not PwrAgent.
