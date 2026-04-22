# Codex App Server Protocol Guidance

The Codex App Server wire protocol types in `generated/protocol/` are generated from the installed Codex binary. Do not edit generated files by hand.

Regenerate the stable TypeScript bindings with:

```bash
codex app-server generate-ts --out apps/desktop/src/main/codex-app-server/generated/protocol
```

Use the stable surface by default. Only pass `--experimental` when the desktop client intentionally opts into experimental App Server APIs during `initialize`.

The generated types model the Codex wire protocol. Keep desktop-facing contracts in `@pwragnt/shared` normalized to PwrAgnt concepts, and do Codex-specific alias handling only at this adapter boundary.
