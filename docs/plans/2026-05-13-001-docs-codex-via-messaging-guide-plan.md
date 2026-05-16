---
title: "docs: Codex via Messaging usage guide + site restructure"
type: docs
status: completed
date: 2026-05-13
origin: docs/brainstorms/2026-05-13-codex-via-messaging-docs-requirements.md
---

# Codex via Messaging usage guide + site restructure

## Overview

Ship the operator-facing "Using Codex via Messaging" guide on
`docs.pwragent.ai`, restructure the site's top-level nav to lead with
usage rather than configuration, and add a dedicated `/rate-limits/`
reference page. Fold `messaging/overview.md` into the new guide. Move
the six per-provider setup pages from `/messaging/` to `/providers/`.
Add `jekyll-redirect-from` aliases so existing external links still
resolve.

This is one PR. Scope is large but additive (one big new page, one new
reference, URL renames behind redirects, no code or runtime changes).
Expect ~2500 lines of new content. Origin: [docs/brainstorms/2026-05-13-codex-via-messaging-docs-requirements.md](../brainstorms/2026-05-13-codex-via-messaging-docs-requirements.md).

## Problem Statement / Motivation

The Pages site that landed in PR #377 covers per-provider configuration
and two anti-feature / safety notes (streaming, webhooks). It does not
cover **usage** — how someone who has already paired a messenger
actually runs a Codex thread from it. The brainstorm captured 14
sub-topics that operate the same way across providers, with a small
known set of per-provider exceptions. The current `messaging/overview.md`
was an early concepts page that now duplicates most of what the usage
guide should own. Site nav reads as "messaging configuration" when the
headline operator story should be "how to drive Codex from your messenger."

(See origin: [§Problem Frame](../brainstorms/2026-05-13-codex-via-messaging-docs-requirements.md))

## Proposed Solution

Three new pages, one rename pass, one fold:

| Output | URL | Source path | Size |
|---|---|---|---|
| **Using Codex via Messaging** (NEW) | `/using-codex/` | `docs-site/using-codex.md` | ~1500–2000 lines |
| **Rate Limits and Budgets** (NEW) | `/rate-limits/` | `docs-site/rate-limits.md` | ~250–350 lines |
| Providers index (NEW) | `/providers/` | `docs-site/providers/index.md` | ~60 lines |
| Telegram (RENAME) | `/providers/telegram/` | `docs-site/providers/telegram.md` | unchanged content |
| Discord (RENAME) | `/providers/discord/` | `docs-site/providers/discord.md` | unchanged content |
| Slack (RENAME) | `/providers/slack/` | `docs-site/providers/slack.md` | unchanged content |
| Mattermost (RENAME) | `/providers/mattermost/` | `docs-site/providers/mattermost.md` | unchanged content |
| Feishu / Lark (RENAME) | `/providers/feishu/` | `docs-site/providers/feishu.md` | unchanged content |
| LINE (RENAME) | `/providers/line/` | `docs-site/providers/line.md` | unchanged content |
| Streaming (MOVE) | `/streaming/` | `docs-site/streaming.md` | unchanged content |
| Webhooks (MOVE) | `/webhook-dangers/` | `docs-site/webhook-dangers.md` | unchanged content |
| Overview (DELETE) | — | `docs-site/messaging/overview.md` deleted | content folded into using-codex.md |

Nav restructures from `[Messaging | Streaming | Webhooks | GitHub]` to
`[Using Codex | Providers | Streaming | Webhooks | GitHub]`. (See
origin: [§Requirements R3](../brainstorms/2026-05-13-codex-via-messaging-docs-requirements.md))

## Technical Considerations

### Jekyll / GitHub Pages mechanics

- **Redirects.** Use the `jekyll-redirect-from` plugin (already in the
  `github-pages` gem bundle). Add a `redirect_from:` array to each
  renamed page's front matter listing its old URL(s). Pages are
  generated as `<old-url>/index.html` containing a meta-refresh.
- **`<details>` / `<summary>`** render natively in kramdown without
  any special markdown — they're plain HTML and pass through. Verified
  by spot-checks in tests against the local preview container.
