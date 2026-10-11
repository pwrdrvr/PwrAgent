# PwrAgent on your phone

A personal remote for all threads across your PwrAgent machines. Expo SDK 55 /
React Native 0.83 targets the installed Xcode 26.2 toolchain. Android shares the
UI, persistent outbox and WebRTC implementation; its native build is not yet
verified. See [architecture](../../docs/mobile-architecture.md).

## Local development

From this checkout, install with `pnpm install`. Keep each worktree's dependencies
separate. Then:

```sh
pnpm --filter @pwragent/mobile exec expo prebuild --platform ios --no-install
cd apps/mobile/ios
pod install
cd ../../..
pnpm --filter @pwragent/mobile ios --device
pnpm --filter @pwragent/mobile start
```

The iOS config selects PwrDrvr LLC (`T44CNHC4UH`) for
`com.pwrdrvr.pwragent.mobile`. Sign in to Xcode with a company team member that
has Certificates, Identifiers & Profiles access. Do not substitute another installed app's bundle ID.
The iPhone needs Developer Mode, a trusted/paired connection to Xcode, and a
provisioning profile that includes the phone and this bundle. No new account or
App Store submission is part of this workflow.

The development launcher connects to Metro over LAN. Open the local development
server once; edits use Fast Refresh and restarting reloads the current bundle.
Native dependency changes need prebuild and a new native build. A Release build
bundles JavaScript and works away from Metro:

```sh
pnpm --filter @pwragent/mobile exec expo run:ios --configuration Release --device
```

The retired hosted CodePush service is not used. Production OTA updates are not
configured. Keep future distribution and update-policy decisions separate from
local development.

## Gateway configuration for contributors

The listener is off by default. In the gateway profile directory, create
`mobile-gateway.json` with `host`, `port`, `tlsCertificate` and `tlsKey` (absolute
paths). Example with invented paths:

```json
{"host":"0.0.0.0","port":9443,"tlsCertificate":"/path/to/trusted/fullchain.pem","tlsKey":"/path/to/private/key.pem"}
```

Use a certificate the phone already trusts. There is no HTTP or unverified-TLS
fallback. This listener runs in the existing gateway process, reusing Federation
and authenticated Codex App Server. No tunnel is provisioned automatically.

Pairing records live in `state/mobile-devices.json` under that profile. Pairing
codes expire after ten minutes and can be used once. Credentials are stored only
as hashes on the gateway and in secure storage on the phone. Grants have read,
send and voice scopes and an explicit machine list or `all`. Live needs all three
scopes and `all`, because its director tools reach all machines.

From the repository root, grant a phone using the gateway's profile:

```sh
PWRAGENT_PROFILE=default pnpm --filter @pwragent/desktop exec tsx scripts/mobile-devices.ts invite '{"scopes":["read","send","voice"],"machines":"all"}' /tmp/private-pairing-code
PWRAGENT_PROFILE=default pnpm --filter @pwragent/desktop exec tsx scripts/mobile-devices.ts revoke DEVICE_UUID
```

Read the private pairing-code file locally, enter it in the phone and delete it.
A `.lock` file serializes operator/gateway updates; if a writer crashes, verify
its recorded PID is gone before removing the stale lock. A busy store fails
closed rather than dropping a revocation or consuming an invite twice. Never commit pairing codes, bearer credentials or TLS keys.
Disconnecting on the phone removes its local credential; revocation on the
gateway also ends an existing socket and Live session.

## Verification

```sh
pnpm --filter @pwragent/mobile test
pnpm --filter @pwragent/mobile typecheck
pnpm test apps/desktop/src/main/__tests__/mobile-device-store.test.ts apps/desktop/src/main/__tests__/mobile-gateway.test.ts
```

`pwragent-mobile://demo` opens explicitly labeled, invented showcase data. Demo
mode never dispatches or starts voice. It is UI evidence only. TLS tests exercise
a real HTTPS/WebSocket listener using a public, test-only localhost certificate and synthetic backend.
They do not prove production Federation credentials or billed OpenAI audio.

## Build evidence and remaining setup (2026-10-11)

- Xcode 26.2 / iOS 26.2: ad-hoc signed Debug simulator build succeeded and was
  installed/launched on iPhone 17 Pro. Keychain-backed startup, demo navigation,
  machine filter, search and transcript rendering were inspected in Simulator.
- 136 focused tests passed, including real TLS/WebSocket pairing and revocation,
  actual SQLite durable service + phone outbox across lost acknowledgments and
  restart, durable steer, and existing native voice regression tests.
- Full repository lint/typechecks and desktop production build passed. iOS
  production Metro/Hermes exports for iOS and Android passed. Runtime license audit covers 33 bundled
  JavaScript packages; native pod notices and a license viewer are included.
- After the owner accepted Apple's updated agreement, an iPhone Release build
  succeeded using the existing Harold Hunt team. Its signature was verified and
  `main.jsbundle` is present, so that build does not require Metro.
- Xcode now sees the owner's PwrDrvr LLC membership with provisioning access;
  the project and Expo config select that company team. The company signing
  attempt reports no registered test devices. Connect, unlock and trust the
  iPhone with Developer Mode enabled so Xcode can register it, create the company
  development profile and install the app. The phone was unavailable to the Mac
  during verification. No account enrollment or store action was performed.
- Production gateway pairing/Federation from the phone, billed Live audio/tool
  execution, and an Android native build remain unverified. Live is implemented
  against the existing Codex realtime backend, with mocked signaling/lifecycle
  verification; it is not a fake audio demo.

Regenerate mobile notices after dependency changes: export an iOS production
bundle with `expo export --platform ios --source-maps`, run
`node apps/mobile/scripts/licenses.mjs <exported-map>` from the repository root
(after `pod install`), and rebuild so the new notices are bundled. The generator
checks the existing license allowlist, retains upstream license texts and native
pod acknowledgments, and fails on missing license text. Run
`pnpm --filter @pwragent/mobile licenses:check` to audit the retained metadata.
Expo's monorepo license is retained from its `sdk-55` branch for packages whose
npm tarballs omit the license file. Android notices must be audited before its
first distribution.
