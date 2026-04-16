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

When you are ready to run live xAI-backed smoke coverage, put credentials in
`packages/agent-core/.env.local`. The tracked template lives at
`packages/agent-core/.env.local.example`.

Live smoke coverage:

- `pnpm --filter @pwragnt/agent-core test:live`
- Covers live thread continuation via `thread/resume`
- Covers live context compaction via `thread/compact/start`