- **`permalink: pretty`** stays. New pages get URLs like
  `/using-codex/` (no trailing `.html`). Anchor links inside the page
  use kebab-case heading IDs (Jekyll's default).
- **No new theme work.** The Tangerine Terminal styling from PR #377
  carries forward. The hero wordmark on the landing page is unaffected.

### Anchor URL contract

Each of the 13 surviving sub-topics (sub-topic 9 cut — see Risks)
gets a stable kebab-case anchor in the guide. Anchors are part of the
contract — external write-ups and the rate-limits page will deep-link
to them.

| Sub-topic | Anchor |
|---|---|
| Who Can Talk to the Bot | `#who-can-talk` |
| Slash Commands and Buttons | `#slash-commands-and-buttons` |
| At-Mention Commands | `#at-mention-commands` |
| What is a Bound Thread | `#what-is-a-bound-thread` |
| Resume Thread Browser | `#resume-thread-browser` |
| New Thread Starter | `#new-thread-starter` |
| Start Card Buttons | `#start-card-buttons` |
| First Prompt | `#first-prompt` |
| Debounce / Queue / Steer | `#debounce-queue-steer` |
| Monitor Card | `#monitor-card` |
| Detaching a Thread | `#detaching-a-thread` |
| Archiving a Thread | `#archiving-a-thread` |

The rate-limits page gets `#telegram`, `#discord`, `#slack`,
`#mattermost`, `#feishu`, `#line`, `#pwragent-budget-protection` as
its anchors.

### Per-sub-topic implementation notes

For each sub-topic, the writer should:
1. Read the listed source files for the authoritative behavior.
2. Write the shared-behavior body.
3. Wrap any per-provider exception in a single `<details>` block
   whose summary is "Per-provider exceptions" and whose body is a
   compact table listing only providers that deviate.

The block:

```html
<details>
<summary>Per-provider exceptions</summary>

| Provider | Deviation |
|---|---|
| Mattermost | … |

</details>
```

**Source files per sub-topic** (lifted from local research; all paths
relative to repo root):

#### R1.1 Who Can Talk to the Bot — `#who-can-talk`

- `apps/desktop/src/main/messaging/core/messaging-controller.ts:431-446` — `isAuthorized` gate at line 432; "Not authorized" intent path.
- `apps/desktop/src/main/messaging/messaging-config.ts:187-265` — per-provider allowlist key map (`authorizedActorIds` + conversation-scoped keys: `authorizedSupergroupIds`, `authorizedGuildIds`, `authorizedConversationIds`+`authorizedTeamIds`, `authorizedChatIds`+`authorizedTenantKeys`, `authorizedGroupIds`+`authorizedRoomIds`).
- `packages/messaging/CLAUDE.md` — "fail-closed authorization" rule. Empty allowlist denies.
- `apps/desktop/src/main/state/state-db.ts:104` — `messaging_activity_log` table; this is where rejected actor IDs surface in Settings → Messaging → Activity.
- **Key correction**: allowlists live in `~/.pwragent/profiles/<name>/config.toml`, not sqlite. Bindings live in sqlite (`bindings` table at `state-db.ts:16-28`); allowlists do not.
- **Exception**: none. Shared pipeline.

#### R1.2 Slash Commands and Buttons — `#slash-commands-and-buttons`

- `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts:46-99` — canonical verbs (`resume`, `new`, `status`, `detach`, `monitor`, `help`).
- `packages/messaging/providers/telegram/src/telegram-adapter.ts:568` — Telegram `setMyCommands`.
- `packages/messaging/providers/discord/src/discord-adapter.ts:1218-1229` — Discord HTTP commands API; **silently skips registration if `applicationId` missing**.
- `packages/messaging/providers/mattermost/src/mattermost-commands.ts:258+` and `mattermost-adapter.ts:323, 505-540` — per-team Mattermost reconciliation.
- `packages/messaging/providers/mattermost/src/mattermost-adapter.ts:1130-1163` — **slash-in-channel-thread routing**: handles `rootId` in `body.context`, sets `conversationKind = "thread"` so the binding lives on the channel-thread, not the parent channel.
- **Exceptions**: Mattermost slash-in-thread routing (covered above); Discord silently no-ops slash without `applicationId`.

#### R1.3 At-Mention Commands — `#at-mention-commands`

- `packages/messaging/providers/telegram/src/telegram-adapter.ts:537-555` — `getMe` captures bot username.
- `packages/messaging/providers/telegram/src/telegram-adapter.ts:1134-1175` — `@<botusername> <verb>` parse runs before slash dispatch.
- `packages/messaging/providers/telegram/src/telegram-adapter.ts:418-425` — getMe-fail comment: mention parsing silently disabled until next restart.
- `packages/messaging/providers/discord/src/discord-adapter.ts:754-820` — Discord `<@applicationId> <verb>` parser; bare `<@bot>` from media captions is *not* a help trigger (line 805 comment).
- `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts:101-127` — help-body rendering.
- **Exceptions**: Telegram requires `getMe` success at startup; Discord requires `applicationId` configured.

#### R1.4 What is a Bound Thread — `#what-is-a-bound-thread`

- `apps/desktop/src/main/messaging/core/messaging-controller.ts:860, 923, 938` — `handleText` → `findActiveBindingForChannel` → `turnAdmission.append`. This is the "bypass intermediate agent" path.
- `apps/desktop/src/main/state/state-db.ts:16-28` — `bindings` table.
- **Key beat**: once bound, raw text routes *directly* to the Codex thread, bypassing any intermediate agent. You are using Codex directly.
- **Exception**: none.

#### R1.5 Resume Thread Browser — `#resume-thread-browser`

- `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts:23` — `RESUME_BROWSER_PAGE_SIZE = 8`.
- `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts:27-38` — `resumeBrowserPageSize` (delegates to `capabilityProfilePageSize(profile, 5, 8)`).
- `packages/messaging/interface/src/index.ts:1070, 1073-1089` — `DEFAULT_TEXT_MODE_PAGE_SIZE = 20` and `capabilityProfilePageSize`.
- **Brainstorm correction**: all six shipping providers have an `actions` capability, so the resolved page size is **8 on every provider including LINE (13 − 5 = 8)**. The `20` constant is unreachable today (no text-only provider). Do not document "20 for text-only" as if it's a real surface.
- `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts:56-200` — `--projects`, `--new`, `--fast`, `--yolo`, `--model` arg parser.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:880-902` — text-fallback ("reply with row number").
- **Exception**: none for page size (all 8). Mention text-fallback works on every provider.

#### R1.6 New Thread Starter — `#new-thread-starter`

- `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts:74-78` — `mode: "new_project"` branch.
- `apps/desktop/src/main/state/state-db.ts:40-47` — `browse_sessions` table (pending-session state).
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:1020-1031` — start-card gate (`MessagingBrowseSessionRecord` with `launchAction === "start_new_thread"`).
- **Exception**: none.

#### R1.7 Start Card Buttons — `#start-card-buttons`

- `apps/desktop/src/main/messaging/core/messaging-status-card.ts:177-217` — four button rows: `status:model`, `status:reasoning`, `Fast: on/off`, `Permissions: …`.
- `apps/desktop/src/main/messaging/core/messaging-status-card.ts:793-825` — model picker.
- `apps/desktop/src/main/messaging/core/messaging-status-card.ts:48-160` — `buildBindingStatusIntent` shared between start card and bound-thread status card.
- `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts:65` — `MessagingBindingPreferences` (preferences are merged into the eventual thread).
- **Critical content note**: the **Permissions** button **queues** a mid-turn access-mode change to apply at the end of the current turn, *not* immediately. See `docs/solutions/2026-05-07-codex-permission-mode-state-machine.md`. Do not describe this button as "toggle takes effect immediately" — that was the old, deprecated UX.
- **Exception** (capability-driven, not provider-specific): on providers with tight `maxActions` budgets, lowest-priority model and reasoning rows drop first. Worst offenders: LINE (`maxActions: 13`, label cap `20`), Feishu (`maxActions: 20`, label cap `20`), Mattermost (label cap `40`). Reference `applyActionCapabilityLimits` in `packages/messaging/interface/src/index.ts:1120-1140` and per-adapter capability profiles. **Do not call this a "Discord deviation"** — that's wrong; Discord is one of the better cases.

#### R1.8 First Prompt — `#first-prompt`

- `apps/desktop/src/main/messaging/core/messaging-controller.ts:1033-1085` — `appendPendingNewThreadPrompt`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:3300-3360` — `backend.startThread` call.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:6644-6660` — `boundThreadConfirmationBody`.
- **Exception**: none.

#### R1.9 Skills Browser — **CUT FROM v1**

- **No messaging-layer implementation exists today.** Grep for "skill" across `apps/desktop/src/main/messaging/` and `packages/messaging/` returns nothing. The brainstorm listed this as in-scope, but there is no source file to cite.
- **Decision**: cut from v1 of the guide. Surface as an explicit `Outstanding` item below so it gets picked up when implemented.
- **Do not write a "planned behavior" section.** Documenting features that don't exist creates support-burden and undermines the rest of the guide's authority.

#### R1.10 Debounce / Queue / Steer — `#debounce-queue-steer`

- `apps/desktop/src/main/messaging/core/messaging-controller.ts:137` — `DEFAULT_INPUT_DEBOUNCE_MS = 500`.
- `apps/desktop/src/main/messaging/core/messaging-turn-admission.ts` (entire file, 230 lines) — state machine; `enqueue`, `findQueuedEntry`, `updateQueuedEntry`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:1359-1442` — `queuePreparedInput` → `deliverQueuedTurnNotice`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:6971` — 500-char quoted preview.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:1399-1406` — `canSteerQueuedTurn` (Steer is only available when `backend.steerTurn` exists AND turn status is `working` or `waiting`).
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:1444+` — `handleQueuedTurnCallback`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:4330-4360` — FIFO drain (`queueAuditKey` keyed by `backend + threadId`).
- **CRITICAL distinction**: this is the **text-turn queue**. There is also a separate **permission-mode queue** (documented in `apps/desktop/CLAUDE.md` "Permission-mode queue events" and `docs/solutions/2026-05-07-codex-permission-mode-state-machine.md`). The guide must NOT conflate them. Two separate queueing concepts; two separate Cancel buttons; two separate audit-message lifecycles.
- **Exception**: LINE can't edit the queued-notice card in place — `present_new` fallback. Same `supportsMessageEdit: false` mechanic as everywhere else; flag in the per-provider exceptions block for the section.

#### R1.11 Monitor Card — `#monitor-card`

- **What it is**: a long-lived status card per binding, refreshed every 60 s (default). The only messaging surface that runs on a timer.
- `apps/desktop/src/main/messaging/core/messaging-monitor-card.ts` — engine (463 lines).
- `messaging-monitor-card.ts:26-38` — defaults: `MESSAGING_MONITOR_INTERVAL_MS = 60_000`, interval options `[10s, 30s, 60s, 5m]`, pinned-limit 5, recent-limit 5, snippet 100 chars.
- `messaging-monitor-card.ts:50-118` — `buildMonitorStatusIntent` (pinned-section + recent-section + button row).
- `messaging-monitor-card.ts:216-260` — action ids: `monitor:stop`, `monitor:refresh`, `monitor:pins`, `monitor:recent`, `monitor:interval`, `monitor:status`, `monitor:snippet`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:405-415` — `startMonitoringForEnabledBindings` boots monitors on app start by walking `monitor_subscriptions`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:3437-3500, 6095-6110` — action handlers and cycle helpers.
- `apps/desktop/src/main/state/state-db.ts:146-158` — `monitor_subscriptions` table.
- `messaging-monitor-card.ts:85-88` — `canUpdateSurface` gate; LINE falls through to `present_new` because `supportsMessageEdit: false`.
- `docs/plans/2026-05-11-001-feat-messaging-monitor-command-plan.md` — the implementation plan for the `/monitor` command.
- **Key beats for the guide**:
  - `/monitor` posts a card that subscribes the binding to periodic refreshes. The card edits in place (or fresh-posts on LINE) every interval tick.
  - "Attached to thread" actually means "attached to the binding"; archiving the thread auto-detaches the binding which stops the monitor (`messaging-controller.ts:4653`).
  - Per-binding controls: interval cycle, snippet length, pinned/recent toggles, stop.
- **Exception**: LINE posts a fresh monitor card every tick instead of editing in place.

#### R1.12 Detaching a Thread — `#detaching-a-thread`

- `apps/desktop/src/main/messaging/core/messaging-controller.ts:4605-4623` — `detachBinding` (slash entry) → `runDetachPipeline`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:4636-4678` — `runDetachPipeline`. Steps: interrupt active turn → flush tool updates → stop monitoring → retire status card → revoke binding in store → record transition → emit `notifyBindingChanged("detach")` → deliver "Thread detached".
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:4680-4699` — `handleBindingRevokeRequest` (right-click "Unbind" IPC entry) uses the same pipeline.
- `docs/messaging-architecture.md:276-282` — single platform-agnostic detach pipeline contract.
- **Exception**: none. Pipeline is platform-agnostic.

#### R1.13 Archiving a Thread — `#archiving-a-thread`

- Archive → revoke fan-out via `requestBindingRevoke` bus event. Bus emit on archive lives in `apps/desktop/src/main/index.ts` and `apps/desktop/src/main/app-server/backend-registry.ts` (greppable for `requestBindingRevoke`).
- `apps/desktop/src/main/messaging/core/messaging-controller.ts:4693` — `runDetachPipeline(binding, undefined)` on each matching controller.
- **Key beat**: archiving a bound thread automatically detaches *every* binding on it, with no per-provider code. Second consumer of the single pipeline; same observable behavior as `/detach`.
- **Exception**: none.

### Rate-limits page content

The `/rate-limits/` page covers, in order:

1. **What PwrAgent budget protection does** (Slow Mode and Cool Off semantics — drop non-critical traffic first, keep approval prompts / final assistant / turn completion). Anchor `#pwragent-budget-protection`.
2. **Per-platform measured limits** — one section per provider. Anchors `#telegram`, `#discord`, `#slack`, `#mattermost`, `#feishu`, `#line`.

Source data from May 9 2026 probes already lives in
[docs/messaging-platform-integration.md (historical, now trimmed)](../docs/messaging-platform-integration.md)
and `docs/plans/2026-05-09-001-feat-messaging-rate-limit-slow-mode-plan.md`.
The user-confirmed numbers are also already documented in
[docs-site/messaging/streaming.md](../docs-site/messaging/streaming.md);
move those into `rate-limits.md` and replace the streaming-page table
with a link to the rate-limits anchor.

| Surface | Practical write budget | Note |
|---|---|---|
| Telegram DM | ~60 msg+edits/min | shared sends + edits |
| Telegram supergroup | ~20 msg+edits/min | shared across topics |
| Slack DM | edits permissive (60 edits/min passed without 429) | `chat.postMessage` has its own limit |
| Discord DM/channel | edits permissive; bucket 5 req / 1 s | route + global REST buckets apply |
| Mattermost | server-configured | check `RateLimitSettings` |
| Feishu/Lark | tenant-scoped; not measured in May 2026 probes | flag as TODO |
| LINE | edits not supported; Bot API send limits | streaming no-op |

Each provider section also includes the **label-cap** for that
provider (Telegram 64, Discord 80, Slack 75, Mattermost 40, Feishu 20,
LINE 20) since labels truncate when budget pressure forces lower
fidelity rendering, and the cap is what determines what fits.

### Site structure changes

The PR makes these file-system changes:

```
docs-site/
├── _config.yml                # nav update only
├── _layouts/default.html      # nav menu update only
├── index.md                   # add "Using Codex" link in opening
├── using-codex.md             # NEW (the big guide)
├── rate-limits.md             # NEW
├── streaming.md               # MOVED from messaging/streaming.md, redirect_from added
├── webhook-dangers.md         # MOVED from messaging/webhook-dangers.md, redirect_from added
├── providers/
│   ├── index.md               # NEW (lists six platforms)
│   ├── telegram.md            # MOVED from messaging/telegram.md, redirect_from added
│   ├── discord.md             # MOVED from messaging/discord.md, redirect_from added
│   ├── slack.md               # MOVED from messaging/slack.md, redirect_from added
│   ├── mattermost.md          # MOVED from messaging/mattermost.md, redirect_from added
│   ├── feishu.md              # MOVED from messaging/feishu.md, redirect_from added
│   └── line.md                # MOVED from messaging/line.md, redirect_from added
└── messaging/
    └── overview.md            # DELETED (content folded into using-codex.md, redirect to using-codex)
```

Each moved or deleted page's old URL gets a `redirect_from:` front
matter entry. Example for `streaming.md`:

```yaml
---
layout: page
title: Streaming responses
redirect_from:
  - /messaging/streaming/
  - /messaging/streaming
---
```

`jekyll-redirect-from` is already in the `github-pages` gem bundle so
no `Gemfile` changes are needed. Confirm by running the local Docker
preview after the move.

### Internal-link sweep

Inside the moved pages, in-page references like
`[Mattermost](mattermost.md)` will still resolve through relative
paths inside the same directory (`providers/` → `providers/`), so
those are fine. Cross-directory links like
`[overview](overview.md)` inside `streaming.md` need to be rewritten
to `[Using Codex via Messaging](using-codex/)` once overview is folded.

The internal-link sweep checklist (relative paths from `docs-site/`):

- `streaming.md` → links to `overview.md`, `mattermost.md`, `line.md`, etc.
- `webhook-dangers.md` → links to `mattermost.md`, `line.md`, `overview.md`.
- Each `providers/<platform>.md` → links to `overview.md`, `streaming.md`, `webhook-dangers.md`.
- `index.md` → updated to link to `/using-codex/` first, then `/providers/`.

Grep before commit: `grep -r "messaging/" docs-site/ | grep -v _site/ | grep -v Gemfile`.

### Nav and layout updates

`docs-site/_layouts/default.html` site-nav update:

```html
<nav class="site-nav" aria-label="Top navigation">
  <a href="{{ '/using-codex/' | relative_url }}">Using Codex</a>
  <a href="{{ '/providers/' | relative_url }}">Providers</a>
  <a href="{{ '/streaming/' | relative_url }}">Streaming</a>
  <a href="{{ '/webhook-dangers/' | relative_url }}">Webhooks</a>
  <a class="site-nav__github" href="https://github.com/pwrdrvr/PwrAgent" rel="noopener">GitHub →</a>
</nav>
```

## System-Wide Impact

- **Interaction graph.** This PR is docs-only — no `apps/desktop/`
  code paths change, no IPC events fire, no database state mutates.
  The only "interactions" are HTTP redirects served by GitHub Pages
  for the old `/messaging/*` URLs.
- **Error propagation.** Only relevant failure mode: a broken
  internal link or a missed `redirect_from:`. Mitigation: pre-merge
  link sweep + local Docker preview verify.
- **State lifecycle risks.** None. No persisted state changes.
- **API surface parity.** The repo-internal contributor doc
  [docs/messaging-platform-integration.md](../docs/messaging-platform-integration.md)
  is *not* touched in this PR — it was already trimmed in PR #377.
  Confirm it still passes `apps/desktop/src/main/__tests__/messaging-docs-links.test.ts`
  (it must, because the test only checks for the file's existence and
  its `(messaging-adapter-contract.md)` cross-link, both of which
  survive).
- **Integration test scenarios.**
  1. Visit `https://docs.pwragent.ai/messaging/telegram/` (old URL) → redirects to `/providers/telegram/`.
  2. Visit `https://docs.pwragent.ai/messaging/overview/` (deleted page) → redirects to `/using-codex/`.
  3. Visit `https://docs.pwragent.ai/using-codex/#monitor-card` → loads guide page scrolled to the monitor section.
  4. Visit `https://docs.pwragent.ai/streaming/#telegram-rate-limits` (or wherever the rate-limit link points) → redirects to `/rate-limits/#telegram`.
  5. Click "Using Codex" in nav from any page → lands on `/using-codex/`.

## Acceptance Criteria

- [ ] `docs-site/using-codex.md` exists, covers 13 sub-topics (sub-topic 9 cut), uses the 13 anchor names listed above, and renders in the local Docker preview without warnings.
- [ ] Each sub-topic that has a real per-provider deviation has a single `<details>` block with the deviation table. No `<details>` block for sub-topics where all providers behave identically.
- [ ] `docs-site/rate-limits.md` exists with the seven anchors (`#telegram`, `#discord`, `#slack`, `#mattermost`, `#feishu`, `#line`, `#pwragent-budget-protection`).
- [ ] `docs-site/streaming.md` no longer carries its own rate-limit table; the streaming page links to `/rate-limits/` for that content.
- [ ] All six per-provider pages live under `docs-site/providers/` with `redirect_from:` entries for their old `/messaging/<platform>/` URLs.
- [ ] `docs-site/streaming.md` and `docs-site/webhook-dangers.md` live at the top level with `redirect_from:` for their old `/messaging/<page>/` URLs.
- [ ] `docs-site/messaging/overview.md` is deleted; a redirect-only stub at its old URL (or a `redirect_from:` on `using-codex.md`) ensures `/messaging/overview/` resolves to `/using-codex/`.
- [ ] `docs-site/providers/index.md` lists the six platforms with one-line descriptions and links.
- [ ] `docs-site/_layouts/default.html` nav updated to `[Using Codex | Providers | Streaming | Webhooks | GitHub]`.
- [ ] `docs-site/index.md` lead-section updated to point at `/using-codex/` first.
- [ ] No internal link in `docs-site/` resolves to a `/messaging/*` path. (Manual `grep -r "messaging/" docs-site/ | grep -v _site` returns nothing after the sweep.)
- [ ] Local Docker preview (`docker build -t pwragent-docs-site:local docs-site/ && docker run …`) renders all new pages with HTTP 200 and the new nav is visible.
- [ ] [apps/desktop/src/main/__tests__/messaging-docs-links.test.ts](../apps/desktop/src/main/__tests__/messaging-docs-links.test.ts) **still passes** — it checks `docs/messaging-*.md` repo files, none of which are touched in this PR.
- [ ] `apps/desktop/AGENTS.md` and root `AGENTS.md` (already point at `docs-site/`) require no edits — confirm in the PR.

## Success Metrics

- A first-time visitor lands on `/using-codex/`, reads top-to-bottom,
  and can bind a thread + run a turn + steer mid-turn + detach without
  visiting a per-provider page.
- External write-ups can deep-link to any of the 13 sub-topic anchors
  and the link stays stable across future doc edits.
- The brainstorm's two correction items (sub-topic 9 cut, page-size
  corrected to 8-across-the-board) make it into the published guide.
