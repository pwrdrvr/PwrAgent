# Agent Core Package Guidance

This package contains the coding agent implementation (currently the Grok coding agent via AI SDK).

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

This package may only import `@pwragent/shared`. It must not import desktop, messaging, codex-app-server-protocol, or any other internal package.

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** add imports from any internal package other than `@pwragent/shared`
- **DO NOT** introduce circular dependencies between any modules
- If a rule blocks your change, the change is architecturally wrong — redesign it

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.
