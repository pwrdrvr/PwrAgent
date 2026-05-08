---
title: "feat(messaging): finish Mattermost adapter — Settings UI, Keychain, connection test"
type: feat
status: active
date: 2026-05-07
---

# Finish the Mattermost adapter — Settings UI, Keychain, connection test, Mattermost-specific toggles

## Overview

PR #199 ([feat/messaging-mattermost-adapter](https://github.com/pwrdrvr/PwrAgent/pull/199)) shipped the Mattermost adapter end-to-end at the runtime layer: capability profile, callback server, slash-command registration, response_url workaround for v10.x thread context, `@<bot>` text-mention dispatch, conversation-title hygiene, echo-loop dedup, etc. What remains for a *complete* messaging-platform addition — the bar set by the existing Discord and Telegram providers — is the **desktop integration surface**: TOML-backed settings, Keychain-stored secrets, env-var override coexistence, a Settings UI section, a connection-test button, and Mattermost-specific toggles for slash-command registration + prefix.

This plan finishes that work. It also adds two pieces unique to Mattermost (no precedent in Discord/Telegram): a **`registerSlashCommands` toggle defaulted off** with a clear UX rationale, and a **`slashCommandPrefix` field** wired to the existing namespace mechanism. And it lands the long-deferred Settings-UI pieces called out in [`apps/desktop/src/main/messaging/messaging-config.ts:247`](../apps/desktop/src/main/messaging/messaging-config.ts) (`// Mattermost is env-only today (no Settings UI yet — tracked in #195).`) and the four other code/doc references to issue [#195](https://github.com/pwrdrvr/PwrAgent/issues/195).

After this lands, **PR #199 becomes the canonical example of "what it takes to add a new messaging platform end-to-end"** — and we cite that PR number prominently in [`docs/messaging-adding-a-provider.md`](../messaging-adding-a-provider.md) so future provider authors can find it.

## Problem Statement

Three concrete problems block the merge of PR #199:

1. **Mattermost is env-var-only.** No Settings UI section. Operators must set `PWRAGENT_MESSAGING_MATTERMOST_*` env vars to configure the bot. Discord and Telegram both have full Settings sections with Keychain-backed bot tokens. New users can't configure Mattermost from the UI; existing testers can't migrate from `op:dev` env-injection to a stable Settings configuration.
2. **No connection test for Mattermost.** PR #211 (commit `1c8089dd`) added a "Test connection" affordance to Telegram and Discord settings via `validate-credentials.ts` + `MessagingRuntime.requestCredentialValidation` + `<SettingsTestBlock>` + `credential-tester.ts`. Mattermost is missing all four pieces — no way to validate the bot token + server URL pair without sending a test message.
3. **Slash commands are registered unconditionally and the user-facing thread-routing story is fragile on v10.x.** The response_url workaround we shipped works, but it carries operational complexity (post-id recovery via `getPostsSince`, attribution-via-`username`-override, post-id dedup against the WS echo). For a new user setting up Mattermost on v10.x for the first time, the simpler default is "don't register slash commands; use `@pwragent help` for the button-driven menu." Slash commands stay available as an opt-in for users who want native autocomplete and accept the namespace prefix to avoid colliding with built-in `/status`, `/away`, etc.

## Proposed Solution

**Mirror the Discord/Telegram precedent for everything except the two Mattermost-specific toggles, then layer those on top.**

The Settings schema, Keychain plumbing, env-var coexistence, IPC surface, connection-test architecture, and Settings UI primitives are all already in place — established by PR [#191](https://github.com/pwrdrvr/PwrAgent/pull/191)–style design alignment plus PR #211's connection-test work. The Mattermost addition fits cleanly into the existing slots:

| Layer | Existing pattern | Mattermost addition |
|---|---|---|
| TOML schema | `[messaging.discord]` block in `desktop-config.ts` | Add `[messaging.mattermost]` block |
| Snapshot type | `MessagingPlatformSettingsSnapshot.discord` in `packages/shared/src/contracts/settings.ts` | Add `mattermost` field with the seven existing config fields + two Mattermost-specific |
| Patch type | `messaging.discord` in `DesktopConfigPatch` | Add `messaging.mattermost` patch shape |
| Secret enum | `discordBotToken \| telegramBotToken \| ...` | Add `mattermostBotToken`, `mattermostHmacSecret` |
| Service resolver | `resolveDiscordBotTokenSync()` | Add `resolveMattermostBotTokenSync()`, `resolveMattermostHmacSecretSync()` |
| Runtime config | `loadDesktopMessagingConfigFromSettings` Discord branch | Replace the env-only pass-through with a settings+env merge |
| `validate-credentials` | Telegram's `Bot.api.getMe()`, Discord's `REST.get(Routes.user("@me"))` | Mattermost's `Client4.getMe()` + URL reachability check |
| Tester switch | `case "discord"` → `import("@pwragent/messaging-provider-discord")` | `case "mattermost"` → `import("@pwragent/messaging-provider-mattermost")` |
| Settings UI | `<SettingsSection title="Discord">` block in `MessagingSettings.tsx` | New `<SettingsSection title="Mattermost">` block |
| Connection-test button | `<SettingsTestBlock kind="discord">` | `<SettingsTestBlock kind="mattermost">` |

The Mattermost-specific extensions are:

1. **`registerSlashCommands` toggle** (default `false`). When `false`, `MattermostAdapter.start()` skips `reconcileSlashCommandsAcrossTeams()`. Users invoke verbs via `@pwragent <cmd>` text mention.
2. **`slashCommandPrefix` field** (default `"pwragent_"`, valid chars `[A-Za-z0-9_./-]`, max 128). Wired to existing `sanitizeMattermostCommandPrefix`. The Settings UI input is **disabled when `registerSlashCommands === false`**.
3. **HMAC signing key** (Keychain-backed, distinct from bot token). Generated automatically on first save; surfaces "Regenerate" button in UI. Env-var override (`PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_HMAC_SECRET`) takes precedence as today.

The doc note on the `/commands` toggle explains the v10.x thread-routing limitation and recommends `@pwragent help` as the universal entry point — implicitly framing slash commands as opt-in for users who want native autocomplete.

## Technical Approach

### Architecture

This is a finishing-pass plan, not an architectural change. Every piece slots into established patterns. The work breakdown follows the data flow: schema → service → runtime → UI → tests → docs.

```mermaid
flowchart LR
  TOML[(TOML config)] -->|read| Service
  Keychain[(Keychain<br/>safeStorage)] -->|getSecretSync| Service
  Env([env vars]) -->|readEnv*| Service
  Service[DesktopSettingsService<br/>`resolveSecretSync`<br/>`resolveBoolean/String/List`] -->|snapshot.messaging.mattermost| Loader[loadDesktopMessagingConfigFromSettings]
  Env -.precedence.-> Loader
  Loader -->|MattermostMessagingConfig| Adapter[MattermostAdapter]
  IPC[Settings IPC<br/>writeConfigPatch<br/>replaceSecret] -->|persist| Service
  IPC -->|persist| Keychain
  IPC -->|persist| TOML
  TestKind[SettingsTestBlock] -->|requestCredentialValidation| CredentialTester
  CredentialTester -->|case "mattermost"| ValidateCreds[validateCredentials<br/>Client4.getMe]
```

### Implementation Phases

#### Phase 1 — Schema (data layer, no behavior change)

Goal: Make `messaging.mattermost.*` a first-class part of the snapshot/patch/secret type tree. No UI, no runtime behavior change. The adapter still reads from env-only after this phase.

**Files:**
- `apps/desktop/src/main/settings/desktop-config.ts:20-66` — extend `DesktopSettingsConfig.messaging` with `mattermost?:` mirroring the Discord block at `:42-48`. Fields: `enabled?`, `streamingResponses?`, `serverUrl?`, `callbackBaseUrl?`, `callbackPort?`, `slashCommandPrefix?`, `registerSlashCommands?`, `authorizedUserIds?`. **HMAC secret stays out of TOML** — Keychain only.
- `desktop-config.ts:269-310` — TOML emit. Add an emit block for `[messaging.mattermost]` mirroring the Discord block at `:297-310`.
- `desktop-config.ts:361-396` — TOML parse. Add a parse case mirroring the Discord parse at `:384-396`.
- `desktop-config.ts:444-450` — prune. Mirror Discord's prune.
- `desktop-config.ts:111-141` — patch-merge. Add `mattermost: {...current.messaging?.mattermost, ...patch.messaging?.mattermost}` line at `:137-140`.
- `packages/shared/src/contracts/settings.ts:143-162` — snapshot type. Add `mattermost:` block under `messaging:` with the same field set as Discord at `:154-161`, **plus** the two Mattermost-specific fields:
  - `registerSlashCommands: DesktopSettingsValue<boolean>`
  - `slashCommandPrefix: DesktopSettingsValue<string>`
  - `serverUrl: DesktopSettingsValue<string>`
  - `callbackBaseUrl: DesktopSettingsValue<string>`
  - `callbackPort: DesktopSettingsValue<number>`
  - `botToken: DesktopSettingsSecretState`
  - `hmacSecret: DesktopSettingsSecretState`
  - `enabled: DesktopSettingsValue<boolean>`
  - `streamingResponses: DesktopSettingsValue<boolean>`
  - `authorizedUserIds: DesktopSettingsValue<string[]>`
- `packages/shared/src/contracts/settings.ts:188-209` — patch type. Add `mattermost?:` block mirroring `:202-208`.
- `packages/shared/src/contracts/settings.ts:40-43` — secret name enum. Add `"mattermostBotToken"` and `"mattermostHmacSecret"` to `DesktopSettingsSecretName`.
- `packages/shared/src/contracts/settings.ts:289-327` — `SETTINGS_CREDENTIAL_TEST_KINDS`. Add `"mattermost"`.
- `apps/desktop/src/main/settings/desktop-settings-env.ts` — already has the env-var constants from earlier work. Verify all five Mattermost env vars are exported (BOT_TOKEN, SERVER_URL, CALLBACK_BASE_URL, CALLBACK_PORT, CALLBACK_HMAC_SECRET, AUTHORIZED_USER_IDS, SLASH_COMMAND_PREFIX, plus add MATTERMOST_REGISTER_SLASH_COMMANDS_ENV).

**Acceptance:**
- `pnpm typecheck` passes
- Existing TOML files round-trip without losing data (no `[messaging.mattermost]` block on parse → empty defaults; existing block parses back to same struct)
- Snapshot returned by `readSettings()` includes a `messaging.mattermost` block with `source: "default"` for unset fields

**Effort:** Small. Mostly cargo-cult typing.

#### Phase 2 — Service-layer resolution

Goal: `desktopSettingsService.readSettings()` returns a fully-populated `messaging.mattermost` block with correct env/keychain/config/default `source` attribution. No runtime behavior change yet.

**Files:**
- `apps/desktop/src/main/settings/desktop-settings-service.ts:151-222` — extend the messaging snapshot resolution. Mirror Discord's block at `:197-221`. For each Mattermost field, call the matching resolver:
  - `resolveBoolean(snapshot.messaging?.mattermost?.enabled, MATTERMOST_ENABLED_ENV)` → enabled
  - `resolveBoolean(snapshot.messaging?.mattermost?.streamingResponses, MATTERMOST_STREAMING_RESPONSES_ENV)` → streamingResponses
  - `resolveString(snapshot.messaging?.mattermost?.serverUrl, MATTERMOST_SERVER_URL_ENV)` → serverUrl
  - `resolveString(snapshot.messaging?.mattermost?.callbackBaseUrl, MATTERMOST_CALLBACK_BASE_URL_ENV)` → callbackBaseUrl
  - `resolveNumber(snapshot.messaging?.mattermost?.callbackPort, MATTERMOST_CALLBACK_PORT_ENV)` → callbackPort (DEFAULT 47821)
  - `resolveString(snapshot.messaging?.mattermost?.slashCommandPrefix, MATTERMOST_SLASH_COMMAND_PREFIX_ENV)` → slashCommandPrefix (DEFAULT `"pwragent_"`)
  - `resolveBoolean(snapshot.messaging?.mattermost?.registerSlashCommands, MATTERMOST_REGISTER_SLASH_COMMANDS_ENV)` → registerSlashCommands (DEFAULT `false`)
  - `resolveList(snapshot.messaging?.mattermost?.authorizedUserIds, MATTERMOST_AUTHORIZED_USER_IDS_ENV)` → authorizedUserIds
  - `readSecretState("mattermostBotToken", MATTERMOST_BOT_TOKEN_ENV)` → botToken
  - `readSecretState("mattermostHmacSecret", MATTERMOST_CALLBACK_HMAC_SECRET_ENV)` → hmacSecret
- `desktop-settings-service.ts:281-287` — add `resolveMattermostBotTokenSync()` and `resolveMattermostHmacSecretSync()` mirroring the Telegram/Discord pattern at `:281-287`. They both call `this.resolveSecretSync(name, envKey)` (`:560-568`).
- `apps/desktop/src/main/settings/desktop-settings-env.ts` — add `MATTERMOST_REGISTER_SLASH_COMMANDS_ENV = "PWRAGENT_MESSAGING_MATTERMOST_REGISTER_SLASH_COMMANDS"`. Export.
- Add `resolveNumber` if it doesn't already exist as a service helper (audit `desktop-settings-service.ts` `resolveBoolean`/`resolveString`/`resolveList` — there's likely a `resolveInteger`).

**Acceptance:**
- Setting `PWRAGENT_MESSAGING_MATTERMOST_SERVER_URL=https://chat.example.com` makes `snapshot.messaging.mattermost.serverUrl.{value:"https://chat.example.com",source:"env",overriddenByEnv:true}`
- Writing `messaging.mattermost.serverUrl = "https://other.example.com"` to TOML and re-reading produces `{value:"https://other.example.com",source:"config",overriddenByEnv:false}` (with no env var)
- With both, the env value wins and `overriddenByEnv:true`
- Unit test: `apps/desktop/src/main/__tests__/desktop-settings-service.test.ts` — extend with Mattermost resolution cases mirroring Discord

**Effort:** Small. ~50 LOC of resolver wiring + tests.

#### Phase 3 — Runtime config wiring

Goal: `loadDesktopMessagingConfigFromSettings` reads `snapshot.messaging.mattermost.*` and merges with env. The bot-token-from-Keychain replaces the env-only path. The adapter receives a fully-populated config from either source.

**Files:**
- `apps/desktop/src/main/messaging/messaging-config.ts:70-73` — extend `DesktopMessagingSettingsSource` `Pick<>` to include `resolveMattermostBotTokenSync` and `resolveMattermostHmacSecretSync`.
- `messaging-config.ts:243-252` — replace the env-only pass-through:
  ```ts
  // BEFORE:
  // Mattermost is env-only today (no Settings UI yet — tracked in #195).
  // Pass through whatever loadDesktopMessagingConfig produced from env vars,
  // and log eligibility consistently with the other channels.
  ```
  with a settings+env merge mirroring the Telegram block at `:175-222`. Keychain bot token resolution: `envConfig.mattermost?.botToken ?? settings.resolveMattermostBotTokenSync()`. Same for HMAC. Authorized user IDs, server URL, callback URL, callback port, slash command prefix, register slash commands all read `envConfig.mattermost?.<field> ?? snapshot.messaging.mattermost.<field>.value`.
- `messaging-config.ts:355-369` — extend `redactDesktopMessagingConfig`'s `mattermost:` block to include the new fields and Mattermost HMAC redaction (`hmacSecret: config.mattermost.hmacSecret ? "[REDACTED]" : "[GENERATED]"`).
- `messaging-config.ts:5-11,140-153` — env-only path (`loadDesktopMessagingConfig`) — extend `mattermost:` config emission with `registerSlashCommands` (defaulting `false`) and `slashCommandPrefix` (defaulting `pwragent_`).

**Adapter wiring** (`packages/messaging/providers/mattermost/src/mattermost-config.ts`):
- Add `registerSlashCommands?: boolean` field. Default `false` semantically when unset.

**Acceptance:**
- Mattermost section eligibility log fires correctly under all four configurations:
  - env-only (existing test setup) → still works
  - Settings-only → adapter starts with Keychain-resolved bot token
  - Both → env wins (logged as override)
  - Neither → adapter doesn't start, log "mattermost: skipping — bot token unset"
- HMAC env override still wins over Keychain, matching today's bot-token precedence

**Effort:** Medium. Requires careful refactoring of the existing Mattermost branch in `loadDesktopMessagingConfigFromSettings`. Pre-existing tests for env-only must continue passing.

#### Phase 4 — `registerSlashCommands` gate

Goal: Adapter only registers slash commands when the toggle is true. Default off. Existing slash commands on a Mattermost server (from prior runs) are not auto-swept — note in operator doc.

**Files:**
- `packages/messaging/providers/mattermost/src/mattermost-adapter.ts` — in `start()`, gate the `await this.reconcileSlashCommandsAcrossTeams();` call:
  ```ts
  if (this.config.registerSlashCommands === true) {
    await this.reconcileSlashCommandsAcrossTeams();
  } else {
    this.logger.info?.("mattermost: slash commands disabled (registerSlashCommands=false); skipping reconciliation", {
      hint: "Users can invoke commands via `@<botUsername> <verb>` text mention.",
    });
  }
  ```
- `packages/messaging/providers/mattermost/src/__tests__/mattermost-adapter.test.ts` — add a test that the reconciler is NOT called when `registerSlashCommands` is false/undefined, and IS called when true.

**Acceptance:**
- Mattermost adapter starts cleanly without slash commands when toggle is unset/false (default behavior)
- Existing tests pass (they all set the toggle implicitly via the existing test fixtures — verify they don't break)

**Effort:** Tiny. ~5 LOC in adapter + 1 test.

#### Phase 5 — Mattermost `validate-credentials.ts`

Goal: Add the contract-conforming `validateCredentials(config)` export to the Mattermost provider package.

**Files:**
- `packages/messaging/providers/mattermost/src/validate-credentials.ts` (new file) — mirror Telegram's pattern at `packages/messaging/providers/telegram/src/validate-credentials.ts:30-61`. Implementation:
  ```ts
  import { Client4 } from "@mattermost/client";
  import {
    clipMessagingValidationError,
    type MattermostCredentialValidationConfig,
    type MessagingCredentialValidationResult,
  } from "@pwragent/messaging-interface";

  export async function validateCredentials(
    config: MattermostCredentialValidationConfig,
  ): Promise<MessagingCredentialValidationResult> {
    if (!config.botToken || config.botToken.length === 0) {
      return { status: "unset" };
    }
    if (!config.serverUrl || config.serverUrl.length === 0) {
      return { status: "unset" };
    }
    const client = new Client4();
    client.setUrl(config.serverUrl);
    client.setToken(config.botToken);
    client.setUserAgent("PwrAgent");
    try {
      const me = await client.getMe();
      return {
        status: "ok",
        account: me.username ?? "(unnamed bot)",
        detail: `Mattermost server: ${config.serverUrl}`,
      };
    } catch (error) {
      return {
        status: "failed",
        errorMessage: clipMessagingValidationError(scrubBotToken(extractMessage(error), config.botToken)),
      };
    }
  }

  function scrubBotToken(message: string, token: string): string {
    if (token.length < 8) return message;
    return message.replaceAll(token, "[redacted]");
  }
  ```
- `packages/messaging/interface/src/index.ts` — add `MattermostCredentialValidationConfig` type:
  ```ts
  export type MattermostCredentialValidationConfig = {
    botToken: string;
    serverUrl: string;
  };
  ```
- `packages/messaging/providers/mattermost/src/index.ts` — export `validateCredentials` from the package barrel (mirror Telegram's barrel at `packages/messaging/providers/telegram/src/index.ts:30`).
- `packages/messaging/providers/mattermost/src/__tests__/validate-credentials.test.ts` — mirror Telegram's pattern. Mock `Client4` constructor + `getMe()`. Test cases:
  - Empty bot token → `{status: "unset"}`
  - Empty server URL → `{status: "unset"}`
  - 401 from getMe → `{status: "failed", errorMessage: ...}`
  - Network error → `{status: "failed", errorMessage: ...}` (verify error is clipped + scrubbed)
  - Success → `{status: "ok", account: <username>, detail: <serverUrl>}`

**Acceptance:**
- `validateCredentials` exported from the package barrel
- All five test cases pass
- Bot token is scrubbed from any error message that might leak it

**Effort:** Small. ~80 LOC + tests.

#### Phase 6 — IPC + tester wiring

Goal: The renderer can call `desktopApi.testSettingsCredentials({ kind: "mattermost" })` and receive a `MessagingCredentialValidationResult`.

**Files:**
- `apps/desktop/src/main/messaging/messaging-runtime.ts:117-119,468-491` — extend `requestCredentialValidation` switch with `case "mattermost"`:
  ```ts
  case "mattermost": {
    const provider = await import("@pwragent/messaging-provider-mattermost");
    return provider.validateCredentials({
      botToken: request.botToken,
      serverUrl: request.serverUrl,
    });
  }
  ```
  Also extend the request-type union to include `{ kind: "mattermost", botToken, serverUrl }`.
- `apps/desktop/src/main/credential-tester/credential-tester.ts:193-219` — add `testMattermost()` mirroring `testTelegram`/`testDiscord`. Resolves bot token and server URL from settings, dispatches via runtime, lifts result.
- `credential-tester.ts:137-160` — extend `test()` switch with `"mattermost"` dispatch.
- `apps/desktop/src/main/ipc/settings.ts:159-181` — settings IPC handlers automatically pick up the new case via `SETTINGS_CREDENTIAL_TEST_KINDS`. No code change needed beyond ensuring the kind is in the enum (Phase 1 covered that).
- `apps/desktop/src/main/__tests__/credential-tester.test.ts` — add Mattermost coverage matching the existing Telegram/Discord stubs (~3 tests).

**Acceptance:**
- `desktopApi.testSettingsCredentials({kind: "mattermost"})` returns a `SettingsCredentialTestResult` with status/account/detail/errorMessage
- `lastResult` caching works (last test result paints on Settings remount)
- Test fixture uses a stubbed `validateMessagingCredentials` so tests don't reach the network or load the real Mattermost SDK

**Effort:** Small. ~50 LOC + 3 tests.

#### Phase 7 — Settings UI section

Goal: Render a `<SettingsSection title="Mattermost">` block in `MessagingSettings.tsx` mirroring Discord's section at `:194-301`, with the two Mattermost-specific extensions.

**Files:**
- `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx` — add a third `<SettingsSection>` after the Discord block at `:301`. Field layout:
  - **Connection**
    - `<TextField>` server URL (placeholder: `https://chat.example.com`)
    - `<SecretField>` bot token (kind: `"mattermostBotToken"`)
    - `<TextField>` callback base URL (placeholder: `https://pwragent.example.com/messaging/mattermost/callback`)
    - `<NumberField>` callback port (default 47821, min 1024, max 65535)
    - `<SecretField>` HMAC signing key (kind: `"mattermostHmacSecret"`, with auto-generate-on-first-save semantics — if empty when user enables, mint and persist)
  - **Authorization**
    - `<ToggleField>` enabled
    - `<ListField>` authorized user IDs (Mattermost user UUIDs, not usernames)
  - **Options**
    - `<ToggleField>` streaming responses
    - `<ToggleField>` register slash commands (default off)
    - `<TextField>` slash command prefix (default `"pwragent_"`, **disabled when register slash commands toggle is off**, with helper text on collisions)
  - **Connection test**
    - `<SettingsTestBlock kind="mattermost" desktopApi={...} icon={mattermostIcon} defaultName="Mattermost" defaultSub="Server: <serverUrl>" />`
- `apps/desktop/src/renderer/src/features/settings/useDesktopSettings.ts` — add `onSaveMattermost` callback that emits a `messaging.mattermost` patch to `desktopApi.writeSettingsConfig`.
- `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx:317-330` — extend `chipLabelForBotToken` family (or factor out) to handle the Mattermost section's chip state. Same env-override semantics: orange "env override" chip when bot token is env-shadowed.
- **Helper text on the slash-commands toggle:** Inline text below the toggle:
  > Default off. On Mattermost ≥11.0 the slash command body includes thread context, and PwrAgent honors it. On Mattermost ≤10.x the slash command body does not carry thread context — the response_url workaround (default behavior here) keeps the picker in the right thread, but we recommend `@pwragent help` as the universal entry point that works in DMs, channels, and threads on every Mattermost version. Slash commands stay namespaced under the prefix below to avoid collisions with built-in `/status`, `/away`, `/leave`.
- **Helper text on the prefix field:** Inline text below the input:
  > Mattermost reserves `/status`, `/away`, `/leave`, `/echo`, `/me`, `/shrug`, `/help`, `/code`, `/header`, `/purpose`, `/rename`, `/topic`, etc. The default prefix `pwragent_` produces `/pwragent_resume`, `/pwragent_status`, `/pwragent_detach`, `/pwragent_help` — these don't collide. Set to empty string to register bare triggers and accept the collision risk.

**Acceptance:**
- Mattermost section renders alongside Telegram and Discord
- All fields read/write correctly via the IPC layer
- Slash command prefix field is disabled when toggle is off
- Connection-test button works; success/failure status chips render inline
- Env-override chips show orange "env override" when env vars are set
- Renderer test (`settings-screen.test.tsx`) extended with at least one Mattermost flow assertion

**Effort:** Largest single phase. ~250 LOC of UI + ~80 LOC of test additions.

#### Phase 8 — Tests

Goal: Comprehensive coverage of the new pieces. Unit + renderer-integration. **No Playwright E2E** — no precedent exists for messaging settings; deferred per research finding.

**Test plan:**

| Layer | File | New tests |
|---|---|---|
| Provider unit | `packages/messaging/providers/mattermost/src/__tests__/validate-credentials.test.ts` | 5 cases (Phase 5) |
| Provider unit | `packages/messaging/providers/mattermost/src/__tests__/mattermost-adapter.test.ts` | `registerSlashCommands` toggle gating (Phase 4) |
| Service unit | `apps/desktop/src/main/__tests__/desktop-settings-service.test.ts` | 4 Mattermost field-resolution cases (env-only, settings-only, both, neither) |
| Service unit | `apps/desktop/src/main/__tests__/desktop-settings-service.test.ts` | `resolveMattermostBotTokenSync` + `resolveMattermostHmacSecretSync` (env > Keychain > unset) |
| Tester unit | `apps/desktop/src/main/__tests__/credential-tester.test.ts` | 3 Mattermost cases (success, 401, unset) |
| Runtime config | `apps/desktop/src/main/__tests__/messaging-config.test.ts` | Mattermost settings+env merge produces expected `MattermostMessagingConfig` |
| TOML schema | `apps/desktop/src/main/__tests__/desktop-config.test.ts` | Round-trip emit/parse for `[messaging.mattermost]` block |
| Renderer | `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx` | Mattermost section renders; replace bot token; toggle register-slash; prefix-disabled-when-toggle-off |

**Estimated test count delta:** +25 to +35.

**Acceptance:**
- All new tests pass
- Existing test count for messaging providers + desktop messaging stays clean (no regressions)
- Test count documented in the PR description before merge

**Effort:** Medium. Tests are mostly cargo-cult from Discord/Telegram patterns.

#### Phase 9 — Docs

Goal: Update operator and contributor docs. **Cite PR #199 prominently.**

**Files:**
- `docs/messaging-adding-a-provider.md` — add a top-of-document callout linking PR #199 as the canonical example. Update the slash-commands section (Step 7.5) to reference Mattermost's `registerSlashCommands` toggle pattern as one valid model. Update the gotchas list to mention the v10.x slash-command-thread-routing limitation if not already.
- `docs/messaging-architecture.md` — extend the file map table row for `mattermost-callback-server.ts` if needed; add a brief note in the architecture overview that Mattermost ships a Settings UI section (analogous to Discord and Telegram) using the existing settings primitives.
- `docs/messaging-platform-integration.md` — refresh the Mattermost section:
  - Settings UI is the recommended config path (env vars become advanced override only)
  - The `registerSlashCommands` toggle is documented with the v10.x rationale
  - The prefix field is documented (default + collision risks)
  - The smoke-test checklist (steps 1c-thread / 1c-mention / 1c-help) is updated to reflect that slash commands are off by default
  - The HMAC secret in Keychain replaces the prior "env-var-required" recommendation
- `docs/messaging-adapter-contract.md` — update the credential-validation section to mention Mattermost's contract conformance (uses `Client4.getMe()` mirroring Telegram's `Bot.api.getMe()`).
- **PR #199 reference text** (target placement: top of `messaging-adding-a-provider.md`):
  > **Worked example: PR [#199](https://github.com/pwrdrvr/PwrAgent/pull/199)** — adds the Mattermost adapter end-to-end. Use this PR as a navigable example of every piece this guide describes: capability profile, formatting helpers, callback handling, slash command registration with namespace prefixes, response_url workaround for upstream thread-context gaps, validate-credentials, Settings UI section, Keychain secret persistence, env-var override, connection-test button, smoke-test checklist, operator runbook. Search the PR's commit history for keywords matching the section you're working on.
- Cross-link this PR reference from `docs/messaging-architecture.md` and `docs/messaging-adapter-contract.md` in their "Living examples" sections (use whatever heading they have; create one if missing).

**Acceptance:**
- All four docs updated and link to PR #199
- Operator doc smoke-test sequence reflects the Settings-UI-driven flow
- Contributor guide is accurate for someone adding a fifth provider after this PR merges

**Effort:** Medium. Mostly editing existing prose to reflect the new state.

#### Phase 10 — Verification + smoke test refresh

Goal: Manual smoke test the full flow end-to-end on the user's local Mattermost. Verify no regressions for env-only operators (CI / production scripts that set `PWRAGENT_MESSAGING_MATTERMOST_*`).

**Smoke test steps** (extend `docs/messaging-platform-integration.md`):

1. **Fresh install** (no `~/.pwragent/profiles/default/`): launch desktop, open Settings → Messaging → Mattermost. Verify section renders with all empty/default fields.
2. **Configure via UI**: enter server URL, paste bot token via "Replace", enter callback base URL, leave port at 47821. Save (auto-blur).
3. **Connection test**: click "Test connection" button. Expect green status chip, account = bot username, detail = server URL.
4. **Connection test with bad token**: revoke token in Mattermost, click test again. Expect red chip with truncated 401 message.
5. **Authorize a user**: paste your Mattermost user UUID into authorized list. Save.
6. **Restart adapter**: quit + relaunch (until hot-reload lands). Mattermost adapter starts with no eligibility warnings.
7. **Send `@pwragent help`** from a DM — bot replies with the canonical command list (button-driven menu).
8. **Toggle `registerSlashCommands` on, set prefix to `pwragent_`, save**: restart. Confirm `mattermost slash commands reconciled` log fires for each team. `/pwragent_help` autocomplete appears.
9. **Toggle `registerSlashCommands` off**: restart. Confirm reconciler is skipped (existing registered commands stay on the server but are no longer maintained).
10. **Env-var override**: set `PWRAGENT_MESSAGING_MATTERMOST_BOT_TOKEN=<other token>` and relaunch. Settings UI shows orange "env override" chip on the bot token field. Replace button is disabled. Test connection uses the env-var token.
11. **HMAC regenerate**: click regenerate in Settings. Existing rendered buttons fail HMAC verification (expected). Send a fresh `@pwragent help` and verify new buttons work.
12. **Cross-restart persistence**: with Settings-driven config (no env vars), buttons rendered before restart still work after restart (HMAC stable in Keychain).

**Acceptance:**
- All 12 steps pass on a real Mattermost server
- No regressions in `op:dev` env-var-only flow (existing testers' setups continue to work)
- Smoke-test checklist updated in operator doc

**Effort:** ~1-2 hours of manual testing + doc edits.

## Alternative Approaches Considered

| Alternative | Why rejected |
|---|---|
| Keep Mattermost env-var-only; ship the rest | Doesn't meet the bar set by Discord/Telegram. Operator UX is materially worse; no Keychain persistence; no connection test. The user explicitly asked for "complete addition of a new messaging platform." |
| Default `registerSlashCommands` to ON | The v10.x thread-routing path goes through the response_url workaround which is operationally complex (post-id recovery, attribution, dedup). Defaulting off keeps new users on the simpler `@pwragent help` path while preserving slash commands as opt-in for power users. |
| Make `slashCommandPrefix` non-configurable (hardcode `pwragent_`) | Loses flexibility for operators on multi-tenant Mattermost servers running multiple PwrAgent instances. The override-to-empty-string opt-out for bare triggers is also a known-useful affordance. |
| Put HMAC secret in Settings TOML instead of Keychain | TOML is reviewable in plaintext and can leak via backup tools. Keychain matches the precedent for bot tokens; the same `safeStorage`-backed encryption applies. |
| Hot-reload messaging runtime on settings change in this plan | Cross-cutting concern (affects Telegram/Discord too). Out of scope for "Mattermost-finish." File as a separate issue tracking [`messaging-runtime.ts:643-651`](../apps/desktop/src/main/messaging/messaging-runtime.ts) — `disposeDesktopMessagingRuntime` exists but isn't called from settings IPC handlers. Document the restart-required behavior in this plan's smoke test instead. |
| Add Playwright E2E for settings flow | No precedent for messaging settings E2E in the repo. Establishing the pattern is a separate concern. Renderer-integration tests via `settings-screen.test.tsx` are the existing convention; cover the flow there. |
| Sweep orphaned slash commands when `registerSlashCommands` goes off | Adds complexity; users can manually remove via Mattermost UI. Document in operator doc as a known limitation. |

## System-Wide Impact

### Interaction Graph

```
Settings UI form change
  ↓
desktopApi.writeSettingsConfig (preload IPC)
  ↓
SETTINGS_WRITE_CONFIG_CHANNEL handler (apps/desktop/src/main/ipc/settings.ts:106-146)
  ↓
service.writeConfigPatch (mutates TOML on disk)
  ↓
service.readSettings()  // re-emits snapshot
  ↓
[adapter does NOT auto-restart — limitation]
  ↓
On next adapter start: loadDesktopMessagingConfigFromSettings reads fresh snapshot
  ↓
MattermostAdapter constructor receives merged env+settings config
  ↓
MattermostAdapter.start() → Client4.getMe() → reconcile slash commands (gated by toggle) → bind callback handle store → ready

Settings UI "Test connection" click
  ↓
desktopApi.testSettingsCredentials({kind: "mattermost"})
  ↓
SETTINGS_TEST_CREDENTIALS_CHANNEL handler
  ↓
credentialTester.testMattermost()
  ↓
runtime.requestCredentialValidation({kind: "mattermost", botToken, serverUrl})
  ↓
import("@pwragent/messaging-provider-mattermost").validateCredentials({...})
  ↓
new Client4().getMe() → returns { username, ... }
  ↓
{status: "ok", account: username, detail: serverUrl} → cached in tester → returned to renderer
  ↓
SettingsTestBlock renders status chip (green/red) with account + detail or errorMessage
```

### Error & Failure Propagation

| Source | Surfaces as | Recovery |
|---|---|---|
| `Client4.getMe()` returns 401 | `validateCredentials` returns `{status: "failed", errorMessage: "Unauthorized"}` | User re-enters bot token via Replace button |
| Network unreachable | `validateCredentials` returns `{status: "failed", errorMessage: "Network error: ..."}` (clipped to 240 chars, scrubbed of token) | User checks server URL / VPN / firewall |
| Bad TOML on read | `desktopSettingsService` boots with defaults, logs error | TOML is overwritten on next save |
| Keychain decrypt fails (signing identity changed) | `getSecretSync` returns `undefined`, `botToken.source = "unset"` | User re-enters bot token (documented in release notes) |
| Adapter `start()` throws | Logged; runtime continues (Telegram/Discord unaffected) | User restarts after fixing config |
| `registerSlashCommands: true` but bot lacks `manage_slash_commands` permission | Reconciler logs warning per failed team; adapter continues | User grants permission, restarts |
| HMAC secret env override + user clicks Replace in UI | Token is persisted to Keychain; env still wins for current session | Documented in UI: "env override active; Keychain value applies after env is removed" |

### State Lifecycle Risks

- **Stale slash commands when `registerSlashCommands` goes off**: PwrAgent stops maintaining them, but they remain on the Mattermost server. User can manually remove via Mattermost System Console → Integrations → Slash Commands. **Documented; not auto-handled.**
- **Stale slash commands when prefix changes**: Old-prefixed commands stay; new-prefixed commands get registered alongside. **Documented; not auto-handled.** Future improvement: sweep on-prefix-change.
- **Keychain entry orphaned after Settings UI clears bot token but env var still set**: When env var is later removed, adapter falls back to defaults (no token). **Behavior matches Discord/Telegram precedent.**
- **HMAC secret rotation**: Regenerate button invalidates all rendered buttons. Acceptable; matches existing auto-TTL behavior on per-process secret. **Documented in UI helper text.**

### API Surface Parity

This plan **establishes new surface area** for Mattermost-specific config: `registerSlashCommands`, `slashCommandPrefix`, HMAC secret as a Keychain secret. Discord and Telegram could grow analogous features in the future:

- Discord could grow a `registerApplicationCommands` toggle (currently unconditional). Out of scope.
- Telegram could grow a `setMyCommands` toggle (currently unconditional). Out of scope.
- All providers could grow connection-quality validation beyond credential validation (e.g., reachability of the WebSocket endpoint). Out of scope.

These are tracked as future improvements, not blockers.

### Integration Test Scenarios

Five cross-layer scenarios that unit tests with mocks won't catch:

1. **Settings change → restart → adapter starts with new config**: User changes server URL in Settings. Adapter doesn't auto-restart. After manual restart, adapter starts with the new URL. Verifies the env+settings merge in `loadDesktopMessagingConfigFromSettings`.
2. **Env override + Settings UI badge**: User has `PWRAGENT_MESSAGING_MATTERMOST_BOT_TOKEN` set in env. Settings UI shows the orange "env override" chip on the bot token field. The Clear button is disabled. The Replace button writes to Keychain (verified by reading from Keychain after) but doesn't take effect until env is unset.
3. **Connection test using env-overridden token**: With env var set, the connection test uses the env value, not the Keychain value. Verifies `credentialTester.testMattermost` reads via the same `resolveMattermostBotTokenSync` path as the adapter.
4. **`registerSlashCommands` toggle ON → adapter starts → reconciler runs → toggle OFF → restart → reconciler skipped**: Verifies the gate. Existing slash commands on the server remain until user manually deletes.
5. **HMAC regenerate during active session**: User clicks regenerate. Old buttons in chat fail HMAC verification (expected). Bot's next status delivery uses new HMAC. New buttons work. Verifies the HMAC keyring's read-on-each-callback semantics.

These five scenarios should be smoke-tested manually per Phase 10.

## Acceptance Criteria

### Functional Requirements

- [ ] `messaging.mattermost.*` is part of the `DesktopSettingsConfig` snapshot, patch, and TOML schema
- [ ] Mattermost bot token is persisted to Keychain via `safeStorage` (matching Discord/Telegram precedent)
- [ ] Mattermost HMAC signing key is persisted to Keychain (new pattern; auto-generated on first save)
- [ ] Env vars take precedence over Keychain/Settings values for ALL Mattermost fields
- [ ] Settings UI surfaces an "env override" chip on env-shadowed fields
- [ ] Mattermost section renders in `MessagingSettings.tsx` with all fields
- [ ] Connection-test button calls `validateCredentials` and renders status inline
- [ ] `registerSlashCommands` toggle defaults to **false**; gates `reconcileSlashCommandsAcrossTeams()`
- [ ] `slashCommandPrefix` field defaults to `"pwragent_"`; disabled in UI when `registerSlashCommands` is off
- [ ] Helper text on `/commands` toggle explains the v10.x thread-routing limitation and recommends `@pwragent help` as the universal entry point
- [ ] Existing env-var-only configurations (e.g., `op:dev` flow) continue to work with no regressions
- [ ] PR #199 is referenced in `messaging-adding-a-provider.md` as the canonical worked example

### Non-Functional Requirements

- [ ] `pnpm typecheck` passes for the full workspace
- [ ] `pnpm lint:boundaries` passes (0 violations)
- [ ] `pnpm test` passes for the full workspace
- [ ] No new entries in `.dependency-cruiser.cjs` required
- [ ] Bot tokens never logged in plaintext (verify via `redactDesktopMessagingConfig`)
- [ ] Connection-test errors are clipped to 240 chars and scrubbed of bot tokens (matches Telegram/Discord precedent)
- [ ] HMAC secret rotation is documented as invalidating in-flight buttons

### Quality Gates

- [ ] All five `validate-credentials.ts` test cases pass (Phase 5)
- [ ] Renderer test (`settings-screen.test.tsx`) covers Mattermost section render + at least one save flow
- [ ] Smoke-test checklist (12 steps in Phase 10) all pass on a real Mattermost server
- [ ] Operator doc, contributor guide, and architecture doc are updated and cross-link PR #199
- [ ] Test count delta documented in PR description before merge (expected: +25 to +35)

## Success Metrics

- A new Mattermost operator with a fresh PwrAgent install can configure the bot **entirely via Settings UI** in under 5 minutes (server URL, bot token via Replace, callback base URL, authorized user IDs, save) without consulting env-var docs.
- An existing `op:dev` env-var operator's flow is **unchanged** — they don't need to learn anything new or migrate state.
- The "Mattermost adapter is incomplete" footnote in [`messaging-config.ts:247`](../apps/desktop/src/main/messaging/messaging-config.ts) is **removed** — issue #195's Mattermost slice is closed.
- PR #199 becomes a **navigable, citable example** that the next provider author (Slack, Feishu, Mattermost-replacement, etc.) can follow.

## Dependencies & Prerequisites

- **Issue [#195](https://github.com/pwrdrvr/PwrAgent/issues/195)** — Per-platform Settings UI umbrella. This plan closes the Mattermost slice. May want to keep #195 open if Slack/Feishu are next.
- **PR [#199](https://github.com/pwrdrvr/PwrAgent/pull/199)** — Active branch this work lands on. All prior commits stay; this plan adds new commits on top.
- **PR [#211](https://github.com/pwrdrvr/PwrAgent/pull/211) / commit `1c8089dd`** — Connection-test infrastructure. Already merged. Mirror the pattern.
- **`@mattermost/client@^11.4.0`** — already installed; no version bump.
- **No new external dependencies.**

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| TOML schema change breaks existing user configs | Low | Medium | Adding optional fields is backward-compatible. Existing TOML files without `[messaging.mattermost]` parse to defaults. Test round-trip with a real existing config. |
| Settings UI visual regression in Discord/Telegram sections | Low | Low | We're appending, not modifying. Run renderer test suite to catch unintended breakages. |
| Env-override badge doesn't render correctly for new fields | Medium | Low | Renderer test asserts on chip presence/absence under env-set vs settings-set conditions. |
| `registerSlashCommands` default change breaks existing testers' setups | Medium | Low | Existing testers had slash commands explicitly registered during testing. They stay registered server-side; user can re-enable the toggle to resume maintenance. Document this in PR description for current testers. |
| Keychain decrypt fails on signing identity change | Already known | Medium | `safeStorage` returns undefined; UI prompts re-entry. Documented in [`apps/desktop/CLAUDE.md`](../apps/desktop/CLAUDE.md) Release Notes. No new risk introduced. |
| HMAC secret in Keychain persists across signing-identity changes (decrypt fails, all buttons silently break) | Already known | Medium | Same as above — documented behavior. Settings UI shows "Keychain unavailable" state; user regenerates. |
| `validate-credentials` leaks bot token in error message | Low | High | `scrubBotToken()` regex strips token before clipping. Test case covers this. |
| Connection-test button DoS-able by repeated clicks | Low | Low | `<SettingsTestBlock>` already has `testing` state that disables the button while in-flight. |
| Hot-reload not implemented; user thinks settings save without effect | Medium | Low | Settings UI shows a banner: "Restart required for messaging changes" (or the "Save and restart" pattern). Future improvement: wire `disposeDesktopMessagingRuntime()` from the settings IPC handler. |
| Adding `mattermostHmacSecret` to secret store creates a second secret entry that orphans on Keychain identity change | Medium | Low | Same recovery path as bot token. Both secrets are independent — orphaning one doesn't affect the other. |

## Documentation Plan

| Doc | Change |
|---|---|
| `docs/messaging-adding-a-provider.md` | Add top-of-doc callout linking PR #199 as the worked example. Update Step 7.5 (slash commands) to mention the `registerSlashCommands` toggle pattern. |
| `docs/messaging-architecture.md` | Cross-link PR #199 in living examples. Update file map row for Mattermost-specific files (`mattermost-callback-server.ts`, `validate-credentials.ts`, `mattermost-commands.ts`). |
| `docs/messaging-platform-integration.md` | Refresh Mattermost section: Settings UI is the recommended path, env vars are advanced override. Document `registerSlashCommands` default off + rationale. Update smoke-test checklist (12 steps). |
| `docs/messaging-adapter-contract.md` | Note Mattermost's `validate-credentials.ts` conformance to the shared contract. |
| `apps/desktop/CLAUDE.md` Release Notes | Add Mattermost bot token + HMAC secret to the "Keychain identity change" list (already covers Telegram/Discord). |

## Sources & References

### Internal References (file:line)

#### Schema
- `apps/desktop/src/main/settings/desktop-config.ts:20-66` — `DesktopSettingsConfig.messaging` shape (add Mattermost block at `:42-48`-equivalent)
- `apps/desktop/src/main/settings/desktop-config.ts:269-310` — TOML emit (add Mattermost block)
- `apps/desktop/src/main/settings/desktop-config.ts:361-396` — TOML parse
- `apps/desktop/src/main/settings/desktop-config.ts:111-141` — patch-merge
- `packages/shared/src/contracts/settings.ts:143-162` — snapshot type
- `packages/shared/src/contracts/settings.ts:188-209` — patch type
- `packages/shared/src/contracts/settings.ts:40-43` — `DesktopSettingsSecretName`
- `packages/shared/src/contracts/settings.ts:289-327` — `SETTINGS_CREDENTIAL_TEST_KINDS`

#### Service / Keychain
- `apps/desktop/src/main/settings/desktop-secret-store.ts:6-12` — secret store interface
- `apps/desktop/src/main/state/secret-store-sqlite.ts:15-87` — `DbBackedSafeStorageSecretStore`
- `apps/desktop/src/main/settings/desktop-settings-singleton.ts:1,10` — singleton wiring
- `apps/desktop/src/main/settings/desktop-settings-service.ts:151-222` — snapshot resolution (add Mattermost block at `:197-221`-equivalent)
- `apps/desktop/src/main/settings/desktop-settings-service.ts:281-287` — sync resolver pattern (add `resolveMattermostBotTokenSync`, `resolveMattermostHmacSecretSync`)
- `apps/desktop/src/main/settings/desktop-settings-service.ts:262-275` — `replaceSecret`/`clearSecret`
- `apps/desktop/src/main/settings/desktop-settings-service.ts:519-558` — `readSecretState`
- `apps/desktop/src/main/settings/desktop-settings-service.ts:560-568` — `resolveSecretSync`
- `apps/desktop/src/main/settings/desktop-settings-service.ts:352-371,435-452,500-517` — env-precedence resolvers

#### Runtime config
- `apps/desktop/src/main/messaging/messaging-config.ts:70-73` — `DesktopMessagingSettingsSource` `Pick<>`
- `apps/desktop/src/main/messaging/messaging-config.ts:175-222` — Telegram settings+env merge (mirror for Mattermost)
- `apps/desktop/src/main/messaging/messaging-config.ts:243-261` — current env-only Mattermost branch (replace)
- `apps/desktop/src/main/messaging/messaging-config.ts:355-369` — `redactDesktopMessagingConfig` Mattermost block (extend)
- `apps/desktop/src/main/messaging/messaging-config.ts:247` — the `// tracked in #195` comment to remove

#### Connection test
- `packages/messaging/providers/telegram/src/validate-credentials.ts:30-61` — Telegram impl (template)
- `packages/messaging/providers/discord/src/validate-credentials.ts:22-65` — Discord impl (template)
- `packages/messaging/interface/src/index.ts` — `MessagingCredentialValidationResult`, `clipMessagingValidationError` (add `MattermostCredentialValidationConfig`)
- `apps/desktop/src/main/messaging/messaging-runtime.ts:117-119,468-491` — `requestCredentialValidation` switch
- `apps/desktop/src/main/credential-tester/credential-tester.ts:137-160,193-219` — tester `test()` switch + `testTelegram`/`testDiscord`
- `apps/desktop/src/main/ipc/settings.ts:159-181` — settings IPC handlers
- `apps/desktop/src/shared/ipc.ts:67,74` — channel constants
- `apps/desktop/src/preload/index.ts:224-231` — preload bridge
- `apps/desktop/src/renderer/src/lib/desktop-api.ts:192-202` — renderer API

#### Settings UI
- `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx` — full file. Telegram at `:101-192`, Discord at `:194-301`. Add Mattermost section after `:301`.
- `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx:333-576` — form primitives (`SegmentedField`, `ToggleField`, `TextField`, `NumberField`, `ListField`, `SecretField`)
- `apps/desktop/src/renderer/src/features/settings/SettingsTestBlock.tsx` — full file. UI primitive for connection-test button.
- `apps/desktop/src/renderer/src/features/settings/useDesktopSettings.ts` — settings hook (add `onSaveMattermost`)
- `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx` — layout primitives

#### Tests (existing patterns)
- `packages/messaging/providers/telegram/src/__tests__/validate-credentials.test.ts` — Telegram validate-credentials test pattern
- `apps/desktop/src/main/__tests__/credential-tester.test.ts` — tester unit test pattern (12 tests; add Mattermost cases)
- `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx` — renderer integration test (extend with Mattermost flow)

#### Mattermost runtime (already shipped on this branch)
- `packages/messaging/providers/mattermost/src/mattermost-config.ts:1-58` — config type (add `registerSlashCommands?`)
- `packages/messaging/providers/mattermost/src/mattermost-adapter.ts` — `start()`, `reconcileSlashCommandsAcrossTeams` (add toggle gate)
- `packages/messaging/providers/mattermost/src/mattermost-commands.ts` — slash command catalog (no change)
- `packages/messaging/providers/mattermost/src/mattermost-callback-server.ts` — HTTP listener (no change)
- `packages/messaging/providers/mattermost/src/index.ts` — package barrel (add `validateCredentials` export)

### Related Work

- **Active PR**: [#199](https://github.com/pwrdrvr/PwrAgent/pull/199) — `feat/messaging-mattermost-adapter`, the branch this work lands on.
- **Connection-test precedent**: PR [#211](https://github.com/pwrdrvr/PwrAgent/pull/211) (commit `1c8089dd`).
- **Per-platform Settings UI umbrella**: [#195](https://github.com/pwrdrvr/PwrAgent/issues/195).
- **Foundational Settings plan**: [`docs/plans/2026-04-30-003-feat-desktop-settings-config-plan.md`](2026-04-30-003-feat-desktop-settings-config-plan.md) — established the Telegram/Discord settings precedent.
- **Settings design alignment**: [`docs/plans/2026-05-06-001-feat-settings-screens-design-alignment-plan.md`](2026-05-06-001-feat-settings-screens-design-alignment-plan.md) — restyled `MessagingSettings.tsx` into `<SettingsSection>` cards with chip indicators.
- **Original Mattermost adapter plan**: [`docs/plans/2026-05-06-001-feat-messaging-mattermost-adapter-and-provider-guide-plan.md`](2026-05-06-001-feat-messaging-mattermost-adapter-and-provider-guide-plan.md) — the runtime-layer plan this finishes.
- **Open follow-ups filed during PR #199 (preserved post-merge)**:
  - [#204](https://github.com/pwrdrvr/PwrAgent/issues/204) — sweep pending intents/handles on unbind
  - [#206](https://github.com/pwrdrvr/PwrAgent/issues/206) — misleading `status: "interrupted"` label on unbind
  - [#207](https://github.com/pwrdrvr/PwrAgent/issues/207) — wire reaper to periodic task
  - [#208](https://github.com/pwrdrvr/PwrAgent/issues/208) — surface adapter-internal rejections in activity log
  - [#214](https://github.com/pwrdrvr/PwrAgent/issues/214) — per-conversation-kind rename capability

### External References

- [Mattermost Client4 SDK — `getMe()`](https://api.mattermost.com/#tag/users/operation/GetMe) — used by `validate-credentials.ts`
- [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) — Keychain backing
- [Mattermost slash command body fields](https://developers.mattermost.com/integrate/slash-commands/custom/) — for the v10.x vs v11.x `root_id` upstream gap