- Operators understand the **distinction** between the text-turn
  queue and the permission-mode queue (the
  [docs/solutions/2026-05-07-codex-permission-mode-state-machine.md](../docs/solutions/2026-05-07-codex-permission-mode-state-machine.md)
  warning is reflected, not glossed).

## Dependencies & Risks

- **Risk: Skills Browser cut creates a brainstorm-to-plan delta.**
  Mitigation: surface it loudly in the plan (here) and in an explicit
  `Outstanding` block on the merged PR. Future implementers can find
  it.
- **Risk: Per-provider deviations are subtler than the brainstorm
  enumerated.** Mitigation: the research already surfaced the six
  real ones (Mattermost slash-in-thread, Discord applicationId-required,
  Telegram getMe-required, LINE no-edits, Mattermost label-cap-40,
  capability-driven status-card degradation). Writer follows the
  cross-cutting exception list above.
- **Risk: Permission-mode-queue vs. text-turn-queue conflation.** This
  is the single highest-risk content trap. The
  [docs/solutions/2026-05-07-codex-permission-mode-state-machine.md](../docs/solutions/2026-05-07-codex-permission-mode-state-machine.md)
  solution doc warns explicitly. Mitigation: a callout at the top of
  `#debounce-queue-steer` distinguishing the two; cross-link to where
  permission-mode queueing actually lives (`#start-card-buttons` for
  pre-start changes; a brief note on mid-turn permission changes
  separately).
