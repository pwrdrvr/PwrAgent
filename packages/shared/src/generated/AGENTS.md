# Generated Protocol Guidance

`codex-app-server-protocol/` contains stable TypeScript bindings generated from the installed Codex binary.

Regenerate from the repo root with:

```bash
pnpm codex:generate-app-server-protocol
```

Or from `packages/shared` with:

```bash
pnpm codex:generate-app-server-protocol
```

Do not edit generated files by hand. Use the stable bindings by default; only add `--experimental` when clients intentionally opt into experimental App Server APIs.
