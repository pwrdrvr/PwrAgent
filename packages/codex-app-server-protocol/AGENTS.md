# Codex App Server Protocol Package Guidance

`src/` contains TypeScript bindings generated from the installed Codex binary.

Regenerate from the repo root with:

```bash
pnpm codex:generate-app-server-protocol
```

Or from this package with:

```bash
pnpm --filter @pwragent/codex-app-server-protocol generate
```

Do not edit generated files by hand. Use the stable bindings by default; only add experimental protocol imports when clients intentionally opt into experimental App Server APIs.

Keep this package as a leaf-level generated protocol package. Normalized PwrAgent app-server contracts belong in `@pwragent/shared`, not here.

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

This package is a **leaf**. It must not import any `@pwragent/*` package or any other internal workspace package.

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** add imports from any internal package — this is generated protocol types only
- **DO NOT** introduce circular dependencies between any modules
- If a rule blocks your change, the change is architecturally wrong — redesign it

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.
