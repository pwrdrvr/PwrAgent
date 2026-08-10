# Shared Package Guidance

This package contains types, contracts, and utility functions shared across the monorepo. It is the lowest-level internal package.

When changing shared settings/config contracts in a way that changes the TOML
shape persisted by the desktop app, read
[../../docs/config-file-evolution.md](../../docs/config-file-evolution.md)
before editing types. The reader/writer migration behavior lives in the desktop
app, but the shared contract should still be shaped to support recognized
legacy config values and current canonical values cleanly.

## No Import-Time Work

`package.json` declares `"sideEffects": false`. That is a promise to every
bundler that importing any module here does nothing but define values — so a
module whose exports are unused can be **dropped entirely**. It is what keeps
the preload bundle at its baseline size: preload imports one function from
this package, and without the flag Rollup cannot shake the `export *` barrel
and drags in ~7 KB (a 23% increase on a bundle parsed at every window
creation, before first paint).

The rule that follows: **no module in this package may do work at import
time.** Concretely, at module scope:

- No bare statements — no `console.*`, no calls whose result is discarded.
- No mutation of anything outside the module: no `globalThis`/`window`
  assignment, no registering into a shared registry, no polyfills.
- No reading ambient state that could differ per call: `Date.UTC(2026, 3, 23)`
  is fine (a constant), `Date.now()` at module scope is not.

Pure value construction bound to an export is fine and already common here —
`new Set([...])` of literals, `new RegExp` built from local constants,
`.map` over a local catalog.

Violating this does not fail a test. It produces a module that a bundler
silently omits, and the symptom appears far away as a missing export at
runtime. If you ever genuinely need import-time work, the fix is to remove
the flag (and re-measure the preload bundle), not to leave a false
declaration in place.

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

This package is a **leaf**. It must not import any `@pwragent/*` package or any other internal workspace package.

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** add imports from any internal package — shared is the foundation layer
- **DO NOT** introduce circular dependencies between any modules
- If a rule blocks your change, the change is architecturally wrong — redesign it

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.
