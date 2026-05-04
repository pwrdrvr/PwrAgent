# @pwragent/codex-app-server-protocol

TypeScript types for the Codex App Server JSON-RPC protocol, generated from the locally installed Codex CLI.

The contents of `src/` are generator output. Do not hand-edit generated files. Every generated file should carry a `// GENERATED CODE! DO NOT MODIFY BY HAND!` header.

To refresh:

```bash
pnpm codex:generate-app-server-protocol
# equivalent: pnpm --filter @pwragent/codex-app-server-protocol generate
```

By default the package script uses Codex Desktop's bundled binary:

```text
/Applications/Codex.app/Contents/Resources/codex
```

To override the generator binary:

```bash
PWRAGENT_CODEX_BIN=/path/to/codex pnpm codex:generate-app-server-protocol
```

The generated files are committed so PwrAgent builds cleanly without a Codex install at hand. Regenerate whenever:

- Codex Desktop autoupdates and the bundled `codex` binary version changes.
- A new Codex protocol surface lands that PwrAgent wants to consume.
- The committed generated files drift from the generator version noted below.

Current generated source: `codex-cli 0.128.0-alpha.1` from Codex Desktop's bundled binary (509 generated `.ts` files; v1 surface in `src/`, v2 surface in `src/v2/`).

## Why a separate package

PwrAgent's desktop Codex adapter talks to a locally installed Codex App Server over stdio JSON-RPC. Keeping the generated wire protocol in its own package means:

- The generator writes into one well-known location.
- Desktop Codex adapter code imports wire types via `@pwragent/codex-app-server-protocol` and `@pwragent/codex-app-server-protocol/v2`.
- `@pwragent/shared` stays focused on normalized PwrAgent contracts rather than generated Codex wire bindings.

## Subpath exports

| Import path | Maps to | Use for |
|---|---|---|
| `@pwragent/codex-app-server-protocol` | `src/index.ts` | v1 protocol surface |
| `@pwragent/codex-app-server-protocol/v2` | `src/v2/index.ts` | v2 protocol surface |

## Source of truth

The Rust source for the protocol is in the Codex repo under `app-server/`. The generator emits one TypeScript file per protocol type, plus barrel `index.ts` files. Commit regenerated output as a generated-file diff.