- **Risk: `jekyll-redirect-from` breaks pretty-permalink routing.**
  Mitigation: covered by `github-pages` gem; verify in the local
  Docker preview before commit. Old URLs `/messaging/foo` and
  `/messaging/foo/` (with and without trailing slash) both need entries
  in `redirect_from:`.
- **Risk: Length.** Single ~2000-line page may feel intimidating.
  Mitigation: the page opens with a TOC of the 13 sub-topics so
  Cmd-F / anchor-jumping is the natural reading mode. Decision was
  locked in during brainstorm.
- **Risk: Future feishu/lark rate-limit numbers.** No probes exist
  for Feishu. Mitigation: rate-limits page calls this out explicitly
  in a "not yet measured" beat for that section. File a follow-up
  issue (see Outstanding below).

## Implementation Phases

### Phase 1 — Site restructure (URL moves, redirects, nav)

1. Move `docs-site/messaging/{telegram,discord,slack,mattermost,feishu,line}.md` → `docs-site/providers/<platform>.md`. Add `redirect_from:` to each.
2. Move `docs-site/messaging/streaming.md` → `docs-site/streaming.md`. Add `redirect_from:`.
3. Move `docs-site/messaging/webhook-dangers.md` → `docs-site/webhook-dangers.md`. Add `redirect_from:`.
4. Create `docs-site/providers/index.md` with the six-platform listing.
5. Update `docs-site/_layouts/default.html` nav to the new top-level set.
6. Internal-link sweep across `docs-site/` (the grep checklist above).
7. Verify in local Docker preview: every old URL redirects, every new URL renders 200.
8. **Commit:** `docs: restructure docs-site nav around 'Using Codex'`.

