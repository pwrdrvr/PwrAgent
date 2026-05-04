---
date: 2026-05-02
topic: desktop-release-packaging
---

# Desktop Release Packaging (v1.0)

## Problem Frame

PwrAgent is preparing its first user-facing macOS release. This is a first-time Electron-app
shipment, and several first-release decisions need to be made coherently: how the binary is
branded as a PwrDrvr LLC product, how it is signed and distributed outside the App Store,
how updates reach users, and what optionality is preserved for future open-sourcing or
monetization. The work is closed-source preview today; the v1.0 release must keep that
posture while making the eventual OSS-or-paid decision a low-cost pivot rather than a
rewrite.

The phrase "eject from the default Electron runner" is a useful framing of the user goal
but is not literally what happens — Electron itself is not forked. A packager (electron-
builder) takes the stock Electron binary, renames it, swaps icons and `Info.plist`,
code-signs with the developer's certificate, and notarizes with Apple. Apps like Codex
Desktop, Linear, Slack, and VS Code all use this approach. The v1.0 work is therefore a
packaging + signing + distribution pipeline, not an Electron fork.

## Requirements

- **R1.** The shipped artifact is a branded macOS `.app` named **PwrAgent** throughout: main
  binary, every helper process, dock label, menu bar, About panel, window title, `.icns`
  icon, `Info.plist` `CFBundleName` / `CFBundleDisplayName` / `CFBundleExecutable`.
- **R2.** Bundle identifier is `com.pwrdrvr.pwragent` (reverse-DNS, owned by PwrDrvr LLC).
- **R3.** Copyright `Copyright © 2026 PwrDrvr LLC. All rights reserved.` appears in every
  surface that carries a copyright string: `Info.plist` `NSHumanReadableCopyright`, the
  About panel, `package.json` `author`, in-app About / Settings copyright row (if any),
  the DMG license slide (if any), and the EULA.
- **R4.** Binaries are code-signed with the **PwrDrvr LLC** "Developer ID Application"
  certificate. The signing identity must resolve to the LLC's Apple Developer Team ID, not
  to an individual.
- **R5.** Binaries are notarized by Apple and the notarization ticket is stapled into the
  `.app` and the `.dmg` so that first launch on a Mac with no network shows no Gatekeeper
  warning.
- **R6.** Distribution is **outside the Mac App Store**. Users download a `.dmg` (or
  `.zip` for the auto-updater) directly.
- **R7.** v1.0 ships **Apple Silicon (arm64) only**. Intel x64 is a deliberate non-goal for
  v1.0 and may be revisited if test users ask for it.
- **R8.** The app supports **auto-update** via `electron-updater`. Phase 1 (solo
  dogfooding) points the updater at the existing **private** `PwrAgent` GitHub repo using
  the `github` provider and a `GH_TOKEN` with read-only access to that repo. Phase 2 (just
  before onboarding any external test users) the distribution channel migrates to one of:
  (a) opening the source repo, (b) a separate public `pwragent-releases` repo, or (c) S3/R2
  with the `generic` provider. The Phase 2 channel choice is deferred to a later
  brainstorm/decision once test-user readiness is closer.
- **R9.** The production build is **minified and bundled** (electron-vite default Rollup +
  esbuild minification for main, preload, renderer) and packaged into an **ASAR archive**
  by electron-builder so source is not trivially extractable from the installed `.app`.
  ASAR integrity verification is enabled.
- **R10.** `package.json` metadata reflects PwrDrvr LLC ownership and proprietary status:
  `private: true` (already set at root and `apps/desktop`), `license: "UNLICENSED"`,
  `author: "PwrDrvr LLC"`, a `description` consistent with the marketing posture, and
  **no** references that imply an open-source license. No `LICENSE` file claiming OSS terms
  is added at v1.0; a short proprietary `LICENSE`/EULA file may be added if it improves the
  legal posture, but is not required for v1.0.
- **R11.** v1.0 includes **no** monetization code: no license-key field, no paywall, no
  entitlement check, no third-party billing integration. Account / identity / settings
  boundaries are kept clean enough that adding a paid tier later is a feature add, not a
  rewrite. (See *Key Decisions* for the carrying-cost rationale.)
- **R12.** Cutting a release is a **single, repeatable operation** — one command (or one
  CI workflow trigger) that builds, signs, notarizes, staples, generates the update feed
  (`latest-mac.yml`), and publishes the release artifacts to the configured channel.
