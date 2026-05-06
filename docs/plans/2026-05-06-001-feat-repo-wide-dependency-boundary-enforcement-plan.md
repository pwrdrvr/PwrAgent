---
title: "feat: Expand dependency boundary enforcement repo-wide"
type: feat
status: active
date: 2026-05-06
origin: docs/brainstorms/2026-05-05-dependency-boundary-enforcement-requirements.md
---

# feat: Expand dependency boundary enforcement repo-wide

## Overview

Expand the existing dependency-cruiser setup from messaging-only coverage to the full monorepo, add new rules for all package layers, produce readable CI summaries on failure, and add stern AGENTS.md warnings that prevent AI agents and developers from weakening the enforcement.

## Problem Statement / Motivation

The repo has a layered architecture, but only the messaging subtree is checked by dependency-cruiser today. The rest (`packages/shared`, `packages/codex-app-server-protocol`, `packages/agent-core`, `apps/desktop` main/renderer) has no automated boundary enforcement. AI agents may introduce circular or upward imports without realizing the architectural cost. (see origin: docs/brainstorms/2026-05-05-dependency-boundary-enforcement-requirements.md)

## Proposed Solution

Three-layer approach:

1. **Expand `.dependency-cruiser.cjs`** with new rules for all package tiers
2. **Widen `lint:boundaries`** to scan the full source tree
3. **Add CI step summary** using depcruise's `markdown` reporter via JSON intermediate + `depcruise-fmt`
4. **Add AGENTS.md warnings** to root and every package-level AGENTS.md

## Technical Considerations

### Architecture

The dependency DAG is already clean (verified: 942 modules, 1227 dependencies, 0 violations when scanning the full repo today). This is purely additive enforcement — no existing code needs changing.

### Resolution

`tsconfig.base.json` has no path aliases. All `@pwragent/*` imports resolve through pnpm workspace symlinks in `node_modules/`. The existing `doNotFollow` option in depcruise skips actual npm packages but follows workspace symlinks correctly.

### CI Integration

`pnpm lint` → `pnpm lint:boundaries` is already gated in CI (`ci.yml` lint job). Expanding the depcruise scan arguments is automatically enforced.

## Implementation Phases

### Phase 1: Expand dependency-cruiser rules

Add these new rules to `.dependency-cruiser.cjs`:

**New rule: `shared-is-a-leaf`**
```javascript
{
  name: "shared-is-a-leaf",
  severity: "error",
  comment: "packages/shared must not import any internal workspace package.",
  from: { path: "^packages/shared/" },
  to: { path: "^(apps/|packages/(?!shared/))" },
}
```

**New rule: `codex-protocol-is-a-leaf`**
```javascript
{
  name: "codex-protocol-is-a-leaf",
  severity: "error",
  comment: "packages/codex-app-server-protocol must not import any internal workspace package.",
  from: { path: "^packages/codex-app-server-protocol/" },
  to: { path: "^(apps/|packages/(?!codex-app-server-protocol/))" },
}
```

**New rule: `agent-core-only-imports-shared`**
```javascript
{
  name: "agent-core-only-imports-shared",
  severity: "error",
  comment: "agent-core may only depend on packages/shared internally.",
  from: { path: "^packages/agent-core/" },
  to: { path: "^(apps/|packages/(?!shared/|agent-core/))" },
}
```

**New rule: `desktop-renderer-only-imports-shared`**
```javascript
{
  name: "desktop-renderer-only-imports-shared",
  severity: "error",
  comment: "The renderer process may only import @pwragent/shared. All other package access goes through IPC.",
  from: { path: "^apps/desktop/src/renderer/" },
  to: { path: "^packages/(?!shared/)" },
}
```

**Existing rules retained intact** (R3 from origin): all 7 messaging-specific rules stay unchanged.

### Phase 2: Widen lint:boundaries scan scope

Update root `package.json` script:

```diff
- "lint:boundaries": "depcruise --config .dependency-cruiser.cjs apps/desktop/src/main/messaging packages/messaging",
+ "lint:boundaries": "depcruise --config .dependency-cruiser.cjs packages/ apps/desktop/src/",
```

This scans all packages and the full desktop app source in a single pass. The `no-circular` rule (already present) will now enforce acyclicity repo-wide (R7).

### Phase 3: CI step summary on failure

Update `.github/workflows/ci.yml` lint step to produce a readable markdown summary when violations are detected:

```yaml
  lint:
    name: Lint
    runs-on: ubuntu-latest
    needs: install-deps
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
      - name: Install pnpm
        uses: pnpm/action-setup@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - name: Restore dependencies
        run: pnpm install --frozen-lockfile
      - name: Type check
        run: pnpm typecheck
      - name: Dependency boundaries
        run: |
          pnpm exec depcruise --config .dependency-cruiser.cjs \
            --output-type json --output-to cruise-result.json \
            packages/ apps/desktop/src/
          pnpm exec depcruise-fmt --exit-code cruise-result.json
      - name: Boundary violation summary
        if: failure()
        run: |
          pnpm exec depcruise-fmt -T markdown cruise-result.json >> "$GITHUB_STEP_SUMMARY"
```