### Phase 2 — Rate-limits reference page

1. Create `docs-site/rate-limits.md` with the seven anchors.
2. Lift the rate-limit table out of `docs-site/streaming.md` (replace it with a one-line link).
3. Lift the rate-limit content from `docs/messaging-platform-integration.md` (historical content) and the May 9 plan.
4. Add per-platform sections including label-caps.
5. Mark Feishu as "not yet probed" with a TODO note.
6. **Commit:** `docs(rate-limits): add dedicated rate-limits reference page`.

### Phase 3 — Using Codex guide content

This is the bulk of the work. Order suggestion (skip-friendly — each
sub-topic is independent, write them in any order):

1. Page scaffold + opening + in-page TOC linking 13 anchors.
2. Sub-topics in lifecycle order R1.1 → R1.4 → R1.5 → R1.6 → R1.7 → R1.8 → R1.10 → R1.11 → R1.12 → R1.13.
3. Sub-topics that come last because they're cross-cutting: R1.2 (slash) and R1.3 (mention) — they reference the catalog and frame "you can also use…" for several other sections.
4. For each sub-topic, follow the source-file checklist above before writing.
5. Add the cross-cutting `<details>` exception blocks for the six known deviations.
6. **Commits**: one per cluster — `docs(using-codex): write access and invocation sections`, `…starting-a-thread sections`, `…during-a-turn sections`, `…ending-or-rebinding sections`. Don't squash; reviewer can read them in order.