- **R13.** README and any other public-facing repo metadata are updated so they do not
  contradict the proprietary, PwrDrvr-LLC-owned posture (no implicit OSS framing,
  contributor license claims, or "feel free to fork" language).

## Success Criteria

- A user with no prior PwrAgent install double-clicks the v1.0 `.dmg` on a fresh Apple
  Silicon Mac with internet, drags PwrAgent to Applications, and launches with **no
  Gatekeeper warning, no right-click bypass, no quarantine prompt**.
- `codesign -dv --verbose=4 /Applications/PwrAgent.app` reports the Team Identifier and
  Authority chain belonging to **PwrDrvr LLC**.
- `spctl -a -vv /Applications/PwrAgent.app` reports `accepted, source=Notarized Developer
  ID`.
- Right-click → Get Info on the installed `.app` shows the `Copyright © 2026 PwrDrvr LLC`
  string from `NSHumanReadableCopyright`.
- The PwrAgent → About menu (and any in-app About surface) shows the same copyright and the
  PwrAgent product name; no "Electron" string is visible in user-facing UI.
- Activity Monitor shows process names like `PwrAgent`, `PwrAgent Helper (Renderer)`,
  `PwrAgent Helper (GPU)`, etc. — never `Electron Helper`.
- Publishing v1.0.1 over an installed v1.0.0 results in the running app detecting the
  update via the configured feed, downloading it, and applying it on next restart with no
  user-visible re-signing or re-quarantine prompt.
- `apps/desktop/out/<asar>` is the only place renderer/main JS lives in the installed
  `.app`; raw uncompressed source files are not present.

## Scope Boundaries

- **No Windows or Linux builds** in v1.0. Build configuration may be left scaffolded so
  these are easy to add later, but no signing, testing, or release of those targets in
  this scope.
- **No Mac App Store** target. App Store distribution requires sandboxing, additional
  entitlement constraints, and a separate signing flow that is explicitly deferred.
