---
title: "feat: Add messaging mention help and new-thread shortcut"
type: feat
status: completed
date: 2026-05-12
origin: docs/brainstorms/2026-04-30-messaging-platform-integration-requirements.md
deepened: 2026-05-12
---

# feat: Add messaging mention help and new-thread shortcut

## Overview

Change the default response for a bare leading bot mention in an unbound chat from the current single Resume-only prompt into the canonical help menu, and add a New action that jumps directly into the existing new-thread project browser.

The implementation should reuse the command/help/resume-browser surfaces that already exist. This is a small workflow improvement, not a new messaging flow: `@bot` should normalize to help, and `New` should normalize to the same state as `/resume --new`.

## Problem Frame

When a user mentions the bot in a chat that is not bound to a PwrAgent thread, the current behavior either falls through as plain text and renders a narrow "Choose a thread" confirmation with only Resume, or, for Slack app mentions with no trailing text, can produce no useful menu at all. That makes the bot feel under-discoverable at exactly the point where a user is asking "what can you do here?"

The existing command catalog and help surface already solve the discoverability problem. The missing behavior is routing a bare mention to that surface and giving the help menu a direct New-thread entry point.

## Requirements Trace

- R1. A bare leading bot mention in an authorized chat must show the canonical help menu instead of the Resume-only unbound prompt.
- R2. The help menu must include a New button that opens the existing new-thread browser mode without requiring the user to type `/resume --new`.
- R3. Existing `/resume`, `/resume --new`, `/help`, text fallback, callback, and command-button behavior must continue to work.
- R4. The behavior must stay channel-neutral in workflow code; provider adapters may translate platform mention syntax, but the controller should still operate on normalized command events.
- R5. Unauthorized actors must not gain new thread/project enumeration access through bare mentions or the New shortcut.
- R6. Documentation and tests must reflect that bare leading mentions are now a help/menu entry point rather than ordinary text.

## Scope Boundaries

- In scope: command catalog/controller changes, help action rendering, bare leading mention normalization in messaging providers, provider command registration where a new command is exposed, controller/provider tests, and messaging operator docs.
- In scope: treating `new` as a command shortcut for the existing new-thread browser.
- Out of scope: redesigning the resume browser, changing new-thread options, adding a new persistent session type, changing authorization policy, or adding provider-specific workflow branches.
- Out of scope: making every non-leading mention actionable. Non-leading mentions should continue to route as ordinary text/media unless a provider already has a platform-native app-mention event that marks it as directed at the bot.

## Context & Research

### Relevant Code and Patterns

