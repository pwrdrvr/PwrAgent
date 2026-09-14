# Forge support

PwrAgent stores a forge **host** in `PrSummary.provider` (for example,
`github.com` or `code.example.com`). `ForgeKind` names the **product**
(`github`, `gitlab`). Do not substitute a product name for a persisted host:
PR numbers are scoped to the host and repository.

## Current integration boundaries

- GitHub status uses the GitHub CLI for credentials and an in-process GraphQL
  client against github.com. This does not implement GitHub Enterprise status.
- GitLab status uses `glab`, with one REST request per MR plus budgeted pipeline
  verification reads. Branch discovery recognizes gitlab.com and `gitlab.*`
  remotes. An explicit MR URL also supports other GitLab hosts and nested groups.
- The `gitlab.*` discovery convention is existing compatibility policy, not
  proof that a server runs GitLab. This refactor preserves it. Changing host
  evidence or adding configured host classification needs a separate decision.
- Generic detection, URL refresh, availability and scheduled polling use the
  forge registry. GitHub's batched branch priming is an optional optimization;
  it checks the enable switch before resolving remotes or accessing transport.
- Auth IPC, configuration storage and command discovery still belong to each
  CLI. Existing `applications.gh` and `applications.glab` settings retain their
  shape. A new CLI needs its own config/discovery/IPC implementation.

Attachment URL parsing and construction also use the catalog, in
`forge-reference.ts`. An existing PR URL supplies the product for a custom host;
a remote lookup must not erase that evidence. For backward compatibility,
URL-less attachments on unclassified hosts still build `/pull/` links. That
convention does not enable status fetching. A custom-host GitLab repository
needs an explicit MR URL to establish its product.

## Adding a forge

1. Add its kind to `FORGE_KINDS` and its product facts to `FORGE_PRODUCTS` in
   `packages/shared/src/forge-product.ts`. Facts include the CLI, SaaS host,
   namespace rule, request noun, settings guidance and paid-request batch size.
2. Add a URL parser to `PR_URL_PARSERS` in
   `apps/desktop/src/main/pr-status/forge-pr-ref.ts`. Return the actual host,
   owner, repository and number. Unsupported URLs must return `undefined`.
3. Implement the `ForgePrProvider` adapter in `forge-pr-fetcher.ts`: repository
   resolution, availability, branch lookup, URL lookup and polling. Register it
   in the exhaustive provider table. The router applies enable gates and loops
   over `FORGE_KINDS`; there is no second list of registered transports.
4. Implement CLI discovery and configuration, then fill the exhaustive cache
   and environment tables in `desktop-settings-service.ts`. Follow the config
   evolution guidance for persisted changes.
5. Add the status/picker IPC mapping in `forge-settings.ts`, the callbacks in
   `GitSettings.tsx`, and the CLI icon in `CommandToolsSettings.tsx`. Navigation,
   status seeding and section rendering enumerate `FORGE_KINDS` automatically.
6. Add provider fixtures and run the routing, remote, polling, settings and IPC
   tests. Verify unsupported hosts, mixed remotes, disabled providers, partial
   failure, reconnect and request admission. Use injected transports, never
   operator credentials or live CLIs.

Every integration table uses `Record<ForgeKind, ...>` (or `ForgeCli` for icons).
Adding a kind must produce missing-entry compiler errors, not silently choose
GitHub. Run `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` to see all
integration sites together; recursive typecheck can stop at the shared package's
first missing product entry. As an extension audit, temporarily add a throwaway
kind to `FORGE_KINDS`, run that command, and restore the file before normal checks.

Do not add product comparisons to generic callers. Keep product facts in the
shared catalog and transport behavior in exhaustive adapters. A forge's own
transport may naturally contain its protocol-specific rules.

## Request and persistence ownership

The scheduler preserves due-order and separates batches by product and host.
GitHub batches up to 40 PRs; GitLab batches one MR. A scheduler token pays for
one admitted request. `requestTokenTaken` tells the adapter that the initial
request is already paid; extra verification reads still need their own tokens.
Reconnect uses the same router and the GitHub adapter's reconnect probe.

Adapters return observations. The existing app-server status registry owns
persistence and publication; the router adds no SQLite writes or timers.
