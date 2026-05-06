# Shared Package Guidance

This package contains types, contracts, and utility functions shared across the monorepo. It is the lowest-level internal package.

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

This package is a **leaf**. It must not import any `@pwragent/*` package or any other internal workspace package.

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** add imports from any internal package — shared is the foundation layer
- **DO NOT** introduce circular dependencies between any modules
- If a rule blocks your change, the change is architecturally wrong — redesign it

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.
