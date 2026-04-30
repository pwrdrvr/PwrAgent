---
date: 2026-04-30
topic: desktop-settings-config
---

# Desktop Settings And Config

## Problem Frame

PwrAgnt needs a durable desktop app configuration system and a settings screen that makes important app-level behavior editable without scattering preferences across composer controls, runtime-only environment variables, or provider-specific setup paths.

The immediate users are desktop app users configuring experimental UI behavior, messaging integration credentials, and model provider setup. The settings surface should make the current app configuration understandable, editable, and inspectable while keeping thread-specific controls in the composer where they already belong.

## Requirements

**Config Contract**
- R1. The desktop app uses a PwrAgnt desktop TOML config file as the user-editable source of truth for app-level settings.
- R2. Environment variables override TOML config values at runtime, and the settings screen clearly distinguishes overridden values from values currently controlled by the config file.
- R3. The config system supports the initial settings groups for Experimental, Messaging, and Models without forcing messaging bot runtime integration in the same release.
- R4. The config system preserves the existing Grok app-server config direction: `~/.config/grok-app-server/config.toml` is already the current source of truth for Grok app-server runtime keys, while the desktop settings work defines the desktop app's own configuration surface.
- R5. The settings screen must not silently write secrets into TOML when the selected secret storage policy requires keychain storage.
- R6. Effective values use this precedence: environment override first, then keychain-backed secret or TOML config value, then product default.

**Settings Navigation And Layout**
- R7. A settings gear icon opens a dedicated settings screen from the desktop shell.
- R8. The settings screen uses a left-side section bar for top-level settings sections.
- R9. The initial section bar includes Experimental, Messaging, and Models.
- R10. Settings navigation must preserve the existing thread-first desktop hierarchy: opening settings is a distinct app-level mode, not a replacement for thread/draft composer controls.
- R11. Settings UI follows `docs/UI-THEME.md` and `docs/design/desktop-style-guide.md`, including grouped settings surfaces, restrained panels, no browser-default controls, and radius no greater than 8px.
- R12. Settings surfaces include loading, save-in-progress, saved, validation/error, unavailable keychain, and unavailable discovery states where those states apply.

**Experimental Settings**
- R13. Experimental includes a Chat Reply Composer setting.
- R14. Chat Reply Composer is a three-way selector with these options: `textarea`, `TipTap with chips`, and `custom widget with chips`.
- R15. Chat Reply Composer defaults to `textarea`.
- R16. The selected composer implementation is an app-level UI preference and does not alter thread history, model configuration, or message content semantics.

| Composer option | Expected behavior |
| --- | --- |
| `textarea` | Current plain textarea reply composer and default behavior. |
| `TipTap with chips` | Rich editor option intended to render structured chips in the reply composer. |
| `custom widget with chips` | Custom composer option intended to support chips without committing to TipTap. |

**Messaging Settings**
- R17. Messaging includes separate Telegram and Discord groups.
- R18. Telegram settings include Enabled, Bot Token, Authorized User IDs, and Authorized Supergroups.
- R19. Discord settings include Enabled, Bot Token, Application ID, Authorized User IDs, Authorized Guilds, and Message Content Intent.
- R20. Authorized User IDs, Authorized Supergroups, and Authorized Guilds are editable as list fields and support comma-separated environment variable values.
- R21. Discord's stored concept for server-level authorization is Guilds, while the UI may label the field as Servers / Guilds if that improves readability.
- R22. Bot tokens are treated as secrets and stored in the OS keychain, with TOML storing only non-secret settings and whatever non-secret metadata is needed to locate the keychain item.
- R23. The settings UI masks existing bot tokens and offers explicit replace and clear actions.
- R24. Messaging settings can save incomplete credentials and should show missing-required-value status instead of requiring live external validation in this pass.
- R25. Messaging settings support the provided environment variable names as runtime overrides:
  - `PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN`
  - `PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS`
  - `PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN`
  - `PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID`
  - `PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS`
  - `PWRAGNT_MESSAGING_DISCORD_MESSAGE_CONTENT_INTENT`
