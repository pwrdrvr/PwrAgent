# PwrAgnt

Thread-centric coding agent desktop app.

## Getting Started

1. `pnpm install`
2. `pnpm dev`

## Workspace

- `apps/desktop` - Electron app shell
- `packages/shared` - shared contracts and types
- `packages/agent-core` - agent runtime and domain services

## Testing

- `pnpm test`
- `pnpm typecheck`
- `pnpm test:desktop-e2e`

Desktop replay-backed Electron coverage lives under `apps/desktop/e2e`.

To record real Codex App Server traffic from the desktop client boundary, launch
the desktop app with `PWRAGNT_PROTOCOL_CAPTURE=true`. Captures are written under
the Electron user-data directory at `test-artifacts/protocol-captures` by
default. Override that root with `PWRAGNT_PROTOCOL_CAPTURE_ROOT=/absolute/path`
when you want a stable local export location.

Replay fixtures live in `apps/desktop/e2e/fixtures/*/replay.fixture.json`. The
current harness runs the built Electron app in replay mode by pointing
`PWRAGNT_REPLAY_FIXTURE_PATH` at one of those fixture files. The checked-in
suite uses curated replay fixtures for deterministic UI regressions, while raw
captures stay local evidence until they are promoted into a sanitized fixture.
Computer Use-driven seeding recipes live next to the fixtures under
`apps/desktop/e2e/fixtures/*/capture-recipe.md`, with shared workflow guidance
in `apps/desktop/e2e/fixtures/README.md`.

The current seeded desktop replay scenarios cover shell load, edited-change
ordering, pending approval UI, and turn lifecycle cleanup.

Typical workflow:

1. Record a session:
   `PWRAGNT_PROTOCOL_CAPTURE=true PWRAGNT_PROTOCOL_CAPTURE_ROOT=/absolute/path pnpm dev`
2. Export the recorded raw capture for a backend-qualified thread id:
   `pnpm --filter @pwragnt/desktop export:session-capture -- --capture-root /absolute/path --session codex:thread-123 --output /tmp/thread-123.raw.capture.jsonl`
3. Derive a curated fixture directory from a scenario window:
   `pnpm --filter @pwragnt/desktop derive:replay-fixture -- --input /tmp/thread-123.raw.capture.jsonl --output-dir apps/desktop/e2e/fixtures/example-scenario --scenario example-scenario --start 20 --end 80`
4. Run the desktop Electron regressions:
   `pnpm test:desktop-e2e`

`packages/agent-core` now includes the Grok-backed Codex app-server contract,
consumer-sequence compatibility tests, and provider coverage for the OpenClaw-used
subset.

Supported app-server methods today:

- `initialize`
- `thread/list`, `thread/loaded/list`
- `thread/start`, `thread/new`, `thread/resume`, `thread/name/set`, `thread/read`, `thread/compact/start`
- `model/list`, `skills/list`, `experimentalFeature/list`, `mcpServerStatus/list`
- `account/rateLimits/read`, `account/read`
- `review/start`
- `turn/start`, `turn/steer`, `turn/interrupt`

Known shape-first endpoints:

- `skills/list` returns stable empty skill collections per cwd
- `experimentalFeature/list` returns the Grok Responses feature descriptor
- `mcpServerStatus/list` returns an empty collection until an MCP runtime exists
- `account/rateLimits/read` returns an empty collection until rate-limit reporting is wired
- `account/read` returns local development account metadata rather than a full auth-backed profile

When you are ready to run live xAI-backed smoke coverage, set credentials in
either your shell environment or the Grok app-server user config at
`~/.config/grok-app-server/config.toml`.

The runtime config keys are:

- `xai_api_key`
- `grok_model`
- `xai_base_url`
- `state_root`

Project-local env and already-exported shell env still win over the user
config. The runtime loader also preserves legacy fallback support under
`~/.config/grok-app-server` for:

- `config.env`
- `.env.local`
- `.env`

CI uses the existing `live-agent-core` workflow job with the `XAI_API_KEY`
repository secret. No separate tool-test secret is required.

Live smoke coverage:

- `pnpm --filter @pwragnt/agent-core test:live`
- Covers live thread continuation via `thread/resume`
- Covers live context compaction via `thread/compact/start`
- Covers live repository-tool usage against a temporary workspace