- **No Intel (x64)** binary at v1.0.
- **No license-key, paywall, entitlement, or billing** code in v1.0.
- **No telemetry / analytics / crash reporting work** beyond what the project already has
  via `electron-log`. Adding crash reporting (Sentry / electron's `crashReporter` upload)
  is a separate brainstorm.
- **No CI infrastructure overhaul** outside what is required to make releases reproducible
  and signable. Decisions about *where* the release runs (local machine vs GitHub Actions
  macOS runner) are deferred to planning.
- **No proprietary EULA drafting** at the brainstorm level. If a `LICENSE`/EULA file is
  produced, the wording is a planning/legal task, not a brainstorm decision.

## Key Decisions

- **Packager = `electron-builder`.** Chosen over `@electron/forge` because (a) it has the
  more battle-tested macOS signing + notarization integration in 2026, (b) it integrates
  cleanly with `electron-vite` (already in use), (c) `electron-updater` is from the same
  project, so the build → publish → update path is one cohesive system. Forge is closing
  the gap, but builder is the lower-risk choice for a first-time Electron shipper.
- **Signing identity = PwrDrvr LLC organization Developer ID.** Aligns with the user's
  stated goal that legal liability lives with the LLC, not the individual. Cost is
  $99/year + a one-time D-U-N-S lookup for the LLC. Lead time on D-U-N-S (typically
  several business days) is a hard prerequisite that should be started immediately —
  before any other release work — because nothing else can be signed until enrollment is
  approved. A personal Developer ID is rejected because re-signing later would force every
  installed user to re-install through a Gatekeeper warning.
- **Phase 1 distribution = existing private `PwrAgent` repo.** No second repo or S3 bucket
  is provisioned today. The user is the only consumer; `electron-updater`'s `github`
  provider with a `GH_TOKEN` works against private repos. Phase 2 channel is deferred.
- **Architecture = arm64 only.** Saves ~50% on download size, matches the actual test
  surface ("Mac-isms tested on Apple Silicon"), and avoids Rosetta-related edge cases. An
  Intel build can be added later as a demand-driven follow-up; the user's choice was
  explicitly framed as "Apple Silicon only for v1.0, add Intel later if users ask."
- **License posture = `UNLICENSED` + `private: true`.** Closed-source proprietary today,
  reversible later. Avoids picking an OSS license under time pressure and preserves all
  options (MIT/Apache, source-available BSL/Elastic/FSL, or never opening).
- **No monetization scaffolding now.** YAGNI on license-key plumbing. Architectural
  hygiene around accounts, identity, and feature gating is the actual constraint — a paid
  tier later is then a normal feature, not a refactor of v1.0 semantics.
- **Branding extends to all helper processes.** A common shipping mistake is renaming the
  main `.app` while leaving Activity Monitor showing `Electron Helper (Renderer)`.
  electron-builder handles this via `mac.helperBundleId` / `mac.helperRendererBundleId` /
  `mac.helperGpuBundleId` plus icon overrides. Catching this at brainstorm time so it is
  in the success criteria, not a launch-eve scramble.

## Dependencies / Assumptions

- **D-U-N-S number for PwrDrvr LLC** is the long-lead-time prerequisite. Without it the
  Apple Developer Program enrollment cannot be completed under the LLC. Free via Dun &
  Bradstreet's Apple-specific lookup (`dnb.com/duns-number/lookup` Apple variant);
  typically issued in a few business days.
- **Apple Developer Program enrollment** for PwrDrvr LLC ($99/year) must be active before
  any signing or notarization is possible.
- **Notarization credentials** — either an Apple ID with an app-specific password, or an
  App Store Connect API key issued for the LLC's developer team — are required for
  `notarytool`.
- v1.0 assumes the existing `electron-vite` build pipeline is sound; no requirement to
  switch bundlers.
- v1.0 assumes a single signing machine (developer's Mac or one CI runner) is sufficient.
  No multi-host signing orchestration is in scope.

## Outstanding Questions

### Resolve Before Planning

(none — all product-shaping decisions are made; remaining items are technical/research
questions appropriately answered during planning)

### Deferred to Planning

- [Affects R12][Technical] Where does the release pipeline run — developer's Mac, GitHub
  Actions macOS runner, or both? Trade-off is between signing-cert custody simplicity
  (local Mac, Keychain) and reproducibility / automation (CI runner, p12 + secrets).
- [Affects R4][Technical] How is the Developer ID certificate + private key stored for
  repeatable builds: Keychain on the dev Mac only, exported `.p12` checked into a secrets
  store, or App Store Connect API key for `notarytool` plus a CI-imported cert? Will be
  decided during planning based on the answer to the previous question.
- [Affects R8][Needs research] Confirm 2026 `electron-updater` behavior for the `github`
  provider against a **private** repo: does it correctly handle a `GH_TOKEN` baked into
  the build, what scopes does the token need (read-only on the single repo), and what is
  the rotation story when the token expires? Best-practice may be a fine-grained PAT
  scoped to read-only on contents of `PwrAgent` only.
- [Affects R8][Technical] Phase 1 → Phase 2 migration mechanics: does the v1.0 build need
  any runtime update-feed override capability, or is shipping a "bridge release" pointed
  at the new feed sufficient? (For solo-only Phase 1, fresh-install on Phase 2 is fine; the
  question matters more if external testers join during Phase 1.)
- [Affects R3][Technical] Concrete inventory of every surface that needs the
  `Copyright © 2026 PwrDrvr LLC` string updated: `Info.plist` `NSHumanReadableCopyright`,
  `package.json` `author`/`description`, README, About panel / Settings → About row,
  splash if present, EULA, and any source-file headers if the project decides to add them
  (it currently does not).
- [Affects R9][Technical] Bundling depth beyond defaults: confirm electron-vite's default
  Terser settings are acceptable, ASAR integrity is on, and `node_modules` is correctly
  pruned to production deps before packaging. Decide whether basic obfuscation (mangling
  identifiers further) is worth the debugging cost for a closed-source preview.
- [Affects R5][Technical] Hardened Runtime + entitlements wiring: notarization requires
  the Hardened Runtime, and the project may need entitlements like
  `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory` for V8 / Electron
  to function. The exact entitlement set should be derived from the runtime features the
  app actually uses (e.g., child_process spawns of the Codex app server, dynamically
  loaded modules) during planning.
- [Affects R12][Technical] DMG layout: background image, `Applications` shortcut
  placement, and whether to ship a CDN/ICNS pair. Cosmetic but worth doing once cleanly.
- [Affects R13][Technical] README rewrite scope: which sections (Getting Started,
  Workspace, etc.) need to be reframed for a proprietary product, vs which are
  developer-only and can stay as-is for the private repo.

## Next Steps

→ `/ce:plan` for structured implementation planning. The brainstorm has no blocking
product decisions remaining; the deferred questions above are technical/research items
that planning is the right place to resolve.