- R26. The first pass is config/settings only: it does not need to connect Telegram or Discord bots, validate tokens with external services, listen for messages, or send messages.

**Model Settings**
- R27. Models includes a Codex group and a Grok group.
- R28. Codex settings include a Codex path setting that defaults to auto discovery.
- R29. Codex settings show discovered Codex executable paths, the detected version for each path when available, and which path/version is currently being used.
- R30. Users can override the Codex path from settings, and the UI distinguishes an explicit override from auto discovery.
- R31. Grok settings include an API Key field.
- R32. The Grok API key is treated as a secret and stored in the OS keychain when edited through settings.
- R33. Grok API key runtime behavior continues to honor environment-variable override semantics, including the existing `XAI_API_KEY` behavior.

**Secret And Override Behavior**
- R34. Secret fields show whether the effective value comes from keychain, environment override, or is unset.
- R35. When a secret is controlled by an environment override, settings may show that an override exists but must not reveal the secret value.
- R36. When a non-secret setting is controlled by an environment override, settings shows the effective value and identifies the config value as overridden.
- R37. Clearing a value from settings removes the TOML/keychain value only; it does not unset process environment variables.
- R38. Secret values must not be written to logs, renderer-visible debug output, non-secret config snapshots, or IPC responses beyond the minimum explicit write path needed to save or replace the secret.

## Success Criteria

- Users can open settings from the gear icon and switch between Experimental, Messaging, and Models sections using the left-side section bar.
- Users can choose the app-level reply composer implementation, and the default remains the current textarea behavior.
- Users can enter, replace, and clear Telegram, Discord, and Grok secrets without those secrets being written into TOML.
- Users can inspect whether settings are coming from TOML/keychain or environment overrides.
- Users can inspect Codex auto-discovery results and choose an explicit Codex path when needed.
- The shipped scope is useful before messaging runtime exists because it establishes the config contract and editable settings surface.

## Scope Boundaries

- This does not implement Telegram or Discord bot runtime behavior.
- This does not validate messaging tokens against Telegram or Discord services.
- This does not redesign the existing composer-owned thread/draft model controls.
- This does not migrate the Grok app-server config file unless planning determines a compatibility path is needed.
- This does not require replacing the existing textarea composer implementation in the same pass.
- This does not expose raw secret values after they have been saved.

## Key Decisions

- Desktop TOML plus env override: TOML is the editable desktop source of truth, while environment variables remain the highest-precedence runtime override.
- Keychain-backed secrets: secrets belong in the OS keychain, not directly in TOML, so settings can configure credentials without making the config file itself a secret bundle.
- Settings as app-level config: the settings screen owns durable app configuration, while composer controls continue to own thread and draft settings.
- Messaging config first: Telegram and Discord fields are included now, but actual bot connection and message handling are deferred.
- Composer selector as Experimental: the reply composer implementation choice is a user-visible experimental setting with three options and `textarea` as the default.

## Dependencies / Assumptions

- The desktop app can access an OS keychain integration from the main process or a safe equivalent layer.
- Codex executable discovery can be performed locally without requiring network access.
- The existing Grok app-server config remains supported while the desktop settings contract is introduced.
- Environment variable names for additional Telegram and Discord fields not listed in the prompt can be finalized during planning if needed.

## Outstanding Questions

### Deferred to Planning
- [Affects R1-R6][Technical] What exact desktop config file path and TOML table shape should be used so it coexists cleanly with the current Grok app-server config?
- [Affects R22-R23, R32-R35][Technical] Which keychain library or platform API should the desktop main process use, and how should failures be surfaced in settings?
- [Affects R25, R33-R36][Technical] What complete environment variable naming convention should cover enabled flags, Discord authorized guilds, Telegram supergroups, Grok API key, and Codex path?
- [Affects R28-R30][Technical] What search order should Codex auto-discovery use, and how should version detection timeouts/failures be represented?
- [Affects R14-R16][Technical] What internal feature boundary should select between textarea, TipTap, and custom composer implementations before the richer composers are fully built?

## Next Steps

-> `/prompts:ce-plan` for structured implementation planning
