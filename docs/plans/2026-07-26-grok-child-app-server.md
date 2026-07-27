# Grok Child App-Server Process

## Goal

Move the Grok agent runtime out of Electron main and into a packaged,
cross-platform child app-server process. Electron main remains the desktop
orchestrator and communicates with the child exclusively through bidirectional
JSON-RPC over stdio.

## Architectural constraints

- `apps/desktop` must not import `@pwragent/agent-core`.
- The child owns `GrokProvider`, `CodexAppServer`, session state, rollout
  persistence, AI SDK, and xAI runtime implementation.
- The production desktop Grok client must be process-backed. Explicit
  in-memory fakes remain acceptable in tests.
- JSON-RPC protocol traffic uses stdout/stdin; diagnostics use stderr only.
- Desktop may resolve a keychain-backed API key, but must pass it deliberately
  to the child without logging it.
- Development and packaged launch paths must work on macOS, Windows, and Linux.
- `out/main/index.js` must not contain AI SDK or xAI runtime implementation.

## Implementation

- [x] Add the dependency-cruiser rule and record its expected failure against
      the existing desktop imports.
- [x] Add a standalone Grok app-server stdio entrypoint and transport bridge.
- [x] Replace the embedded production Grok client with a managed child-process
      JSON-RPC client.
- [x] Preserve profile-scoped config/state and secret precedence across the
      process boundary.
- [x] Build and package the child entrypoint for all desktop targets.
- [x] Remove every desktop import of `@pwragent/agent-core`.
- [x] Add main-bundle exclusion checks and real-process integration coverage.
- [x] Update current architecture and contributor-facing documentation.
- [x] Run focused tests, full lint/typecheck/boundaries/licenses, desktop build,
      relevant unit suites, and packaged-path smoke/E2E.
- [x] Commit, push, and open a draft pull request.
- [x] Preserve the pre-process-boundary XDG state root for upgraded default
      profiles.
- [x] Build the child during the normal desktop development bootstrap.
- [x] Pass the repository-local env path explicitly to development children.
- [x] Gate network-backed Grok tests behind the explicit `test:live` lifecycle
      so ambient user credentials cannot turn the ordinary suite into a live
      run.
- [x] Preserve sanitized xAI stream diagnostics when the AI SDK reports a
      no-output result.

## Validation record

- The new Dependency Cruiser rule failed against the pre-refactor tree with
  17 desktop-to-agent-core violations, then passed after the process boundary
  was complete.
- Pinned runtime: Node `v24.14.1`, pnpm `10.33.0`.
- `pnpm lint` passed, including SQL, Codex storage, renderer colors, licenses,
  ESLint, workspace typecheck, and Dependency Cruiser.
- `pnpm test --testTimeout 30000` passed 4,973 tests across 385 files, with
  the one live-test file and its three network-backed tests skipped as intended,
  after rebasing onto current `origin/main` and applying review follow-ups. The
  larger timeout avoids two existing 5-second environment-action tests flaking
  under the full parallel suite.
- Focused child-process and config coverage passed, including initialization,
  profile persistence, thread operations, turn notifications, bidirectional
  approval requests, structured generation against a local xAI-compatible
  endpoint, clean shutdown, and child failure.
- Desktop production build passed. The post-build guard scanned 13 Electron
  main chunks and found no AI SDK/xAI runtime; `out/main/index.js` was
  2,329,589 bytes while the separately staged child was 828,821 bytes.
- Electron replay smoke passed (`e2e/smoke.spec.ts`).
- macOS universal package dry-run passed. ASAR verification found 6,919
  entries, required Grok child present, and no forbidden patterns.
- The packaged ASAR child launched through the packaged Electron binary with
  `ELECTRON_RUN_AS_NODE=1` and returned valid `initialize` and `shutdown`
  responses. The dry-run release path now disables hardened runtime only for
  its ad-hoc signature; signed releases retain hardened runtime.
- Review follow-up coverage verifies the default-profile XDG legacy-state
  probe, isolated child env loading with keychain precedence, and child build
  execution during the normal desktop dev bootstrap.
- The 1Password-backed live runner passed all three Grok scenarios against
  xAI. Focused coverage also verifies that ordinary tests skip the live suite
  despite an ambient API key and that provider diagnostics retain HTTP status
  while redacting bearer tokens and API-key values.