### Phase 4 — Fold and remove overview

1. Walk through `docs-site/messaging/overview.md` section by section. Each section either:
   - Already covered in `using-codex.md` (skip).
   - Should be added to `using-codex.md` in the appropriate sub-topic (move).
   - Is concept-only and not in any sub-topic (Slow Mode / Cool Off → goes into `rate-limits.md`; Attachments → small new sub-section in `using-codex.md` after R1.8).
2. Delete `docs-site/messaging/overview.md`.
3. Add `redirect_from: /messaging/overview/` to `docs-site/using-codex.md`'s front matter.
4. Internal-link sweep for any remaining `overview.md` references.
5. **Commit:** `docs(using-codex): fold overview into the new guide`.

### Phase 5 — Final verification

1. Run the local Docker preview end to end. Click every nav link, every redirect, every anchor.
2. Run [apps/desktop/src/main/__tests__/messaging-docs-links.test.ts](../apps/desktop/src/main/__tests__/messaging-docs-links.test.ts) — confirm still passes.
3. Update the root `README.md` if its "Going deeper" section references any old `/messaging/*` URLs (it shouldn't — it points at the docs.pwragent.ai root — but verify).
4. PR title: `docs: 'Using Codex via Messaging' guide + docs-site nav restructure`. PR body summarises the move + new pages + the sub-topic 9 deferral.

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-05-13-codex-via-messaging-docs-requirements.md](../brainstorms/2026-05-13-codex-via-messaging-docs-requirements.md). Key decisions carried forward: single-page guide + dedicated rate-limits page (R1 + R2); top-level nav restructure to `[Using Codex | Providers | Streaming | Webhooks | GitHub]` (R3); fold overview.md into the guide (R4); collapsed-by-default `<details>` exception blocks (R5).

