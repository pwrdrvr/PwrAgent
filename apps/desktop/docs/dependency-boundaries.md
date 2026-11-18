# Dependency Boundary Enforcement

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

The desktop app sits at the **top** of the dependency hierarchy and may import any `@pwragent/*` package. However:

- The **renderer** (`src/renderer/`) may only import `@pwragent/shared`. All other package access must go through IPC to the main process.
- The **main process** may import any package but must not create circular dependencies.

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** import provider SDKs (`grammy`, `discord.js`, `telegraf`) in `src/main/messaging/core/`
- **DO NOT** introduce circular dependencies between any modules
- If a rule blocks your change, the change is architecturally wrong — redesign it

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.
