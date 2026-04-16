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

`packages/agent-core` now includes the first Grok app-server contract and provider tests.
When you are ready to run live xAI-backed smoke coverage, put credentials in
`packages/agent-core/.env.local`. The tracked template lives at
`packages/agent-core/.env.local.example`.

Live smoke coverage:

- `pnpm --filter @pwragnt/agent-core test:live`