### Internal references — codebase

- [apps/desktop/src/main/messaging/core/messaging-controller.ts](../../apps/desktop/src/main/messaging/core/messaging-controller.ts) — workflow orchestration; entry points for authorization, text routing, debounce/queue/steer, detach pipeline.
- [apps/desktop/src/main/messaging/core/messaging-command-catalog.ts](../../apps/desktop/src/main/messaging/core/messaging-command-catalog.ts) — canonical verbs + help-body rendering.
- [apps/desktop/src/main/messaging/core/messaging-status-card.ts](../../apps/desktop/src/main/messaging/core/messaging-status-card.ts) — start card + bound-thread status card.
- [apps/desktop/src/main/messaging/core/messaging-resume-browser.ts](../../apps/desktop/src/main/messaging/core/messaging-resume-browser.ts) — resume + new-thread project picker.
- [apps/desktop/src/main/messaging/core/messaging-monitor-card.ts](../../apps/desktop/src/main/messaging/core/messaging-monitor-card.ts) — `/monitor` card and refresh-tick engine.
- [apps/desktop/src/main/messaging/core/messaging-turn-admission.ts](../../apps/desktop/src/main/messaging/core/messaging-turn-admission.ts) — text-turn queue state machine.
- [apps/desktop/src/main/messaging/messaging-config.ts](../../apps/desktop/src/main/messaging/messaging-config.ts) — allowlist key map.
- [apps/desktop/src/main/state/state-db.ts](../../apps/desktop/src/main/state/state-db.ts) — `bindings`, `browse_sessions`, `monitor_subscriptions`, `messaging_activity_log` tables.
- [packages/messaging/interface/src/index.ts](../../packages/messaging/interface/src/index.ts) — `capabilityProfilePageSize`, `applyActionCapabilityLimits`.
- Per-provider capability profiles:
  - [packages/messaging/providers/telegram/src/telegram-adapter.ts](../../packages/messaging/providers/telegram/src/telegram-adapter.ts) (label cap 64)
  - [packages/messaging/providers/discord/src/discord-adapter.ts](../../packages/messaging/providers/discord/src/discord-adapter.ts) (label cap 80)
  - [packages/messaging/providers/slack/src/slack-adapter.ts](../../packages/messaging/providers/slack/src/slack-adapter.ts) (label cap 75)
  - [packages/messaging/providers/mattermost/src/mattermost-adapter.ts](../../packages/messaging/providers/mattermost/src/mattermost-adapter.ts) (label cap 40)
  - [packages/messaging/providers/feishu/src/feishu-adapter.ts](../../packages/messaging/providers/feishu/src/feishu-adapter.ts) (label cap 20)
  - [packages/messaging/providers/line/src/line-adapter.ts](../../packages/messaging/providers/line/src/line-adapter.ts) (label cap 20, `supportsMessageEdit: false`)