This splits the lint script: `typecheck` stays as `pnpm typecheck` but the boundary check uses the JSON-then-format pattern so violations produce a readable GitHub step summary with rule names, file paths, and dependency chains (R8).

### Phase 4: AGENTS.md warnings

Add a `## Dependency Boundary Enforcement` section to these files:

1. **Root `AGENTS.md`** (canonical rules + stern warning)
2. **`packages/shared/AGENTS.md`** (new file — leaf declaration + warning)
3. **`packages/codex-app-server-protocol/AGENTS.md`** (existing file — add section)
4. **`packages/agent-core/AGENTS.md`** (new file — boundary + warning)
5. **`packages/messaging/AGENTS.md`** (existing file — strengthen existing section)
6. **`apps/desktop/AGENTS.md`** (existing file — add section)

**Warning template** (adapted per package):

```markdown
## Dependency Boundary Enforcement

⚠️ **DO NOT, under any circumstances, loosen the dependency boundary rules.**

This repository enforces a strict layered dependency architecture via
`dependency-cruiser` (`.dependency-cruiser.cjs`). These rules are load-bearing:

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** add imports from packages above this package's layer in the dependency hierarchy
- **DO NOT** introduce circular dependencies between any modules
- **DO NOT** move or restructure code to circumvent boundary rules
- If a rule blocks your change, the change is architecturally wrong — redesign it

The dependency hierarchy (bottom to top):
- Leaves: `packages/shared`, `packages/codex-app-server-protocol`
- Mid-tier: `packages/messaging/interface` (→ shared), `packages/messaging/providers/*` (→ interface), `packages/agent-core` (→ shared)
- Top: `apps/desktop` (→ any package)

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.
```

Each package-level AGENTS.md adds a line specifying what **this** package may import:
- `shared`: "This package is a leaf. It must not import any `@pwragent/*` package."
- `codex-app-server-protocol`: "This package is a leaf. It must not import any `@pwragent/*` package."
- `agent-core`: "This package may only import `@pwragent/shared`."
- `messaging/interface`: "This package may only import `@pwragent/shared`."
- `messaging/providers/*`: "This package may only import `@pwragent/messaging-interface`."
- `apps/desktop` renderer: "The renderer process may only import `@pwragent/shared`. Everything else crosses the IPC bridge."

## Acceptance Criteria

- [ ] `.dependency-cruiser.cjs` has rules enforcing the full dependency DAG (R1, R2)
- [ ] All existing messaging rules remain intact and passing (R3)
- [ ] `pnpm lint:boundaries` scans all packages and apps (R5)
- [ ] `no-circular` rule applies repo-wide (R7)
- [ ] CI produces a markdown step summary on boundary violations (R8)
- [ ] Root AGENTS.md contains the stern boundary warning (R4)
- [ ] Every package-level AGENTS.md contains the boundary warning (R4)
- [ ] `pnpm lint:boundaries` passes on the current codebase (verified: 0 violations)
- [ ] A simulated violation (e.g., adding `import '@pwragent/agent-core'` in `packages/shared`) is caught

## Dependencies & Risks

- **Risk**: `depcruise-fmt` needs to be available in CI. It ships with the `dependency-cruiser` npm package (already in devDependencies), so no new install needed.
- **Risk**: Scanning the full `packages/` and `apps/desktop/src/` may increase lint time. Current messaging-only scan is fast; the full scan (942 modules) completed in under 5 seconds locally — acceptable.
- **Risk**: Future packages added to the workspace won't automatically get AGENTS.md warnings. Mitigation: the root AGENTS.md warning covers everything, and `no-circular` + leaf rules apply globally regardless of AGENTS.md presence.

## Resolved Deferred Questions

| Question | Resolution |
|----------|-----------|
| Existing violations when scanning full repo? | **None** — verified 0 violations across 942 modules. |
| Does tsConfig need adjustment? | **No** — `tsconfig.base.json` has no path aliases. Resolution works via pnpm workspace symlinks. |
| Should agent-core import codex-app-server-protocol? | **No** — they are unrelated mid-tier packages. Both import only `shared`. Enforce isolation. |

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-05-05-dependency-boundary-enforcement-requirements.md](docs/brainstorms/2026-05-05-dependency-boundary-enforcement-requirements.md) — Key decisions: expand coverage repo-wide, warnings in all AGENTS.md files, use built-in reporters for CI summaries.

### Internal References

- Current depcruise config: [.dependency-cruiser.cjs](../../.dependency-cruiser.cjs)
- Root package.json lint scripts: [package.json:16-17](../../package.json:16)
- CI workflow lint job: [.github/workflows/ci.yml:29-41](../../.github/workflows/ci.yml:29)
- Messaging AGENTS.md boundary section: [packages/messaging/AGENTS.md:9-13](../../packages/messaging/AGENTS.md:9)

### External References

- dependency-cruiser CLI docs: https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md
- dependency-cruiser `markdown` reporter for step summaries
- `depcruise-fmt` for JSON-to-reporter formatting without re-scanning
- Inspiration: openclaw/openclaw#61519 (non-blocking circular report in CI)
