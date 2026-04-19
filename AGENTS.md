# PwrAgnt Repository Guidance

## Source of Truth

- Product requirements live in `docs/brainstorms/`
- Implementation plans live in `docs/plans/`
- Desktop UI direction lives in [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md)

## Workflow

- Treat plan documents as decision artifacts, not implementation scripts.
- Keep changes aligned with the current active plan unless the user explicitly changes scope.
- Do not delete or "clean up" files in `docs/brainstorms/`, `docs/plans/`, or future `docs/solutions/` directories.
- Use the project-local [desktop E2E fixture seeding skill](.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when seeding or refreshing desktop replay fixtures from live captured sessions.

## Runtime Config

- Grok app-server user config lives at `~/.config/grok-app-server/config.toml`.
- Runtime config keys in that file are `xai_api_key`, `grok_model`, `xai_base_url`, and `state_root`.
- Environment variables still override the user config.
- Legacy `~/.config/grok-app-server/config.env` and related env files remain fallback-compatible, but `config.toml` is the current source of truth.

## Frontend and Desktop UI

- For renderer UI work, follow the desktop style guide before inventing local styling.
- Favor thread-first information hierarchy over generic dashboard layout.
- Do not ship scaffold narration or placeholder implementation copy in user-facing UI.

## Current Product Direction

- Threads are first-class and may exist without a directory.
- Inbox sits above Recents and Directories.
- Recents is the default browsing lens.
- A thread may be associated with multiple linked Git directories.

## App-Specific Guidance

- Additional desktop-app instructions live in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