- `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts` owns `MESSAGING_COMMAND_CATALOG`, `MessagingCommandVerb`, `formatMessagingCommandHelpBody`, `paginateHelpCatalog`, and `buildHelpActions`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts` dispatches normalized command events in `handleCommand`, renders help through `presentHelp`, and renders the resume/new-thread browser through `presentResumeBrowser`.
- `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts` already parses `--new` into `launchAction: "start_new_thread"` and `mode: "new_project"`, and renders a new-thread project picker.
- `apps/desktop/src/main/__tests__/messaging-command-catalog.test.ts`, `apps/desktop/src/main/__tests__/messaging-controller.test.ts`, and `apps/desktop/src/main/__tests__/messaging-resume-browser.test.ts` cover the command catalog, help surface, callback routing, and resume/new-thread browser behavior.
- `packages/messaging/providers/telegram/src/telegram-adapter.ts`, `packages/messaging/providers/discord/src/discord-adapter.ts`, `packages/messaging/providers/mattermost/src/mattermost-adapter.ts`, and `packages/messaging/providers/slack/src/slack-adapter.ts` normalize leading bot mentions before dispatching to the desktop controller.
- `docs/messaging-architecture.md` documents the canonical command catalog and help action row as the source of truth for command discoverability.
- `docs/messaging-platform-integration.md` documents mention-command behavior and manual smoke flows.

### Institutional Learnings

- `docs/plans/2026-04-30-002-feat-messaging-command-surfaces-plan.md` established `/resume` as the primary browser entry point and the New browser mode as an existing command-surface responsibility.
- `docs/plans/2026-05-04-002-feat-messaging-capability-discovery-plan.md` established that resume/help pagination should honor provider capability profiles rather than hardcoded button counts.
- `docs/solutions/2026-05-07-codex-permission-mode-state-machine.md` is only tangentially relevant, but its messaging takeaway applies: cross-surface behavior should stay parity-oriented and flow through shared controller paths instead of one-off UI refresh logic.

### External References

- Not used. Existing repository patterns and docs are sufficient for this bounded messaging-command change.

## Key Technical Decisions

- **Normalize bare leading bot mentions to the help command at the adapter boundary.** This keeps provider syntax handling in providers while preserving the controller's channel-neutral command dispatch. A bare `@bot` should become the same normalized command event as `/help`; `@bot help` should continue to do the same.
- **Add `new` as a first-class command shortcut, backed by the existing resume-browser new mode.** This makes the New button catalog-driven and enables `/new` / `@bot new` as a natural text fallback. The handler should reuse the same code path as `/resume --new` so there is no duplicate new-thread flow.
- **Keep Resume as the primary help action and New as a prominent shortcut without changing browse-session semantics.** The help surface can show both actions, but the browser still owns project selection, new-thread options, and thread creation.
- **Update native command registration where commands are registered from provider-owned lists.** Until provider registration lists are generated from `MESSAGING_COMMAND_CATALOG`, adding a command means updating Telegram, Discord, and Mattermost registration lists and tests. Slack does not auto-register slash commands in this repo; it should get mention-command coverage, slash-command normalization coverage, and operator-doc updates for manually configured slash commands.
- **Fail closed through existing authorization checks.** Bare mentions and `new` commands should pass through the same provider authorization and controller browse-session scoping as `/help` and `/resume`.

## Open Questions

### Resolved During Planning

- **Should this add a separate New flow?** No. Use the existing resume browser's `start_new_thread` launch action.
- **Should workflow code branch on Telegram, Discord, Mattermost, or Slack mention syntax?** No. Providers normalize mention syntax; the controller sees command events.
- **Should a non-leading mention become help?** No. Only leading mentions or platform-native app mention events should trigger the help entry point.

### Deferred to Implementation

- Whether each provider helper should return an empty remainder for bare mentions or expose a separate `isBareBotMention` helper is an implementation detail. The observable contract is what matters: bare leading bot mention dispatches normalized help.
- Exact button ordering after adding New should be validated against capability-profile pagination. The intended order is Resume, New, Status, Detach, Help unless implementation discovers a stronger existing ordering convention.

## Implementation Units

- [x] **Unit 1: Add the New command shortcut to the catalog and controller**

**Goal:** Make New a supported command/help action that opens the existing new-thread browser mode.

**Requirements:** R2, R3, R4

**Dependencies:** None.

**Files:**
- Modify: `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts`
- Modify: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-command-catalog.test.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-controller.test.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-resume-browser.test.ts`

**Approach:**
- Extend the canonical command verb set with `new` and add a one-line catalog description that clearly means "start a new thread".
- Route the `new` verb in `MessagingController.handleCommand` to `presentResumeBrowser` with the same effective args as `/resume --new`, or to a tiny helper that builds the equivalent parsed resume-browser state.
- Keep `parseResumeCommandArgs(["--new"])` as the source of truth for new-thread browser state instead of hand-building a separate session shape.
- Ensure command-button callbacks for `command:new` dispatch through the same normalized command path as other help buttons.
- Revisit help action styling deliberately: keep `Resume` primary to preserve the existing hierarchy; make `New` neutral unless the surrounding command-catalog pattern already supports more than one primary action.

