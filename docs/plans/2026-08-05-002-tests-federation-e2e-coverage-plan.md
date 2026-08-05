---
title: "tests: Federation E2E coverage"
type: tests
date: 2026-08-05
---

# Federation E2E coverage

## Summary

Before this plan the desktop E2E suite had 68 spec files and zero federation
coverage — enrollment, remote browsing, remote-window chrome hiding, and the
"no local fallback" security invariant were guarded only by unit tests. This
plan adds a two-instance harness and the first spec, and records the intended
follow-on coverage.

## Harness decision: in-process gateway + real Electron client

Launching two full Electron instances per test is possible (two `homeRoot`s +
`PWRAGENT_PROFILE`/`PWRAGENT_INSTANCE_ROOT` sets) but doubles launch cost and
flake surface. Instead,
[e2e/fixtures/federation-gateway.ts](../../apps/desktop/e2e/fixtures/federation-gateway.ts)
runs a **real gateway inside the Playwright test process**:

- real sqlite-backed `FederationStore` (temp `StateDb`),
- real Ed25519 identity + Noise_IK static keys,
- real `FederationGatewayWebSocketServer` on `127.0.0.1:0`,
- real capability-checked `FederationRouter` +
  `registerFederationBackendHandlers`,
- a **canned `FederationBackendOperations`** behind the router (the only fake
  piece) that serves navigation snapshots/threads/transcripts and records
  every routed call for assertions.

The launched Electron app enrolls as a genuine client, so invite redemption,
the Noise handshake + channel-bound enrollment proof, capability grants,
remote snapshot decoration, and renderer→main→federation routing all run
production code on both ends of the wire. The federation transport modules
are Electron-free (only `ws`, `node:*`, `better-sqlite3`), which is what makes
the in-process gateway possible.

Two constraints discovered while building it:

- Federation key material requires a writable secret store — specs must pass
  `secretStorage: "memory"` to `launchElectronApp` (the E2E default reports
  storage unavailable).
- The client-side peer label for an enrolled gateway is the generic
  "Gateway"; specs assert the `Remote · ` masthead branding, not the
  gateway's self-declared label.

## Implemented spec

[e2e/federation-remote-window.spec.ts](../../apps/desktop/e2e/federation-remote-window.spec.ts)
— one journey test:

1. **Enroll** through the real Settings UI: Open settings → Federation →
   paste invite (`Import invite` textarea, aria-label added for this spec) →
   Import → "Invite imported. Connecting to …" → Connection section shows
   Connected (health polls every 2s).
2. **Browse remote threads** → dedicated remote window
   (`__pwragentFederationTarget` global asserted); the peer's threads render
   and the local thread does not leak in.
3. **Remote-window chrome**: `Open settings` / `Open automations` buttons and
   the MSG chip absent; opening a remote thread renders the peer transcript
   with no integrated-terminal toggle.
4. **No local fallback**: calling `refreshThreadPullRequests` from the remote
   window's renderer rejects with the owning-instance error (main-process
   sender guard), and the gateway's recorded calls contain no local-only
   methods.
5. **Pin/unpin propagation**: context-menu Pin/Unpin routes
   `backend.setThreadPin` to the gateway; the canned backend's pin state is
   the assertion target (the owner's store is authoritative, not the
   viewer's).

## Follow-on coverage (separate specs, same harness)

- [ ] **Event propagation**: gateway pushes a `backend.event`
      (`thread/pin/added`, `thread/pullRequests/updated`) and the remote
      window's sidebar patches live without a manual refresh.
- [ ] **Federated search**: a local-window search shows remote results with
      the per-instance chips and the "Remote: …" summary line, and a remote
      result opens a remote window seeded with `initialThread`.
- [ ] **Capability denial**: re-enroll with a reduced capability grant and
      assert `Browse remote threads` stays disabled without `remote_window`,
      and a pin attempt surfaces `capability_denied` without corrupting the
      viewer's snapshot.
- [ ] **Disconnect behavior**: stop the in-process gateway and assert the
      remote window degrades (peer status) rather than falling back to local
      data.
- [ ] **Remote PTY** (once the
      [remote PTY plan](2026-08-05-001-feat-federation-remote-pty-plan.md)
      ships): open the remote terminal, run `echo`, assert output renders in
      the viewer and the command ran on the owner.

## Verification

- [x] `federation-remote-window.spec.ts` passes locally against a built
      `apps/desktop/out/` (`npx playwright test -c playwright.config.ts
      e2e/federation-remote-window.spec.ts`).
- [x] Harness cleans up: gateway socket, temp sqlite state root, and the
      Electron `homeRoot` are removed in `finally`.
- [x] Typecheck, ESLint, and dependency boundaries pass with the new
      fixture + spec.
