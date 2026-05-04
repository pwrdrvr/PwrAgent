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