**Patterns to follow:**
- `handleCommand` dispatch pattern in `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Catalog-derived help body and actions in `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts`
- `/resume --new` parsing in `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts`

**Test scenarios:**
- Happy path: `/new` produces a `project_picker` intent whose prompt/fallback matches new-thread mode.
- Happy path: clicking `command:new` from the help surface produces the same new-thread project picker as `/resume --new`.
- Happy path: `/help` actions include `command:new` in the intended order with no help nav buttons under the permissive capability profile.
- Edge case: constrained capability profiles paginate help actions without dropping New or rendering impossible nav/action counts.
- Regression: `/resume`, `/resume --new`, `command:resume`, and `command:help` retain existing behavior.

**Verification:**
- The help menu exposes New as a button and as a text command, and both routes land in the existing new-thread project picker.

- [x] **Unit 2: Normalize bare leading bot mentions to help across providers**

**Goal:** Make a bare leading mention such as `@PwrAgent`, `<@bot_id>`, or a Slack `app_mention` with no remaining text dispatch as help instead of plain unbound text or no-op.

**Requirements:** R1, R4, R5, R6

**Dependencies:** Unit 1 if provider tests assert the final help action set includes New.

**Files:**
- Modify: `packages/messaging/providers/telegram/src/telegram-adapter.ts`
- Modify: `packages/messaging/providers/discord/src/discord-adapter.ts`
- Modify: `packages/messaging/providers/mattermost/src/mattermost-adapter.ts`
- Modify: `packages/messaging/providers/slack/src/slack-adapter.ts`
- Test: `packages/messaging/providers/telegram/src/__tests__/telegram-mention.test.ts`
- Test: `apps/desktop/src/main/__tests__/telegram-adapter.test.ts`
- Test: `packages/messaging/providers/discord/src/__tests__/discord-adapter.test.ts`
- Test: `packages/messaging/providers/mattermost/src/__tests__/mattermost-adapter.test.ts`
- Test: `packages/messaging/providers/slack/src/__tests__/slack-adapter.test.ts`

**Approach:**
- Adjust each provider's leading-mention helper or dispatch branch so it can distinguish "not a bot mention" from "bot mention with empty remainder".
- Dispatch bare leading bot mentions as normalized command events with `command: "help"`, `args: []`, and `rawText` equivalent to `/help`.
- Preserve existing `@bot resume`, `@bot help`, and caption-with-command behavior.
- Preserve non-leading mention behavior. A message like `hello @bot` should not become a command unless the platform explicitly delivered it as a directed app-mention event and the existing adapter semantics already treat it as directed.
- Keep provider authorization checks in the same order as existing mention-command handling so unauthorized actors do not get thread/project data.

**Patterns to follow:**
- Existing mention-command normalization in Telegram, Discord, Mattermost, and Slack adapters.
- Existing adapter tests for `@bot help`, `@bot resume`, non-leading mentions, and unauthorized command handling.

**Test scenarios:**
- Happy path: bare leading Telegram mention from an authorized actor emits a normalized `help` command event.
- Happy path: bare leading Discord mention token emits a normalized `help` command event.
- Happy path: bare leading Mattermost `@pwragent` emits a normalized `help` command event.
- Happy path: bare Slack `app_mention` emits a normalized `help` command event instead of being dropped.
- Regression: `@bot resume` still emits `resume`, `@bot help foo bar` still emits `help` with args, and attachment captions with recognized commands still route to command handling.
- Edge case: `@pwragent2` or a different Discord user mention does not match this bot.
- Error path: unauthorized bare mentions follow the existing unauthorized command behavior and do not enumerate threads or projects.

**Verification:**
- Authorized bare mentions now reach the same controller path as `/help`; unauthorized bare mentions remain blocked before workflow data is exposed.

- [x] **Unit 3: Update provider command registration and messaging docs**

**Goal:** Keep user-visible command surfaces and docs in sync with the new `new` shortcut and bare-mention behavior.

**Requirements:** R2, R6

**Dependencies:** Units 1 and 2.

**Files:**
- Modify: `packages/messaging/providers/telegram/src/telegram-adapter.ts`
- Modify: `packages/messaging/providers/discord/src/discord-commands.ts`
- Modify: `packages/messaging/providers/mattermost/src/mattermost-commands.ts`
- Modify: `packages/messaging/providers/slack/src/slack-adapter.ts` for mention/slash normalization tests only; Slack slash-command registration remains operator-managed
- Modify: `docs/messaging-architecture.md`
- Modify: `docs/messaging-platform-integration.md`
- Test: `apps/desktop/src/main/__tests__/telegram-adapter.test.ts`
- Test: `apps/desktop/src/main/__tests__/discord-adapter.test.ts`
- Test: `packages/messaging/providers/mattermost/src/__tests__/mattermost-commands.test.ts`
- Test: `packages/messaging/providers/slack/src/__tests__/slack-adapter.test.ts`

**Approach:**
- Add `new` to provider-owned native command registration lists wherever this repo currently registers provider commands: Telegram, Discord, and Mattermost.
- For Slack, do not invent automatic registration. Document the manually configured `/pwragent_new` slash command option and verify that existing prefix normalization dispatches it as `new` when operators configure it.
- Update tests that assert registered command names, descriptions, and Mattermost trigger normalization.
- Update messaging docs to say:
  - bare leading mention shows help,
  - `@bot <verb>` remains the command-mention form,
  - `/new` and the New help button open new-thread project selection,
  - `/resume --new` remains supported.
- Update manual smoke steps for Telegram/Discord/Mattermost/Slack where relevant so a tester verifies bare mention -> help -> New.

**Patterns to follow:**
- Provider command registration sections in `docs/messaging-platform-integration.md`
- Canonical command catalog section in `docs/messaging-architecture.md`

**Test scenarios:**
- Happy path: Telegram command registration includes `new` with a description consistent with the catalog.
- Happy path: Discord application command reconciliation includes `new`.
- Happy path: Mattermost desired commands include prefixed and bare `new` as appropriate.
- Happy path: Slack slash-command normalization accepts `/pwragent_new` as `new` when an operator has configured that slash command in Slack.
- Regression: existing registered commands remain present and ordered predictably.

**Verification:**
- Docs and provider registration tests agree with the runtime command catalog.

## System-Wide Impact

- **Interaction graph:** Provider mention parsing normalizes platform input into command events; `MessagingController.handleCommand` routes `help`, `new`, and `resume`; help action callbacks route back through command handling; the resume browser owns the new-thread project picker and subsequent browse session state.
- **Error propagation:** Provider authorization should reject unauthorized bare mentions before controller dispatch. Resume-browser/backend errors for New should use existing recoverable error intents.
- **State lifecycle risks:** The New shortcut creates the same browse session shape as `/resume --new`; no new persistent state is introduced.
- **API surface parity:** The command catalog and provider registration lists must stay in sync until registration can be generated from the shared catalog.
- **Integration coverage:** Unit tests should cover controller behavior with fake intents plus provider-level mention normalization for Telegram, Discord, Mattermost, and Slack.
- **Unchanged invariants:** Workflow code remains platform-neutral; providers still own platform syntax; adapter callback payloads remain opaque; authorization remains stable-ID based.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Provider helpers conflate "not a mention" with "bare mention" | Introduce an explicit parse result or helper contract so tests can distinguish both states. |
| Adding `new` as a canonical command drifts provider registration lists | Update all provider-owned command lists and tests in the same implementation unit; document the sync requirement remains until a catalog-generation refactor exists. |
| Help pagination changes on low-button providers | Add catalog/help tests with constrained capability profiles that include the new action count. |
| Bare mention behavior changes a previously documented plain-text path | Update docs and tests explicitly; keep non-leading mentions as ordinary text to limit behavior change. |
| Unauthorized users discover workflow data through a friendlier mention path | Reuse existing authorization checks and add provider tests for unauthorized bare mentions. |

## Documentation / Operational Notes

- Update `docs/messaging-platform-integration.md` manual smoke steps so testers verify bare mention help and the New shortcut on configured providers.
- Mention that Telegram clients may cache the command menu after adding `/new`; the existing command-menu caching note still applies.

## Sources & References

- Origin document: `docs/brainstorms/2026-04-30-messaging-platform-integration-requirements.md`
- Existing command-surface plan: `docs/plans/2026-04-30-002-feat-messaging-command-surfaces-plan.md`
- Capability-profile plan: `docs/plans/2026-05-04-002-feat-messaging-capability-discovery-plan.md`
- Messaging architecture: `docs/messaging-architecture.md`
- Messaging operator docs: `docs/messaging-platform-integration.md`
- Related code: `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts`
- Related code: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Related code: `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts`
- Related code: `packages/messaging/providers/telegram/src/telegram-adapter.ts`
- Related code: `packages/messaging/providers/discord/src/discord-adapter.ts`
- Related code: `packages/messaging/providers/mattermost/src/mattermost-adapter.ts`
- Related code: `packages/messaging/providers/slack/src/slack-adapter.ts`
