# Messaging Platform Integration

PwrAgent's **operator-facing documentation** for messaging now lives
at **<https://docs.pwragent.ai>**. That site is the single source of
truth for:

- **Setup** — per-platform setup walkthroughs at
  <https://docs.pwragent.ai/providers/> (Telegram, Discord, Slack,
  Mattermost, Feishu/Lark, LINE), each with "What you need to get
  started," the exact paste/save/test/pair flow, and Settings
  reference for every field above and below the Test button.
- **Usage** — bound threads, slash commands, at-mention commands,
  resume browser, new-thread starter, start card, debounce / queue
  / steer, monitor cards, detach, archive — all at
  <https://docs.pwragent.ai/using-codex/>.
- **Rate limits and budgets** —
  <https://docs.pwragent.ai/rate-limits/> with per-platform measured
  write budgets and PwrAgent's Slow Mode / Cool Off priority order.
- **The streaming-responses tradeoff** —
  <https://docs.pwragent.ai/streaming/>.
- **The webhook security note** for HTTP-callback platforms —
  <https://docs.pwragent.ai/webhook-dangers/>.

The Pages source for that site lives in the repo under
[`docs-site/`](../docs-site/).

## Contributor cross-references

For implementing or modifying a messaging adapter, the relevant docs
stay in this repo:

- The architectural story (layers, capability profile, callback
  delivery models, the canonical command catalog) lives in
  [`messaging-architecture.md`](messaging-architecture.md).
- The formal contract every adapter must satisfy lives in
  [`messaging-adapter-contract.md`](messaging-adapter-contract.md).
- The hands-on walkthrough for adding a new provider lives in
  [`messaging-adding-a-provider.md`](messaging-adding-a-provider.md).
- Package boundary rules and `pnpm lint:boundaries` enforcement live in
  [`packages/messaging/AGENTS.md`](../packages/messaging/AGENTS.md).

## New-thread backend selection smoke

The operator-facing `/new` walkthrough lives in
[`docs-site/using-codex.md`](../docs-site/using-codex.md), but
contributors changing messaging workflow should keep these checks in
sync with tests:

- With one create-capable backend, `/new`, **New** from `/help`, and
  `/resume --new` open the same project picker and Start Card without a
  Provider button.
- With multiple create-capable backends, the Start Card is seeded from
  the desktop launchpad sticky backend and includes a Provider button.
  Changing Provider re-renders Model, Reasoning, Fast, and related
  controls from that backend's advertised capabilities.
- Changing Provider or Model before the first prompt updates the
  desktop launchpad sticky defaults through `updateDirectoryLaunchpad`.
- Sending the first prompt creates the thread on the selected backend.
  After binding, the status card reports the backend identity and does
  not offer a Provider switch.

## Chat SDK decision (contributor context)

Vercel Chat SDK is not the runtime boundary for PwrAgent. The current
direction is a PwrAgent-owned semantic surface with direct adapters,
because markdown handling, image/media behavior, callback limits, and
voice-friendly text fallback are core requirements that don't fit a
generic chat-SDK abstraction cleanly. Chat SDK can be reconsidered
later as an adapter implementation detail if it matures without
requiring PwrAgent workflow changes.

## Related design context

- [Messaging requirements](brainstorms/2026-04-30-messaging-platform-integration-requirements.md)
- [Implementation plan](plans/2026-04-30-001-feat-messaging-platform-integration-plan.md)
