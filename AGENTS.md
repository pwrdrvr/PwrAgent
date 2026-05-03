# PwrAgnt Repository Guidance

## Source of Truth

- Product requirements live in `docs/brainstorms/`
- Implementation plans live in `docs/plans/`
- UI theme tokens and visual language live in [docs/UI-THEME.md](docs/UI-THEME.md)
- Desktop UI direction lives in [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md)

## Workflow

- Treat plan documents as decision artifacts, not implementation scripts.
- Keep changes aligned with the current active plan unless the user explicitly changes scope.
- Do not delete or "clean up" files in `docs/brainstorms/`, `docs/plans/`, or future `docs/solutions/` directories.
- Exclude `apps/desktop/.local/protocol-captures/` from broad searches by default. Only search it when the task is specifically about captured E2E protocol snippets.
- Use the project-local [desktop E2E fixture seeding skill](.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when seeding or refreshing desktop replay fixtures from live captured sessions.
- For reliable desktop E2E runs, prefer `pnpm test:desktop-e2e` from the repo root. The package-level `pnpm --filter @pwragnt/desktop test:e2e` path is also safe now because it builds `apps/desktop/out/` before launching Playwright.
- When focusing root Vitest runs through `pnpm test`, pass file paths or filters directly, for example `pnpm test packages/agent-core/src/__tests__/overlay-store.test.ts`. Do not insert a standalone `--` before the focus args; `pnpm test -- packages/...` makes Vitest run the full workspace suite.

## Agent Instruction Files

- Keep a sibling `CLAUDE.md` symlink next to every `AGENTS.md`, pointing at that `AGENTS.md`, so Codex and Claude read the same local guidance.

## Pull Requests

- Use Conventional Commit-style PR titles: `type(scope): short description`.
- Prefer scopes that match the project area being changed:
  - `messaging` for Telegram, Discord, adapters, and messaging integrations.
  - `desktop` for the desktop app itself.
  - `agent-core` for the coding agent, currently the Grok coding agent.
  - `docs` for documentation changes.
  - `tests` for test coverage, fixtures, and test infrastructure.

## Runtime Config

- Grok app-server user config lives at `~/.config/grok-app-server/config.toml`.
- Runtime config keys in that file are `xai_api_key`, `grok_model`, `xai_base_url`, and `state_root`.
- Environment variables still override the user config.
- Legacy `~/.config/grok-app-server/config.env` and related env files remain fallback-compatible, but `config.toml` is the current source of truth.

## Frontend and Desktop UI

- For renderer UI work, follow the desktop style guide before inventing local styling.
- For colors, tokens, and visual theme decisions, follow the UI theme guide before adding local CSS.
- Favor thread-first information hierarchy over generic dashboard layout.
- Do not ship scaffold narration or placeholder implementation copy in user-facing UI.

## Current Product Direction

- Threads are first-class and may exist without a directory.
- Inbox, Recents, and Directories share the thread lens switch, with Inbox leftmost.
- Recents is the default browsing lens.
- A thread may be associated with multiple linked Git directories.

## App-Specific Guidance

- Additional desktop-app instructions live in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
- Messaging package boundary instructions live in [packages/messaging/AGENTS.md](packages/messaging/AGENTS.md). Review them before adding messaging integrations, changing messaging provider code, or deciding where messaging calls and workflow logic should live.
