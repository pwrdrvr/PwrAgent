---
date: 2026-05-04
topic: messaging-capability-discovery
---

# Messaging Capability Discovery and Adaptive Rendering

## Problem Frame

PwrAgent's messaging integration supports Telegram and Discord today, with Mattermost, Signal, Slack, and Feishu/Lark on the near-term horizon. These platforms differ significantly in what they can render: Signal is text-only, Telegram supports ~100 inline keyboard buttons, Discord caps at 25, Slack uses Block Kit with its own constraints, and Mattermost has interactive message attachments with different limits.

Currently, button counts and layout limits are hardcoded inside each provider adapter, and message producers (pickers, questionnaires, approvals) generate actions without knowing what any connected provider can render. The `MessagingAdapterCapabilities` type only covers attachment constraints. There is no mechanism for producers to discover connected providers' rendering capabilities, no way to generate content adapted to different capability levels, and no multi-variant delivery path.

Adding each new provider without a capability system means either: (a) producers accumulate platform-awareness they shouldn't have, or (b) new providers get a degraded experience because producers generated content for a different platform's limits.

## Requirements

### Capability Profile

- R1. Each messaging provider must declare a capability profile covering four dimensions: action constraints, action layout support, text/formatting limits, and attachment capabilities.
- R2. Action constraints must express at minimum: maximum action count per message, maximum actions per row, maximum rows (if limited), maximum label length, and whether disabled/styled actions are supported.
- R3. Layout capabilities must express whether the provider supports explicit row/column placement, row breaks, full-width actions, or only a flat action list.
- R4. Text capabilities must express at minimum: maximum message length, how the limit is measured (UTF-8 bytes vs UTF-16 code units vs characters), supported markdown dialect, and which formatting features are available (code blocks, bold, links, images).
- R5. Attachment capabilities must be unified into the same profile, replacing the current standalone `MessagingAdapterCapabilities` type. The existing attachment capability fields (inbound/outbound, max sizes, file/image/URL support) are preserved.
- R6. A profile value of "no action support" (e.g., Signal) must be expressible and distinct from "limited action support."

### Capability Discovery and Tier Bucketing

- R7. Producers must be able to query the set of distinct capability profiles across all providers currently connected to a message target, before building any intent content.
- R8. Profiles that are identical or sufficiently similar must be deduplicated into capability tiers so that producers generate at most one intent variant per unique tier, not per provider.
- R9. The query API must not expose platform names. Producers receive abstract capability profiles, never "telegram" or "discord" identifiers.
- R10. A text-only baseline tier must always be present, regardless of which providers are connected. This ensures every message has a text rendering for logging, archival, and text-only providers.

### Multi-Tier Intent Generation

- R11. Producers must generate one `MessagingSurfaceIntent` per unique capability tier returned by the discovery query, plus always the text baseline.
- R12. Each tier's intent is tailored to that tier's constraints. For example, a thread picker on an 8-action tier shows 4 list items + 4 nav buttons with pagination, while a 25-action tier shows 20 items + 5 nav buttons.
- R13. The messaging system must accept a set of tier-keyed intents from the producer and route each provider the intent matching its capability tier.
- R14. Producers must never branch on platform name or channel kind. All adaptation is driven by the abstract capability profile.

### Progressive Enhancement

- R15. Producers should implement to the lowest-effort tier first (text) and progressively add richer tiers. A producer that only generates a text variant is valid — providers with button support simply render the text version.
- R16. Layout hints on actions remain "take or leave it." Producers may specify row/column/width preferences; providers apply what they support and ignore the rest. This is the existing `MessagingActionLayoutHint` behavior, preserved.
- R17. Producers that want rich column layouts for capable platforms add those layout hints in addition to (not instead of) a simpler flat-button variant for less capable platforms. The tier system makes this natural — the rich layout is just another tier's intent.

### Mattermost Provider

- R18. Implement a Mattermost messaging adapter that declares its capability profile and covers the same intent surface as Telegram and Discord: thread/project binding, pickers, approvals, questionnaires, status panels, streaming responses, and text fallback.
- R19. The Mattermost adapter must be the first provider implemented against the capability profile system, validating that the system works for a new provider without producer changes.
- R20. The Mattermost adapter must follow the existing package boundary rules: isolated under `packages/messaging/providers/mattermost/`, importing only `@pwragent/messaging-interface` and the Mattermost SDK.

### Migration

