# Contributing to PwrAgent

Thanks for taking the time to improve PwrAgent. The project is MIT-licensed
and currently in beta — actively developed, but designed to be
non-destructive between releases. The config and state systems migrate
forward without invalidating older installs (see
[docs/config-file-evolution.md](docs/config-file-evolution.md)); keep
that contract in mind when proposing changes to either. This document
covers the development setup, repository conventions, testing workflow,
and diagnostic tooling you'll need to ship a change confidently.

For the architectural picture (process model, storage layers, messaging
layer, dependency boundaries), read [ARCHITECTURE.md](ARCHITECTURE.md)
first. For the user-facing pitch, see [README.md](README.md).

## Development Setup

1. Install Node.js from `.nvmrc`.
2. Run `pnpm install`.
3. Run `pnpm dev` for the desktop app.

Useful checks (all run from the repo root):

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:desktop-e2e`
- `pnpm lint:boundaries`
- `pnpm licenses:check`

When focusing root Vitest runs through `pnpm test`, pass file paths or
filters directly, for example
`pnpm test apps/desktop/src/main/__tests__/backend-registry.test.ts`. Do
not insert a standalone `--` before the focus args; `pnpm test -- packages/...`
makes Vitest run the full workspace suite.

## Workspace Map

- `apps/desktop` — Electron app shell (main process, renderer, IPC).
- `packages/shared` — internal contracts and types.
- `packages/messaging/interface` — generic messaging types and helpers.
- `packages/messaging/providers/*` — per-platform messaging adapters
  (Telegram, Discord, Mattermost, Slack).

See [ARCHITECTURE.md](ARCHITECTURE.md#workspace-map) for a table of
what's in each path and the layered dependency story.

## Pull Requests

- Keep PRs focused on one change.
- Follow Conventional-Commit-style PR titles: `type(scope): description`.
  Prefer scopes that match the project area being changed:
  - `messaging` for Telegram, Discord, Mattermost, Slack, adapters, and
    messaging integrations.
  - `desktop` for the desktop app itself.
  - `agent-core` for coding-agent backend and ACP integration changes.
  - `release` for packaging, signing, notarization, distribution, and
    the auto-update pipeline.
  - `docs` for documentation changes.
  - `tests` for test coverage, fixtures, and test infrastructure.
- Include tests or explain why the change is documentation-only.
- Run the relevant checks before requesting review.
- Update `THIRD_PARTY_LICENSES` with `pnpm licenses:generate` when
  dependency changes affect bundled notices.

## Dependency Boundaries

The rules in [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs) are
load-bearing. **Do not loosen them to make a change pass.** Renderer code
may only import `@pwragent/shared`; other package access crosses the IPC
bridge through the desktop main process.

If a rule blocks your change, the change is architecturally wrong —
redesign it. See [ARCHITECTURE.md](ARCHITECTURE.md#dependency-boundaries)
for the layered hierarchy and the "Dependency Boundary Enforcement"
section of [CLAUDE.md](CLAUDE.md) for the full policy.

Run `pnpm lint:boundaries` before pushing. CI fails the build on any
violation.

## Messaging Integrations

Telegram, Discord, Mattermost, and Slack adapters can be enabled from the
desktop main process with PwrAgent-prefixed environment variables and
allowlisted platform user IDs. Operator setup, command surface, security
notes, and tunneling guidance for HTTP-callback providers live in
[docs/messaging-platform-integration.md](docs/messaging-platform-integration.md).

For contributors:

- [docs/messaging-architecture.md](docs/messaging-architecture.md) —
  layered architecture, data-flow diagrams, the capability-profile
  system that lets producers adapt content per-platform without channel
  branching, and the inline-stream vs. out-of-band HTTP callback
  delivery models.
- [docs/messaging-adding-a-provider.md](docs/messaging-adding-a-provider.md)
  — hands-on walkthrough for building a new platform adapter (Slack,
  Signal, Feishu/Lark, Matrix, etc.).
- [docs/messaging-adapter-contract.md](docs/messaging-adapter-contract.md)
  — formal contract every platform adapter must satisfy.
- [packages/messaging/AGENTS.md](packages/messaging/AGENTS.md) — package
  boundary rules and `pnpm lint:boundaries` enforcement.

## Testing

For the desktop end-to-end suite, prefer `pnpm test:desktop-e2e` from the
repo root. The package-level
`pnpm --filter @pwragent/desktop test:e2e` path is also safe — it builds
`apps/desktop/out/` before launching Playwright.

### macOS VM E2E and visual goldens

Do not run a full headed Electron suite on an active desktop. Use PwrSuiteLab
Control MCP and its dedicated E2E target so windows render on the guest display.
Agents must read
[`.agents/skills/macos-vm-e2e-lab/SKILL.md`](.agents/skills/macos-vm-e2e-lab/SKILL.md)
and the connected server's current schemas and served E2E skill. An existing
Operate grant covers matching operations within the requested task without
per-operation dialogs. Controller scripts and checkout/Federation discovery
are fallback paths only when MCP is unavailable, under the lab's current
runbook and existing scoped authorization. Do not provision a product-local lab.

The small macOS/ARM64 visual-regression suite has lossless WebP baselines under
`apps/desktop/e2e/*.spec.ts-snapshots/`. They are Git LFS objects, not ordinary
Git blobs. Generate them only inside the lab VM. A `lab_e2e_run` request has
this shape (replace the target, path, and attribution with actual values):

```json
{
  "target": "<exact E2E target from lab_status>",
  "agent_name": "Codex",
  "project_name": "PwrAgent",
  "thread_name": "Verify macOS visual goldens",
  "job": {
    "repository": "/absolute/path/to/clean/committed/worktree",
    "setup": [["pnpm", "install", "--frozen-lockfile"]],
    "command": ["env", "PWRAGENT_E2E_DISABLE_GPU=1", "pnpm", "test:desktop-e2e", "e2e/visual-regression.spec.ts"],
    "artifacts": ["apps/desktop/test-results", "apps/desktop/playwright-report"],
    "timeout_seconds": 3600
  }
}
```

This assumes the guest has the Node version selected by current CI and the
pnpm version declared in `package.json`; otherwise include their noninteractive
installation/version selection in guest `setup` using the served skill.
`setup` entries and `command` are argv arrays, not shell strings. The product's
E2E script owns Electron preparation and the build. Add top-level `pr_number`
as a decimal string when known; omit it when unknown. Both `lab_e2e_run` and
`lab_e2e_acquire` require `agent_name`, `project_name`, and `thread_name`.
If a call reports `Invalid tool or arguments`, refresh its schema and correct
the payload before diagnosing permissions.

Save the request ID and run ID, poll launch completion, then collect with
`lab_e2e_collect`. A completed launch is not a test result. Inspect the returned
logs, test exit code, and artifacts before reporting success.

Review the retrieved `*-actual.webp` artifacts, promote the approved files to
their `*-darwin.webp` baseline names, and check `git lfs status`. The launcher
requires a clean worktree and transports only committed `HEAD`, so commit the
promoted references as a disposable checkpoint before rerunning the focused
spec. Amend or squash that checkpoint only after the VM verifies it. The CI
lane runs on the selected-repository PwrDrvr organization runner shared with
PwrSnap; fork PRs are deliberately excluded from that machine.

For manual screenshots of the branch-drift dialog, run
`pnpm --filter @pwragent/desktop inspect:e2e:branch-drift`; it opens a
replay-backed Electron fixture and waits until you close the app.

### Recording and Replaying Protocol Sessions

To record real Codex App Server traffic from the desktop client
boundary, launch the desktop app with `PWRAGNT_PROTOCOL_CAPTURE=true`.
Captures are written under the active profile's state directory at
`protocol-captures/` by default
(`~/.pwragent/profiles/default/state/protocol-captures/`). Override that
root with `PWRAGNT_PROTOCOL_CAPTURE_ROOT=/absolute/path` when you want
a stable local export location.

Replay fixtures live in `apps/desktop/e2e/fixtures/*/replay.fixture.json`.
The current harness runs the built Electron app in replay mode by
pointing `PWRAGNT_REPLAY_FIXTURE_PATH` at one of those fixture files.
The checked-in suite uses curated replay fixtures for deterministic UI
regressions, while raw captures stay local evidence until they are
promoted into a sanitized fixture. Computer-Use-driven seeding recipes
live next to the fixtures under
`apps/desktop/e2e/fixtures/*/capture-recipe.md`, with shared workflow
guidance in `apps/desktop/e2e/fixtures/README.md`.

The current seeded desktop replay scenarios cover shell load,
edited-change ordering, pending approval UI, and turn-lifecycle cleanup.

Typical workflow:

1. Record a session:
   `PWRAGNT_PROTOCOL_CAPTURE=true PWRAGNT_PROTOCOL_CAPTURE_ROOT=/absolute/path pnpm dev`
2. Export the recorded raw capture for a backend-qualified thread id:
   `pnpm --filter @pwragent/desktop export:session-capture -- --capture-root /absolute/path --session codex:thread-123 --output /tmp/thread-123.raw.capture.jsonl`
3. Derive a curated fixture directory from a scenario window:
   `pnpm --filter @pwragent/desktop derive:replay-fixture -- --input /tmp/thread-123.raw.capture.jsonl --output-dir apps/desktop/e2e/fixtures/example-scenario --scenario example-scenario --start 20 --end 80`
4. Run the desktop Electron regressions:
   `pnpm test:desktop-e2e`

For seeding or refreshing desktop replay fixtures from live captured
sessions, use the project-local
[desktop E2E fixture seeding skill](.agents/skills/desktop-e2e-fixture-seeding/SKILL.md).

## Developer Diagnostics

These diagnostics are internal — they are not user-facing features and
are gated behind environment variables. They write artifacts under the
repo-local `.local/` directory.

### Heap Diagnostics

Enable a capture run with:

- `PWRAGNT_HEAP_DIAGNOSTICS=1 pnpm dev`

Optional tuning:

- `PWRAGNT_HEAP_DIAGNOSTICS_ROOT` — override the repo root used for `.local/`
- `PWRAGNT_HEAP_DIAGNOSTICS_SETTLE_MS` — delay before the baseline sample
  (`0` captures immediately after `did-finish-load`)
- `PWRAGNT_HEAP_DIAGNOSTICS_INTERVAL_MS` — recurring sample interval
- `PWRAGNT_HEAP_DIAGNOSTICS_DELTA_BYTES` — adjacent-sample growth
  threshold for snapshots
- `PWRAGNT_HEAP_DIAGNOSTICS_COOLDOWN_MS` — minimum time between snapshots
- `PWRAGNT_HEAP_DIAGNOSTICS_MAX_SNAPSHOTS` — per-session snapshot cap

Each enabled run creates one directory shaped like
`.local/heap-YYYY-MM-DD-HHmm-abc123/`. Expected artifacts:

- `session.json`
- `samples.ndjson`
- `events.ndjson`
- `heap-0001.heapsnapshot`, `heap-0002.heapsnapshot`, ...
- `main-heap-0001.heapsnapshot`, `main-heap-0002.heapsnapshot`, ...

Each sample and event record is tagged with `source: "renderer"` or
`source: "main"`. During a repro run, the desktop main process logs the
session directory path. Share that path for later diagnosis.

### Startup CPU Profiling

Enable one startup capture run with:

- `PWRAGNT_STARTUP_CPU_PROFILING=1 pnpm dev`

Optional tuning:

- `PWRAGNT_STARTUP_CPU_PROFILE_ROOT` — override the repo root used for
  `.local/`
- `PWRAGNT_STARTUP_CPU_PROFILE_POST_LOAD_MS` — extra renderer capture
  time after `did-finish-load`
- `PWRAGNT_STARTUP_CPU_PROFILE_HARD_TIMEOUT_MS` — hard stop for the
  entire startup capture window

Each enabled run creates one directory shaped like
`.local/startup-cpu-YYYY-MM-DD-HHmm-abc123/`. Expected artifacts:

- `session.json`
- `events.ndjson`
- `main.cpuprofile`
- `renderer.cpuprofile`
- `analysis.json`
- `summary.md`

The desktop main process logs the created session directory path during
startup. Re-run the analyzer for an existing session with:

- `pnpm --filter @pwragent/desktop analyze:startup-cpu-profile -- --session-dir .local/startup-cpu-2026-04-19-0930-abc123`

`summary.md` gives the quick ranked view of the hottest startup
functions and source buckets. Open the raw `.cpuprofile` files in
DevTools when the generated summary shows Electron- or Chromium-heavy
frames that need deeper inspection.

## Runtime Config

All desktop config and state lives under `~/.pwragent/` (the
"PwrAgent root").

- Override the root with `PWRAGENT_HOME=/path/to/root` for isolated E2E
  or dev-profile use.
- Select a named profile with `--profile <name>` or
  `PWRAGENT_PROFILE=<name>` (defaults to `default` unless a startup
  default is set in Settings -> Profiles). The command-line argument
  wins when both are present.
- PwrAgent and Codex auth profile identity are process-start choices.
  Changing the startup PwrAgent profile or the Codex auth profile in
  Settings affects the next app launch, not the running app-server.
- For development profile testing from the repo root, run
  `pnpm dev -- --profile work`. The shortcut `pnpm dev:dev` launches
  the desktop app with `--profile dev`.
- Per-profile layout:
  - `~/.pwragent/profiles/<name>/config.toml` — settings.
  - `~/.pwragent/profiles/<name>/state/state.db` — sqlite.
- Multiple instances can share the same profile DB safely (sqlite WAL
  mode); no lockfile needed.

Before making a backwards-incompatible TOML config shape change, read
[docs/config-file-evolution.md](docs/config-file-evolution.md) and
follow its read-fallback, lazy-conversion, legacy-comment, and
dual-write rules.

## Conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not report vulnerabilities in public issues. Follow
[SECURITY.md](SECURITY.md).
