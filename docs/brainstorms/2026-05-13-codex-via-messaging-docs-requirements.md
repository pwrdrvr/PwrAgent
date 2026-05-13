---
date: 2026-05-13
topic: codex-via-messaging-docs
---

# Codex via Messaging — docs site structure

## Problem Frame

The current `docs.pwragent.ai` site (landed in PR #377) covers
**configuration**: per-provider setup, the streaming anti-feature, and
the webhook security note. It does not cover **usage** — how a person
who has paired a messenger actually runs a Codex thread from it.

The 14 sub-topics the operator-facing audience needs (authorization
model, slash/button/at-mention invocation, what a bound thread is,
rate limits, the resume browser, the new-thread starter, debounce /
queue / steer, the start card, the first prompt, the skills browser,
monitor cards, detach, archive-detach) are largely **shared across
providers**. Each provider has at most a small set of exceptions —
e.g. Mattermost can't route slash commands from inside a channel
thread back to the thread, so buttons are preferred there.

The current `messaging/overview.md` was an early attempt at a
concepts page and now duplicates a lot of what the usage guide should
own. Site nav also reads as "messaging configuration" when the
headline operator story is "how to drive Codex from your messenger."

## Requirements

- **R1.** A single user-facing guide page titled "Using Codex via
  Messaging" (URL: `/using-codex/`) covering the 14 sub-topics in a
  lifecycle order. Per-provider exceptions appear as collapsed-by-default
  `<details>` blocks (or compact tables) inline next to the section
  they qualify, not in a separate provider matrix.
- **R2.** A dedicated `/rate-limits/` reference page that the usage
  guide, `streaming`, `webhook-dangers`, and per-provider pages can all
  deep-link to. Carries the platform-by-platform rate-limit numbers
  (Telegram supergroup ~20 msg+edits/min, DM ~60 msg+edits/min, Slack
  edit/post split, Discord buckets, Mattermost server-configured,
  LINE per Bot API).
- **R3.** Top-level nav restructures from
  `[Messaging | Streaming | Webhooks | GitHub]` to
  `[Using Codex | Providers | Streaming | Webhooks | GitHub]`.
  - "Using Codex" → `/using-codex/`
  - "Providers" → `/providers/` (an index listing the six platform
    pages); existing `messaging/{telegram,discord,slack,mattermost,
    feishu,line}.md` move to `/providers/<platform>/`.
  - "Streaming" and "Webhooks" move to top level (`/streaming/`,
    `/webhook-dangers/`) since they're cross-cutting references.
- **R4.** `messaging/overview.md` is **folded into** the usage guide,
  not preserved as a separate page. Its useful content (bindings,
  authorization, commands, status card, typing, slow mode, attachments,
  where state lives) reappears inside the appropriate lifecycle
  sections of the usage guide.
- **R5.** Each sub-topic's per-provider exception block is a
  collapsed `<details>` with a single summary line and a compact table.
  Default (collapsed) state is "this works the same way everywhere";
  open state lists exceptions only. No provider gets a row when its
  behavior matches the shared case.
- **R6.** The usage guide is structured as four lifecycle sections
  plus a reference appendix, in this order:
  - **Access and invocation** — Who Can Talk (R1.1), Slash Commands +
    Buttons (R1.2), At-Mention Commands (R1.3)
  - **Starting a thread** — What is a Bound Thread (R1.4), Resume
    Thread Browser (R1.5), New Thread Starter (R1.6), Start Card
    Buttons (R1.7), First Prompt (R1.8), Skills Browser (R1.9)
  - **During a turn** — Debounce / Queue / Steer (R1.10), Monitor the
    Situation (R1.11)
  - **Ending or rebinding** — Detach (R1.12), Archive auto-detach
    (R1.13)
- **R7.** Old URLs (`/messaging/*`) get jekyll-redirect-from entries
  pointing at the new locations so external links don't break. The
  `github-pages` gem already includes `jekyll-redirect-from`.

### Detailed sub-topic content notes

| # | Sub-topic | Core points the section must cover |
|---|---|---|
| R1.1 | Who Can Talk to the Bot | DMs require user-allowlist; shared spaces require user-allowlist AND space-allowlist (two-keyed). Inviting the bot doesn't authorize anyone. Being in an allowlisted space doesn't authorize a user. Unauthorized attempts are denied and logged in Messaging Activity. |
| R1.2 | Slash Commands and Buttons | The canonical slash commands (`/resume`, `/new`, `/status`, `/detach`, `/monitor`, `/help`) on each platform. Per-provider exception: Mattermost can't route slash commands invoked inside a channel thread back to that thread (v10.x omits `root_id`); buttons are preferred there. |
| R1.3 | At-Mention Commands | `@botname resume`, `@botname new`, etc. Works without registered slash commands. Bare `@botname` shows the help menu with Resume/New buttons. Telegram requires `getMe()` to succeed; Discord requires `applicationId` configured for mention parsing. |
| R1.4 | What is a Bound Thread | Once a thread is bound, raw text and at-mention text to the bot routes **directly to the Codex thread**, bypassing any intermediate agent. You are using Codex directly. Multi-binding: one thread, multiple platform conversations. |
| R1.5 | Resume Thread Browser | Activated by `/resume`. Paginated browser with Prev/Next, Projects, New, Cancel. Selecting a thread binds the conversation to it. Text-fallback (reply with the row number) works on every provider. Per-provider exception: page size adapts to the provider's button budget (Telegram=8, Discord=8, text-only providers=20). |
| R1.6 | New Thread Starter | Activated by `/new` or from the help-menu New button. Project picker → start card. |
| R1.7 | Start Card Buttons | Before sending the first prompt: change model, reasoning effort, Fast mode, permissions mode (Default Access / Full Access) from the buttons on the start card. Each is per-thread (carries forward, unlike Codex Desktop's global-only settings). |
| R1.8 | First Prompt | Sending text after the start card completes the bind and starts the first turn. The first-prompt content goes into the new thread directly. |
| R1.9 | Skills Browser | How to open the skills browser, how to prepend a prompt with a chosen skill, how to use the search action. Skills act as prompt prefixes — same behavior across providers. |
| R1.10 | Debounce / Queue / Steer | Default 500 ms debounce catches platforms that split long messages. Tunable via `input_debounce_ms`. Sending two messages mid-turn produces a queued-notice with quoted preview + Steer / Cancel buttons. Steer injects the queued input into the current turn when Codex allows; Cancel drops it; doing nothing submits as a new turn FIFO on completion. Buttons clear automatically once handled. |
| R1.11 | Monitor the Situation | Attaching a monitor card to a thread. Per-thread vs. global monitor. How the monitor surface stays in sync with desktop. |
| R1.12 | Detaching a Thread | `/detach` from the conversation, or right-click "Unbind" on the desktop chip. Detach is platform-agnostic — single pipeline. The status card retires; the conversation falls back to the help menu on next message. |
| R1.13 | Archiving Thread in Desktop | Archiving a bound thread from the desktop automatically detaches all of its bindings. Same single detach pipeline. |

### Rate-limits reference (R2) content notes

- **Telegram.** DMs ~60 msg+edits/min. Supergroups ~20 msg+edits/min,
  shared across topics (binding two active threads to topics in the
  same supergroup will exhaust the budget). Edit calls return 429 with
  `retry_after` when exhausted.
- **Slack.** `chat.postMessage` has its own write limit; `chat.update`
  is separately rate-limited; DM edits are more permissive than
  Telegram in our probes (60 edits/min in DM passed without 429).
- **Discord.** Edit bucket reported as 5 requests / 1 second; route and
  global REST buckets apply.
- **Mattermost.** Server-configured — check the target server's
  `RateLimitSettings`. No SaaS-wide default.
- **Feishu / Lark.** Tenant-scoped; not yet measured in PwrAgent probes.
- **LINE.** Edits not supported at all; streaming is a no-op. Bot API
  send limits apply.
- **PwrAgent budget protection.** Slow Mode kicks in near budget and
  preserves critical traffic (approval prompts, final assistant text,
  turn completion) by dropping non-critical traffic (streaming edits,
  routine status-card refreshes, intermediate tool updates). Cool Off
  is provider-imposed and pauses sends until the retry window clears.

## Success Criteria

- A first-time visitor lands on `/using-codex/`, reads top-to-bottom,
  and ends the session knowing how to bind a thread, run a turn,
  steer mid-turn, and detach — without having read any per-provider
  page.
- Each of the 14 sub-topics has a stable URL anchor that other docs
  and external write-ups can deep-link to.
- A reader following `streaming.md` → "rate limits" link lands on
  `/rate-limits/`, not on a section inside `streaming.md`.
- The per-provider pages stay focused on **setup**; they link forward
  to `/using-codex/` for usage rather than re-explaining commands.
- `messaging-docs-links.test.ts` still passes after the URL moves
  (after updating the test's expected file set if any of the four
  `docs/messaging-*.md` repo files are removed — but those are
  contributor docs, not site source, so they shouldn't change).
- No content from the existing `messaging/overview.md` is silently
  lost — every concept finds a home in the usage guide or the
  rate-limits reference.

## Scope Boundaries

- **Not changing** the per-provider setup pages' content. They keep
  their "What you need to get started" → "Step by step" → "Settings
  reference" structure. Only their URLs move (`/messaging/X` →
  `/providers/X`).
- **Not building** a TOC sidebar component or a search box. The
  in-page anchor TOC at the top of `/using-codex/` is sufficient.
  More elaborate nav infra is `#311` territory.
- **Not building** sub-pages under `/using-codex/`. One long page is
  the deliberate shape (locked in earlier in the brainstorm).
- **Not redesigning** the existing site theme. The Tangerine Terminal
  styling from PR #377 carries forward.
- **Not adding** screenshots in this initial pass. Messenger-side
  captures are tracked at [pwrdrvr/PwrAgent#345](https://github.com/pwrdrvr/PwrAgent/issues/345).
  Desktop-side captures (start card, resume browser, skills browser,
  monitor card) can be added later; reference them by name only for
  v1.
- **Not building** a localization story. English only.

## Key Decisions

- **Single long guide + dedicated rate-limits page** (vs. multi-page
  section) — confirmed during brainstorm. Single URL is best for
  Cmd-F skim and external linking; rate limits gets its own URL
  because it's referenced from multiple places and is the most
  reference-shaped chunk.
- **Top-level nav: `[Using Codex | Providers | Streaming | Webhooks |
  GitHub]`** — confirmed during brainstorm. Hoists the usage story to
  the headline.
- **`messaging/overview.md` is folded into the guide** (not preserved
  as a "concepts" page). Default proposal; surfaceable in review if
  the planner wants to argue for keeping a separate concepts page.
- **Per-provider exceptions render as collapsed `<details>` blocks
  inline next to the section they qualify** (not in a single matrix
  page). Closer to the question being asked at read time.
- **Existing `/messaging/*` URLs get redirects via
  `jekyll-redirect-from`** rather than being left to 404. The plugin
  is already in the `github-pages` gem bundle.

## Dependencies / Assumptions

- PR #377 is the working baseline. The styling, the existing per-page
  content, and the `docs-site/` structure carry forward. This work
  builds on PR #377 (or against `main` if PR #377 lands first).
- Pages-served Jekyll supports `<details>` / `<summary>` (it does —
  they're plain HTML and pass through Markdown).
- `jekyll-redirect-from` is available without extra Gemfile changes
  beyond what `github-pages` already pulls in.

## Outstanding Questions

### Resolve Before Planning

(none — every product decision is captured above)

### Deferred to Planning

- **[Affects R3][Technical]** When the per-provider pages move from
  `/messaging/` to `/providers/`, do existing in-page cross-references
  (e.g., `[Mattermost](mattermost.md)` in the webhook-dangers doc)
  need to be rewritten to absolute paths, or do Jekyll's relative-link
  resolutions still work cleanly? Likely a small sweep.
- **[Affects R2][Needs research]** Feishu / Lark rate limits weren't
  in the May 2026 PwrAgent probes. The rate-limits page should still
  reference Feishu — does planning surface this as a TODO inline, or
  as an issue to file?
- **[Affects R6][Technical]** The "Monitor the Situation" sub-topic
  (R1.11) is the section I have the least context for from the brief.
  Planning should grep the codebase for monitor-card behavior (likely
  in `apps/desktop/src/main/messaging/core/messaging-renderer.ts` or
  similar) and write that section from concrete behavior, not from
  this brainstorm summary.
- **[Affects R1.7][Technical]** Confirm during planning which
  settings are actually exposed on the start card (model, reasoning,
  fast, permissions) vs. only after thread start. The brief says
  "Changing access mode, model, reasoning, fast mode, etc before
  start" — need to verify against the actual implementation.
- **[Affects R5][Needs research]** For the per-provider exception
  blocks, what's the actual delta on each section? Most sections
  probably have zero exceptions; a few (commands-in-Mattermost-threads,
  Discord status-card-degradation, LINE no-edits) are known. Planning
  should enumerate the real deltas by reading each adapter's behavior
  notes in `docs/messaging-platform-integration.md` (historical, now
  trimmed) and `docs/messaging-architecture.md`.

## Next Steps

→ `/ce:plan` for structured implementation planning.
