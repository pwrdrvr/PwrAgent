# PwrAgent Repository Guidance

## Source of Truth

- Product requirements live in `docs/brainstorms/`
- Implementation plans live in `docs/plans/`
- UI theme tokens and visual language live in [docs/UI-THEME.md](docs/UI-THEME.md)
- Desktop UI direction lives in [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md)
- The PwrAgent v2 design source bundle (HTML/CSS/JSX prototypes + chat transcripts) lives in [docs/design/pwragent-v2/](docs/design/pwragent-v2/) — see [docs/design/pwragent-v2/SOURCE.md](docs/design/pwragent-v2/SOURCE.md) for provenance and the "reference, not copy verbatim" policy

## Workflow

- Treat plan documents as decision artifacts, not implementation scripts.
- Keep changes aligned with the current active plan unless the user explicitly changes scope.
- Do not delete or "clean up" files in `docs/brainstorms/`, `docs/plans/`, or future `docs/solutions/` directories.
- Exclude `apps/desktop/.local/protocol-captures/` from broad searches by default. Only search it when the task is specifically about captured E2E protocol snippets.
- Use the project-local [desktop E2E fixture seeding skill](.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when seeding or refreshing desktop replay fixtures from live captured sessions.
- For reliable desktop E2E runs, prefer `pnpm test:desktop-e2e` from the repo root. The package-level `pnpm --filter @pwragent/desktop test:e2e` path is also safe now because it builds `apps/desktop/out/` before launching Playwright.
- When focusing root Vitest runs through `pnpm test`, pass file paths or filters directly, for example `pnpm test packages/agent-core/src/__tests__/overlay-store.test.ts`. Do not insert a standalone `--` before the focus args; `pnpm test -- packages/...` makes Vitest run the full workspace suite.

## Agent Instruction Files

- Keep a sibling `CLAUDE.md` symlink next to every `AGENTS.md`, pointing at that `AGENTS.md`, so Codex and Claude read the same local guidance.

## Pull Requests

- Use Conventional Commit-style PR titles: `type(scope): short description`.
- Prefer scopes that match the project area being changed:
  - `messaging` for Telegram, Discord, adapters, and messaging integrations.
  - `desktop` for the desktop app itself.
  - `agent-core` for the coding agent, currently the Grok coding agent.
  - `release` for packaging, signing, notarization, distribution, and auto-update pipeline.
  - `docs` for documentation changes.
  - `tests` for test coverage, fixtures, and test infrastructure.

## Release / Distribution

- The desktop release pipeline (Mac, signing, notarization, auto-update) is
  documented in [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md).
- The Phase 1 → Phase 2 distribution channel migration runbook lives at
  [docs/desktop-distribution-phase-2-runbook.md](docs/desktop-distribution-phase-2-runbook.md).
- v1.0 is closed-source proprietary, owned by PwrDrvr LLC. Treat the LICENSE
  file at the repo root and all `package.json` `license: "UNLICENSED"` markings
  as load-bearing — do not add OSS license language to any package, README, or
  source-file header without an explicit policy change from PwrDrvr LLC.

## Runtime Config

- All desktop config and state lives under `~/.pwragent/` (the "PwrAgent root").
- Override the root with `PWRAGENT_HOME=/path/to/root` for isolated E2E or dev-profile use.
- Select a named profile with `PWRAGENT_PROFILE=<name>` (defaults to `default`).
- Per-profile layout: `~/.pwragent/profiles/<name>/config.toml` (settings), `~/.pwragent/profiles/<name>/state/state.db` (sqlite).
- Grok app-server config lives at `~/.config/grok-app-server/config.toml` (legacy path, still read).
- Runtime config keys in the grok config: `xai_api_key`, `grok_model`, `xai_base_url`, `state_root`.
- Environment variables (`XAI_API_KEY`, `GROK_MODEL`, `XAI_BASE_URL`) still override the toml config.
- Removed env vars (no longer honored): `PWRAGNT_STATE_ROOT`, `PWRAGNT_CONFIG_PATH`, `GROK_APP_SERVER_STATE_ROOT`.
- Multiple instances can share the same profile DB safely (sqlite WAL mode); no lockfile needed.

## Frontend and Desktop UI

- For renderer UI work, follow the desktop style guide before inventing local styling.
- For colors, tokens, and visual theme decisions, follow the UI theme guide before adding local CSS.
- Favor thread-first information hierarchy over generic dashboard layout.
- Do not ship scaffold narration or placeholder implementation copy in user-facing UI.

### Reuse existing chrome — copy tokens, don't pick new ones

When you build new chrome (a title bar strip, a brand mark, a breadcrumb,
an eyebrow, a path/app row), open `apps/desktop/src/renderer/src/styles/app.css`
and copy the token references from the existing primitive that solves the
same problem. Don't pick a new token because it "looks similar" — the brand
across windows must read identically.

Canonical primitives and the tokens they read:

| Primitive | Brand | Brand accent | Eyebrow | Breadcrumb separator | Breadcrumb current |
|---|---|---|---|---|---|
| `.sidebar__brand` (main sidebar) | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-nav__brand` (Settings nav) | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-titlebar__*` (Settings right-pane) | n/a | n/a | `--accent` | `--text-muted` | `--text-primary` |
| `.activity-titlebar__*` (Activity window) | `--text-primary` | `--accent` | `--accent` | `--text-muted` | `--text-primary` |

`apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx`
locks the brand-accent + breadcrumb token contract across these primitives.
A test fails if anyone (you, a future PR) picks a different accent token
for a brand mark or drifts the Activity titlebar breadcrumb away from the
Settings titlebar. **If you need to deliberately change a chrome token,
change the test in the same commit** so the intent is reviewed, not
accidental.

## Current Product Direction

- Threads are first-class and may exist without a directory.
- Inbox, Recents, and Directories share the thread lens switch, with Inbox leftmost.
- Recents is the default browsing lens.
- A thread may be associated with multiple linked Git directories.

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

This repository enforces a strict layered dependency architecture via
`dependency-cruiser` (`.dependency-cruiser.cjs`). These rules are load-bearing:

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** add imports from packages above a package's layer in the dependency hierarchy
- **DO NOT** introduce circular dependencies between any modules
- **DO NOT** move or restructure code to circumvent boundary rules
- If a rule blocks your change, the change is architecturally wrong — redesign it

The dependency hierarchy (bottom to top):
- **Leaves** (import nothing internal): `packages/shared`, `packages/codex-app-server-protocol`
- **Mid-tier**: `packages/messaging/interface` (→ shared only), `packages/messaging/providers/*` (→ messaging/interface only), `packages/agent-core` (→ shared only)
- **Top**: `apps/desktop` (→ any package)

Additional renderer constraint: `apps/desktop/src/renderer/` may only import `@pwragent/shared`. All other package access crosses the IPC bridge via the main process.

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation. Run it locally before pushing.

## App-Specific Guidance

- Additional desktop-app instructions live in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
- Messaging package boundary instructions live in [packages/messaging/AGENTS.md](packages/messaging/AGENTS.md). Review them before adding messaging integrations, changing messaging provider code, or deciding where messaging calls and workflow logic should live.
- For messaging architecture (separation of concerns between interface, providers, and desktop orchestration; data-flow diagrams; the capability-profile system; file map), read [docs/messaging-architecture.md](docs/messaging-architecture.md). For the per-adapter technical contract, [docs/messaging-adapter-contract.md](docs/messaging-adapter-contract.md). For operator setup and the command surface, [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md).
