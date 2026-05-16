---
layout: page
title: Rate limits and budgets
permalink: /rate-limits/
---

# Rate limits and budgets

Every messaging platform PwrAgent supports has a write budget. The
budget caps how many messages plus edits the bot can send per
minute, per scope (DM, supergroup, channel, workspace). Hit it and the
platform returns a 429 with a retry window; PwrAgent's local Slow
Mode protects critical traffic until the budget recovers.

This page is the per-platform reference. It's deep-linked from
[Streaming responses](streaming/), the [Webhooks security note](webhook-dangers/),
each [provider setup page](providers/), and from inside the
[Using Codex via Messaging](using-codex/) guide. Update one place, the
rest pick it up.

The numbers below come from PwrAgent team probes in May 2026 and from
each platform's public documentation. They are **practical** budgets
— what actually held in probes, rounded down for safety, not the
upper-bound limits the platforms advertise.

## PwrAgent budget protection

PwrAgent uses two related-but-distinct protection states:

| State | Imposed by | What it does |
|---|---|---|
| **Slow Mode** | PwrAgent (local) | Kicks in when a scope nears its write budget. Preserves **critical traffic** — approval prompts, final assistant messages, the turn-completion summary, queued-turn notices — and drops or coalesces **non-critical traffic** — streaming edits, routine status-card refreshes, intermediate tool-update messages. |
| **Cool Off** | The platform (server-imposed) | Kicks in when a platform returns a rate-limit response (429 or equivalent) with a retry window. PwrAgent stops sending to that scope until the retry clears, then resumes conservatively. |

The Settings → Messaging status dot turns **orange** while either state
is active. The desktop's messaging activity log records each entry.

Priority order PwrAgent uses when shedding traffic in Slow Mode:

1. **Drop first:** streaming edits (least critical; the final
   assistant message will land regardless).
2. **Coalesce:** routine status-card refreshes (the latest card
   replaces queued earlier edits).
3. **Batch:** intermediate tool-update messages (per the binding's
   `Tools: <mode>` setting).
4. **Always send:** approval prompts, final assistant text, turn
   completion, queued-turn notices, detach confirmations.

This is also why [streaming](streaming/) is a net negative in most
configurations — its edits are the first thing Slow Mode sheds, so on
busy turns you'll watch streaming auto-disable mid-response anyway.

## Telegram

- **DM:** ~60 messages+edits per minute. Plenty for normal use, but
  a single streamed long turn can burn through it.
- **Supergroup:** ~20 messages+edits per minute, **shared across all
  topics in the supergroup**.

Sends and edits draw from the **same budget** on Telegram. Edit calls
return 429 with a `retry_after` value when the budget runs out. The
20 msg/min supergroup ceiling is the tightest practical budget of any
supported platform.

**Binding guidance for Telegram:**

- Active PwrAgent threads should usually be bound to **separate
  supergroups**. Binding two active threads to different topics inside
  one supergroup will exhaust that supergroup's budget and trigger
  Slow Mode.
- Bind read-mostly threads (status monitor, occasional check-ins) to
  topics if you want them grouped; bind heavy-work threads to their
  own supergroup.

**Label cap:** 64 characters. Long model names truncate at this
length on action buttons.

## Discord

- **DM and guild channels:** edits more permissive than Telegram. In
  May 2026 probes, 60 edits per minute on a single message in both
  DM and channel passed without a 429.
- **Edit bucket:** Discord returns a route bucket of 5 requests per
  1 second; route and global REST buckets apply.

Discord's actual rate-limit story is its REST bucket system. Sends
and edits count as REST requests; the per-route bucket plus the
per-app global bucket determine when you hit a 429. PwrAgent's
budget protection treats Discord as more permissive than Telegram
but does not assume infinite headroom.

**Label cap:** 80 characters. Most permissive of the supported
platforms.

## Slack

- **DM:** edits permissive. In May 2026 probes, 60 edits per minute
  on a single message in a DM passed without a 429.
- **`chat.postMessage`** has its own separate Web API rate limit;
  don't treat Slack as "free messages."
- **`chat.update`** is documented as a separately rate-limited
  method.

Sends and edits are tracked under different Slack rate-limit
categories, so the "edit until you drop" pattern that breaks Telegram
in seconds takes longer to bite on Slack — but it still bites.

**Label cap:** 75 characters.

## Mattermost

- **Server-configured.** Mattermost's rate limits come from each
  server's `RateLimitSettings` in `config.json`. There is no SaaS-wide
  default to point at; consult the target server.
- Workspaces with default limits typically allow more sends per
  minute than Telegram supergroups but less than the Slack DM
  ceiling.

If you operate the Mattermost server, the relevant settings are
`EnableRateLimiter`, `PerSec`, `MaxBurst`, `MemoryStoreSize`, and
`VaryByRemoteAddr`. Bot traffic shares the rate-limit pool with
regular user traffic.

**Label cap:** 40 characters. **Worst label cap of any supported
platform** — long model names truncate hardest here.

## Feishu / Lark {#feishu}

- **Tenant-scoped.** Limits apply per tenant (the workspace the app
  is installed in) and per app.
- **Not measured in PwrAgent's May 2026 probes.** The Feishu adapter
  shipped after the rate-limit probe pass. Treat conservatively until
  measured.

Outbound rate limits on Feishu's `im.message:send_as_bot` scope are
documented per-tenant and depend on tenant tier; consult the Open
Platform console for current values.

**Label cap:** 20 characters. Same as LINE — labels truncate to
near-icon length on dense status cards.

## LINE

- **Edits not supported.** LINE's Messaging API does not support
  editing previously sent messages. Each PwrAgent update — every
  refresh of the status card, every monitor tick, every queued-turn
  notice — posts a **fresh message**.
- **Send limits** apply per Bot API channel and depend on whether
  you're on a free Developer plan, Light plan, or Premium plan. The
  free plan limits the number of "push" messages per month; refer
  to the LINE Developers console for your channel's current quotas.

Because LINE has no edits, **streaming is a no-op on LINE**. The
Streaming Responses toggle has no effect — only the final assistant
message is posted as a regular LINE message regardless of setting.

**Label cap:** 20 characters. Long model names truncate hard.

## Summary table

| Platform | Practical send budget | Edit support | Label cap |
|---|---|---|---|
| Telegram DM | ~60 msg+edits/min | Yes (shares budget) | 64 |
| Telegram supergroup | ~20 msg+edits/min, shared across topics | Yes (shares budget) | 64 |
| Discord | Edits permissive; route bucket 5 req / 1 s | Yes (separate REST bucket) | 80 |
| Slack DM | Edits permissive; `chat.postMessage` has its own limit | Yes (separate Web API method) | 75 |
| Mattermost | Server-configured | Yes (counts as REST request) | 40 |
| Feishu / Lark | Tenant-scoped; not yet probed | Yes (documented per-tenant) | 20 |
| LINE | Per-channel Bot API quota | **Not supported** | 20 |

## See also

- [Streaming responses: why you probably don't want them](streaming/)
  — the first thing Slow Mode drops; rate limits are the load-bearing
  reason to leave streaming off.
- [Using Codex via Messaging](using-codex/) — bindings, status card,
  queued-turn notice, monitor card, detach. Every surface respects
  the budget protection described above.
- The per-provider setup pages under [providers/](providers/) cover
  per-platform connection and authorization mechanics.
