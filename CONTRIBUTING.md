# Contributing to PwrAgent

Thanks for taking the time to improve PwrAgent. This project is MIT-licensed
and currently in alpha, so expect active iteration.

## Development Setup

1. Install Node.js from `.nvmrc`.
2. Run `pnpm install`.
3. Run `pnpm dev` for the desktop app.

Useful checks:

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:desktop-e2e`
- `pnpm lint:boundaries`
- `pnpm licenses:check`

## Pull Requests

- Keep PRs focused on one change.
- Follow Conventional Commit-style PR titles, for example
  `feat(desktop): add settings shortcut`.
- Include tests or explain why the change is documentation-only.
- Run the relevant checks before requesting review.
- Update `THIRD_PARTY_LICENSES` with `pnpm licenses:generate` when dependency
  changes affect bundled notices.

## Architecture Rules

The dependency boundaries in `.dependency-cruiser.cjs` are load-bearing. Do not
loosen them to make a change pass. Renderer code may only import
`@pwragent/shared`; other package access crosses the IPC bridge through the
desktop main process.

## Conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).
