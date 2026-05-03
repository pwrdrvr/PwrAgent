---
title: Desktop Release Packaging (v1.0 — Mac, Closed-Source, PwrDrvr LLC)
type: feat
status: active
date: 2026-05-02
origin: docs/brainstorms/2026-05-02-desktop-release-packaging-requirements.md
---

# Desktop Release Packaging (v1.0 — Mac, Closed-Source, PwrDrvr LLC)

> **Update (2026-05-02 PM):** Apple Developer Program enrollment for PwrDrvr LLC is
> already active. **Team ID: `T44CNHC4UH`**, Team Name: `PwrDrvr LLC`. This collapses
> Phase A from "multi-week enrollment lead time" into "verify existing assets" — the
> plan's parallelism still applies, but Phases A, B, C, D can all start the same day.

## Overview

Stand up the first-ever PwrAgent user-facing macOS release pipeline: a branded, code-signed,
notarized, ASAR-archived Electron app, owned by PwrDrvr LLC, distributed outside the Mac
App Store as a downloadable DMG, with auto-update via `electron-updater`. Apple Silicon
only at v1.0; Intel x64 deferred to demand. The plan honors every decision recorded in the
[origin requirements doc](../brainstorms/2026-05-02-desktop-release-packaging-requirements.md)
and resolves its eight `Deferred to Planning` questions with concrete configuration,
phased implementation, and explicit acceptance criteria.

The phrase "eject from the default Electron runner" is a useful framing of the user
intent but not literally what happens: Electron itself is **not** forked. `electron-builder`
takes the stock Electron binary, renames it (`Electron.app` → `PwrAgent.app`,
`Electron Helper (Renderer)` → `PwrAgent Helper (Renderer)`, etc.), rewrites `Info.plist`
including `CFBundleIdentifier` and `NSHumanReadableCopyright`, applies the `.icns` icon,
hardens the runtime, signs with the PwrDrvr LLC Developer ID, submits to Apple's
notarization service, staples the ticket, and packages the result as a DMG (and a ZIP for
auto-update). Apps like Codex Desktop, Linear, Slack, Hyper, and VS Code all use this
approach.

Key carry-forward decisions (see origin):

- **Closed-source proprietary** at v1.0; OSS-vs-paid decision deferred. `package.json` stays
  `private: true` with `license: "UNLICENSED"`.
- **Apple Developer ID = PwrDrvr LLC organization** (not personal). Liability shield aligns
  with the LLC's legal posture.
- **Distribution = outside Mac App Store**, signed + notarized + stapled DMG.
- **Auto-update = `electron-updater`**. **Phase 1** points at the existing private
  `pwrdrvr/PwrAgent` GitHub repo (solo dogfooding); **Phase 2** distribution channel
  decision deferred until just before any external test users join.
- **Architecture = Apple Silicon (arm64) only at v1.0.**
- **No monetization scaffolding now**, just clean account/identity boundaries so a future
  paid tier is a feature add.