- R21. Migrate the existing Discord and Telegram adapters to declare capability profiles using the new type, replacing hardcoded constants scattered across their formatting and component-building code.
- R22. Migrate existing producers (thread picker, project picker, single/multi select, questionnaire, approval, confirmation) to query capability tiers and generate per-tier intents.
- R23. The current `MessagingAdapterCapabilities` type is replaced by the capability profile. The existing attachment fields are preserved within the unified profile.

### Design Validation

- R24. The capability profile design must be validated against Signal (text-only, no buttons), Slack (Block Kit actions, sections, overflow menus), and Feishu/Lark (interactive cards with buttons and multi-column layouts) to confirm it can express their constraints without requiring structural changes.
- R25. Validation is design-time analysis, not implementation. These providers are not in scope for this work.

## Success Criteria

- Adding a new messaging provider requires only: implementing the adapter, declaring a capability profile, and registering in the provider loader. Zero producer code changes.
- Existing Telegram and Discord behavior is preserved after migration to capability profiles.
- The Mattermost adapter achieves full workflow parity (binding, pickers, approvals, questionnaires, text fallback) without any Mattermost-specific logic in producers.
- A text-only provider (like a future Signal adapter) can be added by declaring a no-actions profile and relying on the text baseline — no new producer code needed.

## Scope Boundaries

- In scope: capability profile type design, discovery/query API, multi-tier delivery, Mattermost adapter, migration of existing providers and producers.
- In scope: design-time validation against Signal, Slack, Feishu/Lark constraints.
- Out of scope: implementing Signal, Slack, or Feishu/Lark adapters.
- Out of scope: changes to the semantic intent types themselves (message, approval, picker, etc.). The intent shapes stay the same; what changes is how many variants are generated and how they're routed.
- Out of scope: UI changes in the desktop app. This is messaging infrastructure.
- Out of scope: voice/CarPlay integration or iOS app concerns.

## Key Decisions

- **Separate variants per tier, not provider-side degradation**: Producers generate tailored content per capability tier rather than generating one maximal intent that providers trim. This gives producers full control over how content adapts (e.g., pagination math, which items to show) without knowing platform names.
- **Pre-query, multi-intent delivery**: Producers call a discovery API before building intents, receive abstract capability profiles, and return a map of tier-keyed intents. The messaging system routes the right variant to each provider. This is a change from the current single-intent delivery model.
- **Capability profiles, not predefined tiers**: Tiers emerge from the actual capability profiles of connected providers, not from a hardcoded enum of "basic/standard/rich." This avoids premature categorization and handles unexpected provider capabilities naturally.
- **Text baseline always present**: Every message produces a text rendering regardless of connected providers. This serves text-only platforms, logging, and archival.
- **Unified capability profile replaces `MessagingAdapterCapabilities`**: One type covers actions, layout, text, and attachments. No reason to keep attachment capabilities separate.

## Dependencies / Assumptions

- The existing messaging interface, adapter contract, and provider package boundaries are stable and proven by Telegram + Discord.
- The `layoutMessagingActionRows` utility in the interface package can be reused for providers that support row-based button layout, parameterized by the capability profile.
- Mattermost's bot/webhook API supports interactive message attachments with buttons and callback actions. Exact limits and SDK choice are planning-phase research.
- The callback handle persistence model (already used by Telegram for restart safety) generalizes to any provider that needs durable callback mappings.

## Outstanding Questions

### Resolve Before Planning

(None — the product model is clear. Remaining questions are technical and better answered during planning with codebase exploration.)

### Deferred to Planning

- [Affects R1][Technical] Exact TypeScript shape of the capability profile type and where it lives in the interface package.
- [Affects R8][Technical] How tier bucketing works — hash-based deduplication, named canonical tiers, or something else.
- [Affects R13][Technical] How the multi-intent delivery map threads through `MessagingController` to each adapter. The current `deliver(intent)` signature accepts one intent; this needs to change.
- [Affects R18][Needs research] Mattermost interactive message API: action limits per attachment, callback payload size, markdown dialect, attachment upload constraints, supported bot frameworks.
- [Affects R22][Technical] How to migrate existing producers incrementally. Can the old single-intent path coexist with multi-tier during migration, or is it a flag day?
- [Affects R24][Needs research] Slack Block Kit action limits, Feishu/Lark interactive card constraints, and Signal messaging capabilities — needed for design validation.
- [Affects R5][Technical] Whether the attachment capability fields need additional dimensions (e.g., max caption length for Telegram photos, inline image embed support) when unified into the profile.

## Next Steps

→ `/ce:plan` for structured implementation planning
