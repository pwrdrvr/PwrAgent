---
date: 2026-05-05
topic: dependency-boundary-enforcement
---

# Dependency Boundary Enforcement

## Problem Frame

The repo has a clear layered architecture where packages at the bottom of the dependency graph must not import packages above them. Today, dependency-cruiser enforces this for the messaging tree only (`packages/messaging` and `apps/desktop/src/main/messaging`). The rest of the repo — `packages/agent-core`, `packages/shared`, `packages/codex-app-server-protocol`, and the broader desktop app — has no automated boundary checking.

AI coding agents and future developers may inadvertently (or in the name of convenience) introduce circular dependencies or upward imports that create tightly coupled spaghetti. Once introduced, these are expensive to unwind. The existing AGENTS.md files describe boundaries but do not explicitly forbid weakening the enforcement tooling itself.

## Requirements

- R1. Expand `depcruise` coverage to enforce the full repo dependency hierarchy, not just the messaging subtree.
- R2. Enforce the following dependency DAG (each layer may only import layers below it):
  - **Leaves** (import nothing internal): `packages/shared`, `packages/codex-app-server-protocol`
  - **Mid-tier packages**: `packages/messaging/interface` (→ shared only), `packages/messaging/providers/*` (→ messaging/interface only), `packages/agent-core` (→ shared only)
  - **Top**: `apps/desktop` (may import any package)
- R3. Retain and preserve all existing messaging-specific rules (interface isolation, provider isolation, no sibling provider imports, no provider SDK leakage into desktop messaging core).
- R4. Add stern, unambiguous warnings to the root `AGENTS.md` and every package-level `AGENTS.md` stating that dependency boundary rules must not be loosened, exceptions must not be added to `.dependency-cruiser.cjs`, and circular dependencies are never acceptable.
- R5. The `pnpm lint:boundaries` command must scan all packages and apps, not just the messaging subtree.
- R6. CI continues to fail on boundary violations (already wired via `pnpm lint` → `pnpm lint:boundaries`).
- R7. The global `no-circular` rule must apply to all scanned source, not just messaging.
- R8. When `lint:boundaries` fails in CI, produce a readable GitHub Actions step summary showing which rules were violated, which files are involved, and the dependency path — using depcruise's built-in reporters rather than a custom report script.

## Success Criteria

- Running `pnpm lint:boundaries` catches any import from a leaf package (`shared`, `codex-app-server-protocol`) into a higher-level package.
- Running `pnpm lint:boundaries` catches any import from `agent-core` into `apps/desktop` or messaging providers.
- Running `pnpm lint:boundaries` catches any circular dependency anywhere in the scanned source.
- An AI agent reading any package's AGENTS.md encounters an explicit prohibition against loosening boundary rules or adding exceptions.
- The `.dependency-cruiser.cjs` file itself is called out in AGENTS.md as protected — agents must not modify it to add allowances.

## Scope Boundaries

- This work does not restructure existing code to fix violations (if any are found, they are flagged as separate follow-up work).
- This work does not add pre-commit hooks (CI is the enforcement gate).
- This work does not change the package dependency declarations in `package.json` files — it enforces the import graph at the source level.
- This work does not cover runtime/dynamic imports or `require()` calls that bypass static analysis (dependency-cruiser handles most of these, but edge cases are accepted).
- This work does not add a full custom report generator (like the openclaw 617-line script with Mermaid/SCC analysis). It uses depcruise's built-in output reporters for CI summaries.

## Key Decisions

- **Expand depcruise scope to whole repo**: The `lint:boundaries` command will scan all source under `packages/` and `apps/`, not just the messaging paths.
- **AGENTS.md warnings in all locations**: Root and every package-level AGENTS.md will carry the warning, even if redundant, to maximize visibility for AI agents that read local context.
- **CI already enforces**: No new CI step needed — `pnpm lint` already runs `lint:boundaries` and the CI `lint` job already runs `pnpm lint`.
- **Readable CI failure output**: Use depcruise's built-in reporters to emit a GitHub Actions step summary on failure (inspired by openclaw/openclaw#61519), not a custom report script.
- **codex-app-server-protocol is a leaf**: It has zero internal dependencies today and the rules will prevent any from being added.

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Are there any existing violations when depcruise scans the full repo? If so, they need to be cataloged and tracked as separate cleanup work.
- [Affects R5][Technical] Does the depcruise `tsConfig` option need adjustment (currently points to `tsconfig.base.json`) when scanning the full repo, or do individual package tsconfigs need to be resolved?
- [Affects R2][Needs research] Should `packages/agent-core` be allowed to import `packages/codex-app-server-protocol` (both are mid-tier but unrelated), or should they be fully isolated from each other?

## Next Steps

→ `/ce:plan` for structured implementation planning
