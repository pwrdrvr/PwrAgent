# Messaging Platform Integration

PwrAgent's **operator-facing setup guide** for messaging platforms now
lives at **<https://docs.pwragent.ai/messaging/>**. That site is the
single source of truth for:

- Setup walkthroughs per platform (Telegram, Discord, Slack,
  Mattermost, Feishu/Lark, LINE).
- "What you need to get started" and the exact paste/save/test/pair
  flow from the desktop Settings → Messaging panel.
- Settings reference: what each field above and below the Test button
  does, defaults, and when you'd change them.
- The streaming-responses tradeoff
  (<https://docs.pwragent.ai/messaging/streaming/>).
- The webhook security note for HTTP-callback platforms
  (<https://docs.pwragent.ai/messaging/webhook-dangers/>).

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