### Internal references — docs

- [docs/messaging-architecture.md](../messaging-architecture.md) — architectural context; canonical command catalog; single detach pipeline.
- [docs/messaging-adapter-contract.md](../messaging-adapter-contract.md) — per-adapter capability profile contract.
- [packages/messaging/CLAUDE.md](../../packages/messaging/CLAUDE.md) — fail-closed authorization rule; provider boundary rules.
- [apps/desktop/CLAUDE.md](../../apps/desktop/CLAUDE.md) — Thread-State Update Bus; Permission-mode queue events (load-bearing for sub-topic R1.10 and the R1.7 callout).
- [docs/solutions/2026-05-07-codex-permission-mode-state-machine.md](../solutions/2026-05-07-codex-permission-mode-state-machine.md) — **load-bearing**: the source of truth for how mid-turn permission toggles queue rather than apply immediately.

### Internal references — recent plans

- [docs/plans/2026-05-11-001-feat-messaging-monitor-command-plan.md](2026-05-11-001-feat-messaging-monitor-command-plan.md) — `/monitor` design.
- [docs/plans/2026-05-09-001-feat-messaging-rate-limit-slow-mode-plan.md](2026-05-09-001-feat-messaging-rate-limit-slow-mode-plan.md) — Slow Mode and Cool Off design + May 2026 probe results.
- [docs/plans/2026-05-11-001-docs-open-source-readme-architecture-split-plan.md](2026-05-11-001-docs-open-source-readme-architecture-split-plan.md) — predecessor README/ARCHITECTURE split.

### Related PRs / Issues

- [PwrAgent#377](https://github.com/pwrdrvr/PwrAgent/pull/377) — docs-site/ stand-up (the baseline this PR builds on).
- [PwrAgent#311](https://github.com/pwrdrvr/PwrAgent/issues/311) — full versioned-docs solution this PR is **explicitly not** doing.
- [PwrAgent#345](https://github.com/pwrdrvr/PwrAgent/issues/345) — messenger-side screenshots (separate scope).

## Outstanding / Deferred

1. **Skills Browser (R1.9) cut from v1.** No messaging-layer implementation exists. File a follow-up issue when the messaging skills surface lands; the guide should pick up an `#skills-browser` anchor then. Don't include a stub section in v1.
2. **Feishu/Lark rate limits unknown.** Rate-limits page calls this out as "not yet measured" with a pointer to file a follow-up probe issue.
3. **Future named-permission-profiles migration.** Codex upstream is migrating away from raw `approvalPolicy`/`sandboxPolicy` toward `PermissionProfileSelectionParams`. The guide should describe the **user-visible** behavior (Default Access vs. Full Access) and avoid baking in raw-field language — that future change will only require a thin edit.
4. **Provider-page link-back to using-codex.** Currently each per-provider page (`/providers/telegram/` etc.) carries setup-only content. As a polish pass after v1, each provider page should add a "See also: [Using Codex via Messaging](../using-codex/)" link near the top so visitors who land on the provider page first can find the usage guide. Optional; can land in the same PR if time allows.
5. **Visual screenshots of the surfaces named in the guide** (start card, resume browser, status card, monitor card, queued-turn notice). Not in scope for v1; tracked separately at [PwrAgent#345](https://github.com/pwrdrvr/PwrAgent/issues/345) for messenger-side captures. Desktop-side captures using the screenshot:readme tooling can follow as a polish PR.