- **All four Electron Helper bundles** must be renamed (the "still says Electron Helper in
  Activity Monitor" trap is captured as a success criterion).

## Problem Statement

PwrAgent is preparing its first user-facing macOS release. This is a first-time Electron
shipment for the developer, and the decisions are coupled in non-obvious ways:

- **Legal posture**: copyright, ownership, and liability must clearly attach to PwrDrvr
  LLC, not to an individual. The Apple Developer ID, `Info.plist`, `package.json`, README,
  and an explicit `LICENSE` file all must align.
- **First-launch UX**: a non-notarized app on macOS Sequoia (14+) cannot be opened by
  right-click → Open anymore — Apple removed that bypass. Users must visit System Settings
  → Privacy & Security to override Gatekeeper. For a closed preview where every test user
  matters, that friction is unacceptable. **Notarization is mandatory from day one.**
- **Helper renaming is the most-missed step.** Apps that rename only the main `.app` but
  leave four child helper processes named `Electron Helper (Renderer/GPU/Plugin)` are
  visibly unprofessional in Activity Monitor and erode trust before the user has rendered
  a single frame.
- **Auto-update + private repo coupling**: shipping `electron-updater` against a private
  GitHub repo introduces a `GH_TOKEN` that has to reach the running binary somehow. Baking
  it in is widely discouraged; the right Phase 1 choice for a solo developer is
  environment-variable injection at launch, with a Phase 2 migration plan to remove the
  token entirely.
- **pnpm + ASAR**: PwrAgent is a pnpm workspace; pnpm's symlinked virtual store interacts
  poorly with electron-builder's default `node_modules` walk into the ASAR archive. This
  is the single biggest packaging risk and must be solved before notarization is even
  attempted.
- **Long-lead-time blocker**: Apple Developer Program enrollment as an LLC requires a
  D-U-N-S number from Dun & Bradstreet (free via Apple's portal), then Apple verification.
  Best case is 5–7 business days; worst case is 4–6 weeks. Nothing about signing or
  notarization can begin until this completes. **The plan must let Phases B + C + D
  proceed in parallel with Phase A** so calendar time is not wasted.

## Proposed Solution

A **six-phase implementation** with explicit dependency arrows:

```
Phase A (Prerequisites)         Phase B (Branding/Metadata)   Phase C (Build Config)   Phase D (pnpm/ASAR)
   D-U-N-S → Apple Dev Program     package.json hygiene          electron-builder.yml      pnpm deploy strategy
   → Developer ID Application      app.setAboutPanelOptions      entitlements.mac.plist    release script orchestration
   → ASC API Key                   LICENSE + EULA                .icns icon                local unsigned build smoke
                                   Help menu fixes               electronFuses
                                   Settings → About row          electron-vite minify
                                   client.ts version fix
                                   README rewrite
   ────────────┬───────────────────────────┬──────────────────────────┬─────────────────────────┘
               ▼                           ▼                          ▼
                                Phase E (Sign + Notarize)
                                     local end-to-end
                                     signed/notarized build
                                     Activity Monitor verify
                                          │
                                          ▼
                                 Phase F (Auto-Update Wiring)
                                     electron-updater integration
                                     GH_TOKEN strategy
                                     Settings → Check for Updates UI
                                     local upgrade smoke test
                                          │
                                          ▼
                                 Phase G (CI Release Pipeline)
                                     .github/workflows/release.yml
                                     macos-14 runner, secrets
                                     tag-triggered single command
                                          │
                                          ▼
                                 Phase H (Phase 1 → 2 Migration Prep)
                                     runbook, decision deadline
                                     bridge-release plan
```

Phase A is calendar time, mostly waiting. Phases B + C + D are pure code/config work that
can run **in parallel** with Phase A. Phase E onward is gated on Phase A finishing.

## Technical Approach

### Architecture

#### Packager: `electron-builder` (rationale)

Carrying forward the origin decision (see origin: §Key Decisions). 2026 research confirms
the choice. Forge has narrowed the gap (auto-enables ASAR-integrity fuses, ships universal
builds first), but for a closed-source mac-only app the deltas are configuration, not
capability. electron-builder + `@electron/notarize` + `electron-updater` is the same
toolchain Linear, Hyper, and Standard Notes ship today.

Top-level files introduced:

```
apps/desktop/
├── electron-builder.yml          # Single source of build truth
├── build/
│   ├── icon.icns                 # 1024×1024 source converted via iconutil
│   ├── entitlements.mac.plist    # Hardened Runtime exemptions
│   ├── entitlements.mac.inherit.plist  # Helper bundles (typically same content)
│   ├── dmg-background.png        # Optional cosmetic; can defer
│   └── notarize.cjs              # Optional afterSign hook (only if @electron/notarize boolean is insufficient)
├── scripts/
│   └── release.mjs               # Orchestrator: pnpm deploy → electron-builder → publish
└── package.json                  # Add author/license/description/copyright + electron-updater dep
```

Top-level repo files:

```
LICENSE                            # Proprietary boilerplate (PwrDrvr LLC)
.github/workflows/release.yml      # Tag-triggered macos-14 runner
```

#### Bundle Identifier and Signing Identity

- `appId: com.pwrdrvr.pwragent`
- `mac.helperBundleId: com.pwrdrvr.pwragent.helper`
- `mac.helperRendererBundleId: com.pwrdrvr.pwragent.helper.Renderer`
- `mac.helperGPUBundleId: com.pwrdrvr.pwragent.helper.GPU` (note the capital `GPU` —
  electron-builder's TypeScript field is literally `helperGPUBundleId`, lowercase `gpu`
  silently no-ops)
- `mac.helperPluginBundleId: com.pwrdrvr.pwragent.helper.Plugin`
- Signing identity resolves automatically from Keychain when env var
  `CSC_NAME="Developer ID Application: PwrDrvr LLC (T44CNHC4UH)"` matches an installed
  cert. Team ID is `T44CNHC4UH`.

#### Hardened Runtime Entitlements (minimal, 2026)

`build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
                       "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
```

**Deliberately omits `com.apple.security.cs.disable-library-validation`** based on 2026
best-practice findings. PwrAgent has zero native modules (verified during repo research:
no `.node` files anywhere outside `node_modules`, no `keytar`/`better-sqlite3`/`sharp`/
`node-pre-gyp`/`node-gyp` deps). If a future native dep forces the issue, add the key and
re-notarize. The entitlements file is reused for `entitlementsInherit`.

#### electron-vite Production Build Override

Default `build.minify` is **false** for all three targets — the existing
`electron.vite.config.ts` produces unminified output today. Override:

```ts
// apps/desktop/electron.vite.config.ts
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@pwragent/shared", "@pwragent/agent-core"] })],
    build: { minify: "esbuild", sourcemap: false },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@pwragent/shared"] })],
    build: {
      minify: "esbuild",
      sourcemap: false,
      rollupOptions: { output: { format: "cjs" } },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { "@renderer": resolve(__dirname, "src/renderer/src") } },
    build: { minify: "esbuild", sourcemap: false, target: "esnext" },
  },
});
```

Esbuild minification is the right default; switch to terser only if a measured size win
justifies the build-time cost. Sourcemaps are **off** for shipped builds — if Sentry-like
crash reporting is added later (out of scope for this plan), upload sourcemaps separately.

#### electron-builder.yml (annotated)

```yaml
appId: com.pwrdrvr.pwragent
productName: PwrAgent
copyright: "Copyright © 2026 PwrDrvr LLC. All rights reserved."

# Bundle layout
asar: true
asarUnpack:
  - "**/*.node"            # Defensive — currently no .node files exist; future-proof
compression: normal

# Files included in the .app bundle (electron-builder's defaults are good once
# pnpm deploy has materialized a flat node_modules; see Phase D)
files:
  - "out/**/*"
  - "package.json"
  - "!**/*.map"
  - "!**/*.ts"
  - "!**/*.test.*"
  - "!**/__tests__/**"

# Electron fuses — enable ASAR integrity (NOT on by default in electron-builder)
electronFuses:
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
  loadBrowserProcessSpecificV8Snapshot: false
  grantFileProtocolExtraPrivileges: false

mac:
  category: public.app-category.developer-tools
  icon: build/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  notarize: true                  # Requires APPLE_API_KEY/ID/ISSUER OR APPLE_ID/PASSWORD/TEAM_ID env
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist  # Same content
  # Helper bundle renames — verify post-build with Activity Monitor
  helperBundleId: com.pwrdrvr.pwragent.helper
  helperRendererBundleId: com.pwrdrvr.pwragent.helper.Renderer
  helperGPUBundleId: com.pwrdrvr.pwragent.helper.GPU
  helperPluginBundleId: com.pwrdrvr.pwragent.helper.Plugin
  extendInfo:
    NSHumanReadableCopyright: "Copyright © 2026 PwrDrvr LLC. All rights reserved."
    LSMinimumSystemVersion: "12.0"   # macOS Monterey baseline; reasonable in 2026
    LSApplicationCategoryType: public.app-category.developer-tools
  target:
    - target: dmg
      arch: [arm64]
    - target: zip                  # Required for Squirrel.Mac auto-update
      arch: [arm64]

dmg:
  writeUpdateInfo: false           # latest-mac.yml is generated from the .zip
  # Optional cosmetic; defer if not ready: background, contents layout

# Phase 1: github provider against the existing private pwrdrvr/PwrAgent repo.
# Phase 2: this block migrates to a public release repo, public source repo, or
# generic provider against R2/CloudFront. See Phase H runbook.
publish:
  provider: github
  owner: pwrdrvr
  repo: PwrAgent
  private: true
  releaseType: release
```

#### Auto-Update — Phase 1 Token Strategy

The origin doc said "GH_TOKEN with read-only access to that repo" for Phase 1 (see origin:
R8). 2026 best-practice findings strongly discourage baking a token into the shipped
binary because anyone with the binary can extract it via `strings` or memory snapshot. For
solo Phase 1 there is exactly **one** binary user (you), so the threat model is degenerate
— but baking still creates a habit/precedent that will need to be unwound at Phase 2.

**Plan: read `GH_TOKEN` from `process.env` at runtime**, no baking. The user launches the
app via Terminal on first run after each upgrade, OR via a tiny `~/Library/LaunchAgents`
plist that injects the env var, OR via a wrapper script. This costs ~1 minute of one-time
ergonomics during solo dogfooding and saves the security-debt of removing a baked token at
Phase 2. The Phase 2 migration removes the token entirely (public artifacts, no token
needed).

If at Phase 1 the env-var ergonomics prove unbearable in practice, a fine-grained PAT
(scopes: `Contents: Read`, `Metadata: Read`; expiry 90 days; restricted to `pwrdrvr/PwrAgent`
only) can be baked via Vite `define` as a fallback. Document this fallback path in the
implementation but do not start there.

#### pnpm + ASAR Strategy (Phase D)

Three options:

1. **`pnpm deploy --filter @pwragent/desktop --prod` to a staging dir** — pnpm walks the
   workspace symlinks and produces a self-contained, flat `node_modules` tree. Run
   electron-builder against the staged dir. This is the recommended path: clean separation,
   does not affect dev workflow, is the documented pnpm+Electron pattern in 2026.
2. `.npmrc` with `node-linker=hoisted` for release-only installs. Affects the entire
   workspace install model and risks subtle dev/release behavioral differences.
3. Custom electron-builder `files` glob walking the `.pnpm` virtual store. Brittle.

**Choose Option 1.** The release script (`apps/desktop/scripts/release.mjs`) orchestrates:

```
1. pnpm install --frozen-lockfile             # ensure devDeps for the build
2. pnpm --filter @pwragent/desktop build       # electron-vite build → out/
3. pnpm deploy --filter @pwragent/desktop --prod /tmp/pwragent-deploy
4. cp -r /tmp/pwragent-deploy/{out,package.json,build} <stage>
5. cd <stage> && electron-builder --mac --arm64 --publish always
```

(The exact paths and whether to use `pnpm deploy` directly into `apps/desktop/release-stage`
or a tmp dir is a planning-time micro-decision; the release script will encapsulate it.)

### Implementation Phases

#### Phase A — Verify Existing Assets (enrollment already done)

**Owner:** human only. **Dependencies:** none. **Status:** Apple Developer Program is
already active for PwrDrvr LLC (Team ID **`T44CNHC4UH`**). This phase is now a verify-and-
inventory step rather than a multi-week wait.

- [ ] **A1.** Confirm in Apple Developer portal that the membership is active under
      `PwrDrvr LLC` / `T44CNHC4UH` and the Account Holder role is on the right person.
- [ ] **A2.** **Developer ID Application certificate** — verify one exists. If it does:
      ensure it is in the dev Mac's Keychain. Run
      `security find-identity -v -p codesigning` and confirm it lists
      `Developer ID Application: PwrDrvr LLC (T44CNHC4UH)`. If it does not exist, generate
      one in Apple Developer portal → Certificates and download to the dev Mac (the
      private key is created locally during the CSR flow, so it must be done on the
      machine that will hold the cert long-term).
- [ ] **A3.** **Export the cert + private key as a password-protected `.p12`** from
      Keychain (Keychain Access → right-click the identity → Export → .p12). Save the
      `.p12` and the password to 1Password.
- [ ] **A4.** **App Store Connect API key for notarization** — in App Store Connect →
      Users and Access → Integrations → Keys, create a key with the **Developer** role
      (least privilege that can notarize). Download the `.p8` (one-time download). Note
      the Key ID and Issuer ID.
- [ ] **A5.** Store the secret bundle in 1Password (or your secret manager of choice):
      - `.p12` (base64-encoded for CI as `CSC_LINK`)
      - `.p12` password (`CSC_KEY_PASSWORD`)
      - `.p8` (base64-encoded for CI as `APPLE_API_KEY`)
      - Key ID (`APPLE_API_KEY_ID`)
      - Issuer ID (`APPLE_API_ISSUER`)
      - Team ID (`T44CNHC4UH`)

**Acceptance:** `security find-identity -v -p codesigning` on the dev Mac lists
`Developer ID Application: PwrDrvr LLC (T44CNHC4UH)` exactly once, and the 1Password entry
contains all six values above.

#### Phase B — Branding + Metadata (parallel with A; pure code/config)

**Owner:** code. **Dependencies:** none. **Estimated effort:** 1–2 days.

- [ ] **B1.** Update root [`package.json`](package.json):
      - Add `"author": "PwrDrvr LLC"`
      - Add `"description": "Thread-centric coding agent desktop app"` (or final marketing
        copy)
      - Add `"license": "UNLICENSED"`
      - Confirm `"private": true` (already set)
- [ ] **B2.** Update [`apps/desktop/package.json`](apps/desktop/package.json):
      - Add `"author": "PwrDrvr LLC"`
      - Add `"description"` matching root
      - Add `"license": "UNLICENSED"`
      - Confirm `"productName": "PwrAgent"` (already set)
      - Add `"copyright": "Copyright © 2026 PwrDrvr LLC. All rights reserved."` at the top
        level (electron-builder reads this if `electron-builder.yml` does not override).
- [ ] **B3.** Add `LICENSE` at repo root with proprietary boilerplate:
      ```text
      Copyright © 2026 PwrDrvr LLC. All rights reserved.

      This software and associated documentation files (the "Software") are
      proprietary to PwrDrvr LLC. No part of the Software may be reproduced,
      distributed, modified, reverse-engineered, or used to create derivative
      works without the prior written consent of PwrDrvr LLC. Use of the
      Software is governed solely by the terms of the end-user license
      agreement under which it is distributed.
      ```
      Note: a fuller EULA with warranty disclaimers, choice-of-law, and arbitration
      clauses is recommended before paid launch but is **out of scope** for v1.0 (origin §
      Scope Boundaries).
- [ ] **B4.** Wire `app.setAboutPanelOptions` in
      [`apps/desktop/src/main/index.ts`](apps/desktop/src/main/index.ts) inside
      `bootstrapApp()` immediately after `app.setName(APP_NAME)`:
      ```ts
      app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: app.getVersion(),
        copyright: "Copyright © 2026 PwrDrvr LLC. All rights reserved.",
        version: app.getVersion(),
      });
      ```
      Without this the macOS App menu's "About PwrAgent" item shows Electron's defaults.
- [ ] **B5.** Replace hardcoded version in
      [`apps/desktop/src/main/codex-app-server/client.ts:4251`](apps/desktop/src/main/codex-app-server/client.ts:4251):
      `version: "0.1.0"` → `version: app.getVersion()`. Without this every release reports
      itself as `0.1.0` to the Codex App Server.
- [ ] **B6.** Replace the placeholder Help menu in
      [`apps/desktop/src/main/index.ts:48-58`](apps/desktop/src/main/index.ts:48). Today
      it links to `https://github.com/pwrdrvr/PwrAgent`, which 404s for non-collaborators.
      Replace with a marketing landing URL (e.g. `https://pwragent.com` or a holding page
      under `pwrdrvr.com`) and add structured items: `About PwrAgent` (calls
      `app.showAboutPanel()`), `Documentation`, `Report an Issue`. If no marketing URL is
      ready by release, **remove** the broken link rather than ship it.
- [ ] **B7.** Add a Settings → About row in
      [`apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx`](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx).
      Show: app name, version (read via a new IPC call — extend the existing
      `runtime-identity` IPC pattern at
      [`apps/desktop/src/main/ipc/runtime-identity.ts`](apps/desktop/src/main/ipc/runtime-identity.ts)
      but **register in production**, not just dev), copyright string, and a "Check for
      updates" button stub (wired in Phase F).
- [ ] **B8.** Update [`README.md`](README.md) to remove anything implying OSS posture:
      - Drop or rephrase "Workspace" section's framing of internal packages as if for
        external consumers
      - Remove or rewrite any "fork-friendly" phrasing
      - Add a top-of-file note: "Closed-source preview. Copyright © 2026 PwrDrvr LLC.
        Internal use only."
      - Move developer-only sections (Heap Diagnostics, Startup CPU Profiling) under a
        clearly-marked `## Developer` section so a future reader does not assume they are
        end-user docs.
- [ ] **B9.** Update root [`AGENTS.md`](AGENTS.md):
      - Add a "Release / Distribution" section pointing at this plan and the brainstorm
      - Add `release` to the list of accepted PR scopes (alongside `messaging`, `desktop`,
        `agent-core`, `docs`, `tests`)
- [ ] **B10.** Append a "Release notes" line to [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)
      flagging the bundle-ID change side effect: existing dev-mode `safeStorage`-encrypted
      messaging tokens (Telegram/Discord) WILL fail to decrypt after the first signed
      build because macOS Keychain entries are keyed by signing identity. The store
      returns `undefined` gracefully and the user is prompted to re-enter — but this is a
      one-time UX bump worth documenting in the v1.0 release notes.

**Acceptance:** `pnpm typecheck` passes; running `pnpm dev` shows the new About panel
with the PwrDrvr LLC copyright; Settings → About shows the right version.

#### Phase C — Build Configuration (parallel with A; depends on B5)

**Owner:** code. **Dependencies:** B5 (so the embedded version comes from `app.getVersion()`).
**Estimated effort:** 1–2 days.

- [ ] **C1.** `pnpm --filter @pwragent/desktop add -D electron-builder@latest`
- [ ] **C2.** `pnpm --filter @pwragent/desktop add electron-updater@latest` (production
      dep — needed at runtime in Phase F).
- [ ] **C3.** Create [`apps/desktop/electron-builder.yml`](apps/desktop/electron-builder.yml)
      with the full configuration in §Architecture above.
- [ ] **C4.** Create [`apps/desktop/build/entitlements.mac.plist`](apps/desktop/build/entitlements.mac.plist)
      with the minimal entitlement set (`allow-jit` + `allow-unsigned-executable-memory`).
- [ ] **C5.** Create [`apps/desktop/build/icon.icns`](apps/desktop/build/icon.icns) from a
      1024×1024 source PNG (use `iconutil -c icns iconset.iconset` from the source `.png`
      tree). If a final brand icon is not ready, use a placeholder and flag it as a launch
      blocker.
- [ ] **C6.** Update [`apps/desktop/electron.vite.config.ts`](apps/desktop/electron.vite.config.ts)
      to add `build: { minify: "esbuild", sourcemap: false }` to all three targets (main,
      preload, renderer) — see §Architecture.
- [ ] **C7.** Add scripts to [`apps/desktop/package.json`](apps/desktop/package.json):
      - `"package:dryrun": "electron-builder --mac --arm64 --config.mac.identity=null --publish never"`
        (build a fully unsigned `.app`, useful for fast iteration during Phases C+D)
      - `"package": "electron-builder --mac --arm64 --publish never"` (signed but not
        published; relies on Phase E env vars)
      - `"release": "node ./scripts/release.mjs"` (full pipeline; Phase D + E + G)
- [ ] **C8.** Add `apps/desktop/build/` and `apps/desktop/dist/` (electron-builder's
      output dir) to [`.gitignore`](.gitignore) with the exception of files we commit
      (`build/icon.icns`, `build/entitlements.mac.plist`, `build/dmg-background.png` if
      added).

**Acceptance:** `pnpm --filter @pwragent/desktop package:dryrun` produces a `.app` under
`apps/desktop/dist/mac-arm64/PwrAgent.app` that:
- Has `Info.plist` `CFBundleName: PwrAgent`, `CFBundleIdentifier: com.pwrdrvr.pwragent`,
  `NSHumanReadableCopyright: Copyright © 2026 PwrDrvr LLC. All rights reserved.`
- Has helper bundles named `PwrAgent Helper`, `PwrAgent Helper (Renderer)`,
  `PwrAgent Helper (GPU)`, `PwrAgent Helper (Plugin)`
- Launches and renders the UI when right-clicked → Open (signing not yet wired)

#### Phase D — pnpm + ASAR Compatibility (parallel with A; depends on C)

**Owner:** code. **Dependencies:** C1, C3, C7. **Estimated effort:** 1 day, but with high
risk of debugging the pnpm symlink graph.

- [ ] **D1.** Implement [`apps/desktop/scripts/release.mjs`](apps/desktop/scripts/release.mjs)
      with the orchestration described in §pnpm + ASAR Strategy.
- [ ] **D2.** Add a `package` smoke test that boots the packaged `.app` headlessly (or
      using the existing Playwright e2e harness pointed at the packaged binary instead of
      the dev binary) and confirms the app reaches first-paint without throwing.
- [ ] **D3.** Inspect the produced ASAR with `npx asar list dist/mac-arm64/PwrAgent.app/Contents/Resources/app.asar`
      and confirm:
      - `out/main/index.js` is present
      - `node_modules/electron-log/` and other prod deps are present (not just symlinks)
      - No `.ts`, `.test.ts`, or `__tests__` directories leaked in
      - No source maps (per Phase C minify config)

**Acceptance:** the unsigned `.app` produced by `package:dryrun` launches successfully on
the dev Mac and renders the PwrAgent UI end-to-end (composer, sidebar, settings).

#### Phase E — Sign + Notarize End-to-End Locally (gated on A complete)

**Owner:** code + manual. **Dependencies:** Phase A complete (Developer ID + ASC API key
in Keychain / available as env). **Estimated effort:** 0.5–1 day, mostly waiting on
notarization.

- [ ] **E1.** Import `.p12` into the dev Mac's Keychain (one-time). Confirm
      `security find-identity -v -p codesigning` shows the LLC identity.
- [ ] **E2.** Set notarization env (use a `.envrc.release` file gitignored, sourced
      manually):
      ```bash
      export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
      export APPLE_API_KEY_ID=XXXXXXXXXX
      export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
      export APPLE_TEAM_ID=YOURTEAMID
      ```
- [ ] **E3.** Run `pnpm --filter @pwragent/desktop package` (signed but unpublished). Watch
      the build log for: signing each helper bundle individually, then the main `.app`,
      then submission to notarytool, the `Waiting for notarization status...` poll, and
      `stapler staple`.
- [ ] **E4.** Verify the produced `.app`:
      - `codesign -dv --verbose=4 dist/mac-arm64/PwrAgent.app` reports
        `Authority=Developer ID Application: PwrDrvr LLC (TEAMID)`
      - `spctl -a -vv dist/mac-arm64/PwrAgent.app` reports
        `accepted, source=Notarized Developer ID`
      - `stapler validate dist/mac-arm64/PwrAgent.app` reports
        `The validate action worked!`
- [ ] **E5.** Mount the `.dmg`, drag PwrAgent to Applications, **fully quit** the dev
      instance, and double-click to launch. Confirm:
      - One-time `"PwrAgent is an app downloaded from the Internet. Are you sure you want
        to open it?"` dialog with an **Open** button (not "Cannot be opened…" — that
        means notarization or stapling failed).
      - First-launch over a network-disconnected Mac (turn off Wi-Fi) succeeds — proves
        the staple worked.
      - Activity Monitor shows `PwrAgent`, `PwrAgent Helper (Renderer)`,
        `PwrAgent Helper (GPU)` — **no** `Electron Helper`. (Origin success criterion.)
      - About PwrAgent menu shows `Copyright © 2026 PwrDrvr LLC. All rights reserved.`
        and the correct version.
- [ ] **E6.** Save the notarization submission ID; if anything goes wrong run
      `xcrun notarytool log <submission-id> --key ...` to fetch the JSON failure log.

**Acceptance:** all checks in E4 + E5 pass. This is the **origin success criterion gate**.

#### Phase F — Auto-Update Wiring (gated on E)

**Owner:** code. **Dependencies:** E5 (the produced binary must already be signed +
notarized, because Squirrel.Mac validates the new binary's Developer ID before swapping).
**Estimated effort:** 1–2 days including end-to-end test.

- [ ] **F1.** Add `electron-updater` initialization to a new
      [`apps/desktop/src/main/auto-updater.ts`](apps/desktop/src/main/auto-updater.ts).
      Skeleton:
      ```ts
      import { autoUpdater } from "electron-updater";
      import { getMainLogger } from "./log";

      const log = getMainLogger("pwragent:updater");

      export function initAutoUpdater(): void {
        if (process.env.NODE_ENV !== "production") return;
        autoUpdater.logger = log;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        // Phase 1: rely on process.env.GH_TOKEN at runtime (no baked token)
        autoUpdater.on("error", (err) => log.error("auto-update error", { err: err.message }));
        autoUpdater.on("update-available", (info) => log.info("update-available", { version: info.version }));
        autoUpdater.on("update-downloaded", (info) => log.info("update-downloaded", { version: info.version }));
        autoUpdater.checkForUpdatesAndNotify().catch((err) =>
          log.warn("checkForUpdatesAndNotify failed", { err: err.message }),
        );
      }
      ```
- [ ] **F2.** Call `initAutoUpdater()` from `bootstrapApp()` in
      [`apps/desktop/src/main/index.ts`](apps/desktop/src/main/index.ts) inside the
      `app.whenReady().then(...)` block. Place it **after** window creation so a slow
      update check does not delay first paint.
- [ ] **F3.** Wire the Settings → About "Check for updates" button (B7) to a new IPC
      channel that calls `autoUpdater.checkForUpdates()` and reports back update status.
      Surface user-facing states: "You're up to date", "Update available — downloading…",
      "Update ready — restart to install".
- [ ] **F4.** Document the Phase 1 token-injection runbook in
      [`docs/desktop-release-runbook.md`](docs/desktop-release-runbook.md):
      ```bash
      # Solo Phase 1 launch — set GH_TOKEN before opening the app
      export GH_TOKEN=ghp_fine_grained_pat_here
      open /Applications/PwrAgent.app
      ```
      Plus a `LaunchAgent` plist alternative for users who don't want to launch via
      Terminal.
- [ ] **F5.** End-to-end smoke test:
      1. Bump version to `0.2.0` in
         [`apps/desktop/package.json`](apps/desktop/package.json), tag and run
         `pnpm release` locally → publishes to `pwrdrvr/PwrAgent` releases.
      2. Install the `.dmg` to `/Applications`, launch with `GH_TOKEN` set.
      3. Bump to `0.2.1`, run `pnpm release` again.
      4. Re-launch the installed `0.2.0` and confirm it detects the update, downloads,
         and applies on next quit.

**Acceptance:** F5 round-trip succeeds. Origin §Success Criteria item: "Publishing v1.0.1
over an installed v1.0.0 results in the running app detecting the update via the
configured feed, downloading it, and applying it on next restart with no user-visible
re-signing or re-quarantine prompt."

#### Phase G — CI Release Pipeline (gated on F locally working)

**Owner:** code + CI. **Dependencies:** F5 working from a local Mac. **Estimated effort:**
1 day.

- [ ] **G1.** Create [`.github/workflows/release.yml`](.github/workflows/release.yml):
      ```yaml
      name: Release Desktop (macOS arm64)
      on:
        push:
          tags: ["v*.*.*"]
      jobs:
        release:
          runs-on: macos-14    # Apple Silicon; matches Phase A signing identity
          timeout-minutes: 45
          steps:
            - uses: actions/checkout@v4
            - uses: pwrdrvr/configure-nodejs@v1
            - run: pnpm install --frozen-lockfile
            - run: pnpm --filter @pwragent/desktop typecheck
            - run: pnpm test
            - run: pnpm --filter @pwragent/desktop release
              env:
                CSC_LINK: ${{ secrets.CSC_LINK }}
                CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
                APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
                APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
                APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
                APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
                GH_TOKEN: ${{ secrets.RELEASES_PAT }}    # for publishing
      ```
- [ ] **G2.** In GitHub repo Settings → Secrets and Variables → Actions, add the seven
      secrets referenced above. `CSC_LINK` is the `.p12` base64-encoded; `APPLE_API_KEY`
      is the `.p8` either as a base64 secret + a workflow step that writes it to a temp
      file, or as a raw secret consumed via process substitution in the release script.
- [ ] **G3.** Adjust [`apps/desktop/scripts/release.mjs`](apps/desktop/scripts/release.mjs)
      to handle base64-encoded `APPLE_API_KEY` if needed (decode to a temp `.p8` file
      before invoking electron-builder).
- [ ] **G4.** Cut a `v0.2.0` tag against this branch, push, and verify the workflow:
      builds, signs, notarizes, staples, publishes to `pwrdrvr/PwrAgent` releases. Cycle
      time target: ≤ 12 minutes.
- [ ] **G5.** Document the release ritual in
      [`docs/desktop-release-runbook.md`](docs/desktop-release-runbook.md):
      ```bash
      # Cut a release
      pnpm --filter @pwragent/desktop version patch    # bump and commit
      git push --follow-tags                          # push commit + tag
      # Watch GH Actions → Release Desktop (macOS arm64)
      ```

**Acceptance:** `git push --follow-tags` triggers an end-to-end signed/notarized release
with no human signing intervention. Origin success criterion: "Cutting a release is a
single, repeatable operation."

#### Phase H — Phase 1 → 2 Migration Prep (no code changes; runbook + decision deadline)

**Owner:** human. **Dependencies:** F5 working. **Estimated effort:** 0.5 day to write the
runbook; the actual migration is a future task.

- [ ] **H1.** Write [`docs/desktop-distribution-phase-2-runbook.md`](docs/desktop-distribution-phase-2-runbook.md)
      covering each of the three Phase 2 channel options, with the exact
      `electron-builder.yml` `publish:` block change for each:
      - **Open-source the source repo**: change nothing in `publish:`; the existing
        `provider: github, owner: pwrdrvr, repo: PwrAgent, private: false` flips when the
        repo's visibility flips. Drop the `GH_TOKEN` requirement at runtime.
      - **Public release repo**: create `pwrdrvr/PwrAgent-Releases` (or similar); change
        `repo: PwrAgent-Releases, private: false`. Mirror the existing v0.x.0 releases
        into it via `gh release` so existing installs keep finding the feed.
      - **Generic provider on R2/CloudFront**: provision the bucket + worker; change
        `publish:` to `provider: generic, url: https://updates.pwragent.com/${channel}`.
        Set up a "bridge release" mechanism (one final release pushed to **both** old and
        new channels) so existing installs find the new feed once.
- [ ] **H2.** Document the **decision deadline**: "Phase 2 channel must be chosen and
      migrated before any external test user is onboarded." Add this as an explicit
      checklist gate in the desktop release runbook.
- [ ] **H3.** Optionally add a runtime feed-URL override to the production binary (env
      var `PWRAGNT_UPDATE_URL`) so a future "bridge release" can point existing installs
      at a new feed without rebuilding. Low cost, high optionality. Mark as defer-if-busy.

**Acceptance:** runbook exists; the team (currently: you) knows what to do when the time
comes.

## Alternative Approaches Considered

- **`@electron/forge` instead of `electron-builder`** — narrower delta in 2026 than
  reputation suggests (Forge auto-enables ASAR-integrity fuses; both use `@electron/notarize`
  + notarytool under the hood). Rejected because (a) electron-builder's `publish: github`
  + `private: true` is a single-line config; Forge requires wiring `@electron-forge/publisher-github`
  separately, (b) electron-vite's templates and docs default to builder, (c) builder's DMG
  customization is more mature, (d) the team has zero existing Forge investment, so any
  switching cost has no offsetting payoff.
- **Bake the `GH_TOKEN` into the Phase 1 binary** — explicitly recommended against by 2026
  best-practice findings; baked tokens are recoverable from the ASAR. The plan honors the
  origin doc's auto-update intent but reads the token from `process.env` instead, costing
  ~1 minute of one-time launch ergonomics for a solo developer in exchange for not
  introducing a security debt that must be unwound at Phase 2.
- **Skip auto-update entirely for Phase 1** — would simplify the plan but breaks the
  origin doc's R8. The chosen approach (env-var token + auto-update) is the smallest
  deviation from the brainstorm that respects 2026 security norms.
- **Universal arm64+x64 binary at v1.0** — explicitly rejected in the origin doc. Plan
  preserves a clean future migration path (one-line change to `arch: [universal]` or
  `arch: [arm64, x64]`).
- **Self-host on S3/R2 with the `generic` provider for Phase 1** — viable, but requires
  provisioning a bucket + signed-URL infra before any release. Defers to Phase 2 where the
  cost is justified by external users; Phase 1's "you are the only consumer" makes it
  unnecessary upfront.

## System-Wide Impact

### Interaction Graph

The release pipeline triggers a chain that crosses several systems and requires no
runtime change in user-facing code paths *except* for the auto-updater initialization:

```
git push --follow-tags
  → GitHub Actions (release.yml on macos-14)
    → pnpm install + typecheck + test
    → pnpm --filter @pwragent/desktop release  (apps/desktop/scripts/release.mjs)
      → electron-vite build (out/main, out/preload, out/renderer)
      → pnpm deploy --filter @pwragent/desktop --prod  (flat node_modules in stage dir)
      → electron-builder --mac --arm64 --publish always
        → @electron/osx-sign  (sign main + each helper bundle individually with PwrDrvr LLC cert)
        → @electron/notarize  (xcrun notarytool submit + wait + staple)
        → DMG and ZIP packaging
        → @electron/publisher-github  (upload artifacts + latest-mac.yml to private repo release)
  → User's installed PwrAgent.app
    → electron-updater.checkForUpdatesAndNotify()
      → GitHub REST API: GET /repos/pwrdrvr/PwrAgent/releases/latest (Authorization: token <GH_TOKEN>)
      → fetch latest-mac.yml + ZIP
      → Squirrel.Mac validates the ZIP's Developer ID matches the running app's
      → quitAndInstall on next user-initiated quit
```

Two cross-layer surprises this surfaces, each addressed in a numbered task:

1. **Squirrel.Mac validates the new binary's Developer ID matches the running app's.**
   This is why every release must use the **same** `Developer ID Application: PwrDrvr LLC`
   identity once the first signed binary ships. Switching identities forces every user to
   re-install through the DMG. Documented as an implicit constraint in Phase A6 (cert
   custody is forever-sensitive).
2. **The version reported to the Codex App Server** is independent of the version baked
   into the binary by electron-builder. Without the [`client.ts:4251`](apps/desktop/src/main/codex-app-server/client.ts:4251)
   fix (Phase B5) every shipped version will identify itself as `0.1.0` to the upstream
   server — a breakage that would be invisible to most testing because the version field
   is not surfaced in the UI. SpecFlow-style cross-layer issue caught during repo
   research; tracked as a hard requirement.

### Error & Failure Propagation

- **Notarization failure** (most likely: missing entitlements on a helper bundle, or a
  helper signed without `--options runtime`). `@electron/notarize` raises and
  electron-builder exits non-zero. The CI workflow fails loudly. Recovery: fetch the JSON
  log via `xcrun notarytool log <submission-id>` and address the specific failure.
- **`stapler staple` failure** (intermittent Apple infrastructure). Builder exits
  non-zero. Recovery: re-run the workflow; the `.app` is already notarized so notarytool
  is fast on retry.
- **`electron-updater` fetch failure** (network, expired `GH_TOKEN`, rate limit). Logged
  via `electron-log` (already in use); the user does not see a popup unless we add one.
  The Settings → About "Check for updates" button (Phase F3) is the user-visible escape
  hatch. Failure to update is silent and graceful — the running app continues to work.
- **Squirrel.Mac apply failure** (rare; usually a permissions issue if the app was
  installed somewhere unwritable). The app keeps running on the old version; user can
  drag the new DMG manually. Mitigation: install to `/Applications` (writable by the
  user), not `/Applications/Utilities` or a system path.

### State Lifecycle Risks

- **`safeStorage`-encrypted Telegram/Discord tokens become unreadable after the first
  signed build.** The bundle ID (`com.pwrdrvr.pwragent`) and signing identity (PwrDrvr LLC)
  combination is what macOS Keychain uses to scope `safeStorage`'s symmetric key. Existing
  dev-mode encrypted tokens at `~/.local/state/pwragent/settings-secrets.json` will fail to
  decrypt. The store at
  [`apps/desktop/src/main/settings/desktop-secret-store.ts`](apps/desktop/src/main/settings/desktop-secret-store.ts)
  returns `undefined` on decrypt failure; the user is prompted to re-enter the bot tokens
  in Settings. **Documented in Phase B10 release notes.** Not a code change required.
- **Auto-update state**: electron-updater stores download state in
  `app.getPath("userData")`, which is the **default** Electron userData dir
  (`~/Library/Application Support/PwrAgent`). PwrAgent's primary state is at
  `~/.local/state/pwragent/` (XDG-style, see
  [`desktop-state-root.ts:20`](apps/desktop/src/main/app-server/desktop-state-root.ts:20)),
  so the two are independent. No conflict. But: the productName change creates the
  Application Support dir for the first time on a signed install — fresh. No legacy
  state migration needed.
- **Bridge-release migration risk** (Phase H): if Phase 2 changes the publish provider,
  installed Phase-1 binaries will keep checking the old feed forever unless a "bridge"
  release ships pointing at the new feed. For solo Phase 1 this is irrelevant (you can
  re-install). For Phase 2's first user-facing release, a runtime override env var
  `PWRAGNT_UPDATE_URL` (Phase H3) is the cheap insurance.

### API Surface Parity

This plan does not introduce new user-facing APIs; the changes are pipeline + branding +
auto-update plumbing. No agent-tool parity concerns (per the agent-native review pattern,
the user-visible surfaces here — version display, "Check for updates", About panel — are
information surfaces that an agent could equivalently inspect via existing IPC channels;
no agent-side gap).

### Integration Test Scenarios

These scenarios cannot be caught by unit tests with mocks; they require building the
actual signed artifact:

1. **Fresh install on a fresh Apple Silicon Mac with internet**: download `.dmg`, drag,
   double-click. Expect the friendly "downloaded from the Internet" dialog with an Open
   button (NOT the Sequoia "cannot be opened…" wall).
2. **Fresh install on an offline Apple Silicon Mac**: same flow, but Wi-Fi off. Expect
   the same friendly dialog — proves stapling worked.
3. **Activity Monitor smoke**: launch, open `Activity Monitor`, filter by "PwrAgent".
   Expect exactly the four processes (`PwrAgent`, `PwrAgent Helper (Renderer)`,
   `PwrAgent Helper (GPU)`, optionally `PwrAgent Helper (Plugin)` — only spawned for
   plugin features, may not appear). Expect ZERO occurrences of the string "Electron".
4. **Auto-update round-trip**: described in Phase F5.
5. **Cross-version migration of `safeStorage` secrets**: install dev build, configure
   Telegram bot token in Settings, quit, install signed v0.2.0 over it, launch. Expect
   the token to be missing (decrypt failure) and Settings to show "no token configured"
   gracefully — no crash, no stale ciphertext re-used as plaintext.

Add a CI step (`pnpm test:e2e:packaged`) that runs scenario 3 against the produced
artifact via Playwright pointed at the packaged binary — catches the "still says Electron
Helper" regression automatically.

## Acceptance Criteria

### Functional Requirements

- [ ] [R1] All four helper processes are renamed `PwrAgent Helper (...)` in Activity
      Monitor; no "Electron" string appears.
- [ ] [R1] App display name in Dock, Menu bar, About panel, and window title is "PwrAgent".
- [ ] [R2] `defaults read /Applications/PwrAgent.app/Contents/Info.plist CFBundleIdentifier`
      reports `com.pwrdrvr.pwragent`.
- [ ] [R3] `defaults read .../Info.plist NSHumanReadableCopyright` reports
      `Copyright © 2026 PwrDrvr LLC. All rights reserved.`
- [ ] [R3] `package.json` `author` is `PwrDrvr LLC` at root and in `apps/desktop/`.
- [ ] [R3] About panel (App menu → About PwrAgent) shows the same copyright.
- [ ] [R3] Settings → About row shows app name, version, and copyright.
- [ ] [R3] `LICENSE` file exists at repo root with proprietary boilerplate.
- [ ] [R4] `codesign -dv --verbose=4 PwrAgent.app` reports
      `Authority=Developer ID Application: PwrDrvr LLC (TEAMID)`.
- [ ] [R5] `spctl -a -vv PwrAgent.app` reports `accepted, source=Notarized Developer ID`.
- [ ] [R5] `stapler validate PwrAgent.app` succeeds.
- [ ] [R6] No App Store target is configured anywhere.
- [ ] [R7] `electron-builder.yml` `mac.target` lists only `arch: [arm64]`.
- [ ] [R7] DMG file size is in the ~80–130MB range (sanity check that universal didn't
      sneak in).
- [ ] [R8] After installing v0.2.0 and publishing v0.2.1, the v0.2.0 install detects the
      update via `electron-updater`, downloads, and applies on quit.
- [ ] [R9] `npx asar list` of the produced ASAR shows minified main + renderer code, no
      `*.test.*`, no `__tests__/`, no source maps.
- [ ] [R9] Electron fuses for ASAR integrity (`enableEmbeddedAsarIntegrityValidation`,
      `onlyLoadAppFromAsar`) are both `true` (verify with `npx @electron/fuses read`).
- [ ] [R10] `package.json` at root and `apps/desktop/` have `private: true`,
      `license: "UNLICENSED"`, and `author: "PwrDrvr LLC"`.
- [ ] [R10] No `LICENSE` file or README phrasing implies an OSS license is granted.
- [ ] [R11] No license-key, paywall, billing, or entitlement-check code is shipped.
- [ ] [R12] A single `git push --follow-tags` after a version bump produces a published,
      signed, notarized release with no human signing intervention.
- [ ] [R13] README has been rewritten to reflect proprietary, closed-source posture.

### Non-Functional Requirements

- [ ] **Performance**: signed/notarized release pipeline cycle time ≤ 15 minutes from tag
      push to artifact published.
- [ ] **First-launch UX**: on a fresh Apple Silicon Mac, the Gatekeeper dialog is the
      friendly "downloaded from the Internet…" with an Open button. **No** "cannot be
      opened" dialog.
- [ ] **Offline first-launch**: succeeds without network access (proves staple worked).
- [ ] **Security**: no `GH_TOKEN`, certificate, or `.p8` is committed to the repo. CI
      secrets are encrypted; `.p12` and `.p8` are stored in 1Password (or equivalent).
- [ ] **Auto-update security**: Phase 1 binary does not bake any token; reads `GH_TOKEN`
      from `process.env` at runtime.

### Quality Gates

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` clean (no new test failures introduced by branding changes).
- [ ] CI workflow (`.github/workflows/ci.yml`) passes on the branch before tagging.
- [ ] Local end-to-end signed/notarized build (Phase E5) verified by the human before the
      first CI tag is cut.

## Success Metrics

- **Zero Gatekeeper friction** for the first 10 test users (measured by ad-hoc feedback —
  if anyone has to right-click → Open or visit System Settings, the build is broken).
- **Helper-name cleanliness**: zero support reports about "Electron Helper" in Activity
  Monitor.
- **Release pipeline reliability**: ≥ 90% of releases between v1.0.0 and v1.5.0 succeed
  on the first CI run (notarization is the main risk; stable entitlements + signed
  helpers should drive this above 95%).
- **Update channel migration**: when Phase 2 happens, ≤ 1 hour of human work plus the
  bridge release. No installed Phase 1 user gets stranded.

## Dependencies & Prerequisites

| Dependency | Owner | Lead time | Blocks |
|---|---|---|---|
| ~~D-U-N-S number for PwrDrvr LLC~~ | — | **complete** | — |
| ~~Apple Developer Program enrollment (LLC)~~ | — | **complete** (Team ID `T44CNHC4UH`) | — |
| Developer ID Application certificate exists in Keychain | Human | minutes | E |
| App Store Connect API key (`.p8`) generated | Human | minutes | E, G |
| `iconutil`-built `icon.icns` | Designer / human | hours | C5 (placeholder ok early) |
| Marketing landing page URL for Help menu | Human | flexible | B6 (or remove menu item) |
| GitHub repo secrets configured | Human | minutes | G |

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ~~Apple enrollment takes 4–6 weeks (worst case)~~ | — | — | **Resolved: enrollment complete (Team ID `T44CNHC4UH`).** |
| pnpm symlink graph confuses electron-builder | High | High (no working bundle) | Phase D explicitly addresses; `pnpm deploy` is the standard solution. |
| Notarization fails on a helper bundle | Medium | Medium (one CI cycle lost) | Phase E5's local-first verification surfaces this before CI. Use the same entitlements file for `entitlementsInherit`. |
| Squirrel.Mac apply fails after the binary's signing identity changes | Low (we won't change identity) | High (would force every user to re-install) | Documented as a forever-constraint in Phase A6: never rotate the cert without a re-install ritual. |
| `safeStorage` keychain rebind orphans messaging tokens | Certain | Low (graceful re-prompt) | Phase B10 documents in release notes; no code mitigation needed. |
| Help menu URL pointed at private repo ships | Low (Phase B6 catches) | Low (broken link) | Phase B6 acceptance gates the build. |
| GH_TOKEN baked into binary by accident | Low | High (token leaked to anyone with the binary) | Plan explicitly chooses env-var injection; review at the PR for any `define:` block introducing `__GH_TOKEN__`. |
| ASAR integrity fuses not enabled | Medium (default is off in builder) | Low (security defense-in-depth) | Phase C3 + R9 acceptance criterion explicitly verifies. |
| `disable-library-validation` turns out to be required | Low | Low (one entitlement add + re-notarize) | Plan starts without it and adds only if Phase E5 fails specifically on library validation. |

## Resource Requirements

- **Human time**: ~5–7 working days of engineering, plus calendar wait for Phase A.
- **Spend**: $99/year Apple Developer Program. ~$0 for D-U-N-S (free via Apple's portal).
  ~$0–5/month for Phase 1 distribution (private GitHub Releases). Future Phase 2 may add
  R2/CloudFront costs (estimated ≤ $10/month at <1k MAU).
- **CI minutes**: macos-14 runners are billed at higher rate; budget ~30 minutes per
  release, ~10 releases/month = 300 min/month = within free tier on most plans.

## Future Considerations

- **Universal arm64+x64 binary**: one-line config change in
  `electron-builder.yml`'s `mac.target`. Defer until concrete demand.
- **Windows + Linux builds**: out of scope here; `electron-builder` already supports both
  with parallel sections in the same config file. Add when there is a Windows tester.
- **Mac App Store submission**: would require a separate entitlements set, sandboxing,
  and a different signing identity (Mac App Distribution + Mac Installer Distribution).
  Significant additional work; not currently planned.
- **Crash reporting / Sentry**: separate brainstorm. The current `electron-log` already
  goes to local files; remote upload is the missing piece. Adding Sentry is straightforward
  but expands the privacy/compliance surface.
- **Sourcemap upload** (when Sentry lands): renderer build will need to emit and upload
  sourcemaps separately; the current `sourcemap: false` in Phase C6 will become
  `sourcemap: 'hidden'` + a Sentry CLI step.
- **Code-source-protection** (electron-vite has a documented "source code protection"
  feature using V8 bytecode caching): low-priority because ASAR integrity already
  prevents tampering and obfuscation only delays — does not prevent — extraction.
- **`docs/solutions/` seeding**: this release is the first time PwrAgent accumulates
  Electron-shipping institutional knowledge. Strong candidate to backfill solution docs
  for: helper-bundle rebranding gotcha, the 2026 minimal entitlements set, pnpm + ASAR
  integration, and Squirrel.Mac signing-identity invariant.

## Documentation Plan

- [`docs/desktop-release-runbook.md`](docs/desktop-release-runbook.md) — how to cut a
  release (Phase G5).
- [`docs/desktop-distribution-phase-2-runbook.md`](docs/desktop-distribution-phase-2-runbook.md)
  — Phase 1 → Phase 2 migration paths (Phase H1).
- [`README.md`](README.md) — proprietary-posture rewrite (Phase B8).
- [`AGENTS.md`](AGENTS.md) — release scope, link to this plan and the brainstorm
  (Phase B9).
- [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md) — `safeStorage` rebind release
  note (Phase B10).
- (Post-release) `docs/solutions/desktop-electron-shipping-2026.md` — institutional
  knowledge backfill.

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-05-02-desktop-release-packaging-requirements.md](../brainstorms/2026-05-02-desktop-release-packaging-requirements.md)
- Key decisions carried forward: closed-source proprietary v1.0 + PwrDrvr LLC ownership;
  electron-builder over Forge; arm64-only; Phase 1 = private repo + electron-updater,
  Phase 2 deferred; no monetization scaffolding; helper-bundle rename is a success
  criterion; signing identity = LLC organization (D-U-N-S blocker).

### Internal References

- [apps/desktop/electron.vite.config.ts](apps/desktop/electron.vite.config.ts) — current
  build config; needs Phase C6 minify additions.
- [apps/desktop/src/main/index.ts:36](apps/desktop/src/main/index.ts:36) — `APP_NAME` and
  bootstrap; Phase B4 adds `setAboutPanelOptions`, Phase B6 fixes Help menu, Phase F2
  initializes auto-updater.
- [apps/desktop/src/main/codex-app-server/client.ts:4251](apps/desktop/src/main/codex-app-server/client.ts:4251) —
  hardcoded `version: "0.1.0"`; Phase B5 fix.
- [apps/desktop/src/main/app-server/desktop-state-root.ts:20](apps/desktop/src/main/app-server/desktop-state-root.ts:20) —
  XDG-style state root; explains why a productName change does not orphan user data.
- [apps/desktop/src/main/settings/desktop-secret-store.ts](apps/desktop/src/main/settings/desktop-secret-store.ts) —
  `safeStorage`-backed secret store; rebinds on signing identity change; Phase B10
  release-note item.
- [apps/desktop/src/main/ipc/runtime-identity.ts](apps/desktop/src/main/ipc/runtime-identity.ts) —
  pattern for the new "app version" IPC channel (Phase B7).
- [apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx) —
  add Settings → About row (Phase B7).
- [.github/workflows/ci.yml](.github/workflows/ci.yml) — current CI on `ubuntu-latest`;
  Phase G adds a sibling `release.yml` on `macos-14`.
- [package.json](package.json), [apps/desktop/package.json](apps/desktop/package.json) —
  metadata hygiene targets for Phase B1+B2.
- [README.md](README.md) — Phase B8 rewrite target.
- [AGENTS.md](AGENTS.md) — Phase B9 update target.

### External References

- [electron-builder Mac Options (TS source)](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/options/macOptions.ts) —
  authoritative key list including the capital `helperGPUBundleId`.
- [electron-builder Auto Update](https://www.electron.build/auto-update.html) — DMG vs ZIP
  requirement, `latest-mac.yml` schema.
- [electron-builder Configuring Electron Fuses](https://www.electron.build/tutorials/adding-electron-fuses.html) —
  ASAR integrity is opt-in.
- [@electron/notarize README](https://github.com/electron/notarize/blob/main/README.md) —
  notarytool env vars; ASC API key path.
- [Electron — ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).
- [Electron — Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).
- [Apple — allow-jit entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.allow-jit).
- [Apple — allow-unsigned-executable-memory entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-unsigned-executable-memory).
- [Apple — TN3147 Migrating to the latest notarization tool](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool).
- [Apple — Gatekeeper and runtime protection](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web).
- [Apple — D-U-N-S Number Help](https://developer.apple.com/help/account/membership/D-U-N-S/).
- [electron-vite Configuring](https://electron-vite.org/config/) — production minify
  defaults.
- [electron-builder #2314 — private repo updates](https://github.com/electron-userland/electron-builder/issues/2314).
- [electron-builder #5688 — security concerns with GH_TOKEN](https://github.com/electron-userland/electron-builder/issues/5688).
- [electron-builder #8660 — extraResources asar integrity gap](https://github.com/electron-userland/electron-builder/issues/8660).
- [electron/electron #1308 — rename "Atom Helper" on Mac](https://github.com/electron/electron/issues/1308) —
  historical context on helper-rename mechanism.
- [Protect Your GitHub Token: Proxying Private Releases for Electron Apps](https://blog.nishikanta.in/protect-your-github-token-proxying-private-releases-for-electron-apps).
- [Building an Auto-Updating Electron App with AWS S3, CloudFront, and Terraform](https://dev.to/alishah730/building-an-auto-updating-electron-app-with-aws-s3-cloudfront-and-terraform-57c).
- [GitHub Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) —
  macos-14 cost reference.

### Related Work

- [PR #149: composer drafts across navigation](https://github.com/pwrdrvr/PwrAgent/pull/149) —
  recent in-flight; unrelated but indicative of current branch hygiene.
- (none directly related to packaging — this plan introduces the entire pipeline)
