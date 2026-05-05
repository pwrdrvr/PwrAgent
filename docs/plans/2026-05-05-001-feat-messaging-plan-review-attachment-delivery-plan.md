---
title: "feat(messaging): Plan and Review surface delivery via Markdown attachment + inline preview"
type: feat
status: active
date: 2026-05-05
---

# Messaging Plan/Review Attachment Delivery

## Overview

Surface PwrAgent's plan-mode and review-mode artifacts to messaging users (Telegram, Discord, future Mattermost/Signal/Slack/Feishu) as a Markdown file attachment with a truncated inline preview, mirroring the proven pattern from openclaw-app-server. Falls back to a longer inline-only summary on platforms that cannot deliver attachments (`outboundAttachments` undefined, `supportsFileUpload: false`, or `maxUploadBytes` exceeded by the artifact).

## Problem Statement

Today, PwrAgent's messaging integration has no plan/review surface delivery:

- The status card hardcodes the literal string `"Plan mode: unavailable"` (`apps/desktop/src/main/messaging/core/messaging-status-card.ts:106`).
- The desktop messaging controller does not subscribe to `turn/plan/updated` events from the codex protocol.
- No producer in `apps/desktop/src/main/messaging/core/` ever emits a `MessagingFilePart`. The type and adapter delivery infrastructure exist but have no caller.
- `outboundAttachments` capability fields (`supportsFileUpload`, `maxUploadBytes`, `supportsImageUpload`, `supportsRemoteImageUrl`) are declared on Discord and Telegram profiles but read by no producer.

Compare to openclaw-app-server (referenced as the design pattern):
- `formatCodexPlanInlineText(plan)` — full inline rendering when the plan is short enough
- `formatCodexPlanAttachmentSummary(plan)` — title + explanation + steps + 1400-char preview, delivered alongside the markdown attachment
- `formatCodexPlanAttachmentFallback(plan)` — when attachment fails or is unsupported, longer 1800-char inline preview instead
- `buildPlanDelivery(plan)` — picks between inline-only / attachment+summary / fallback based on size and provider capability

This is a feature gap, not just dormant capability schema. The `outboundAttachments` declaration is intentional scaffolding for this work.

## Proposed Solution

### Producer: `buildPlanArtifactIntent`

A new producer in `apps/desktop/src/main/messaging/core/messaging-renderer.ts` (or a dedicated `messaging-plan-renderer.ts`) that takes a `PlanArtifact` and a `MessagingCapabilityProfile` and returns a `MessagingMessageIntent` carrying:

1. **Inline summary text** (the action bar can stay empty or carry `Implement plan` / `Stay in plan mode` choices when applicable).
2. **A `MessagingFilePart`** with the full plan as `text/markdown` when:
   - `profile.outboundAttachments?.supportsFileUpload === true`
   - The artifact's serialized markdown size is `≤ profile.outboundAttachments.maxUploadBytes` (when defined)
   - The full inline rendering would exceed `INLINE_FALLBACK_THRESHOLD` (e.g., 1400 chars to leave headroom for chat UI)

Three rendering modes, selected by capability + size:

| Mode | When | What ships |
|---|---|---|
| **Inline only** | Plan text fits below `INLINE_FALLBACK_THRESHOLD` | Single text body via `formatCodexPlanInlineText`-equivalent |
| **Attachment + summary** | Plan exceeds threshold AND adapter supports file upload AND size fits | Inline summary (≤ 1400 chars) + `MessagingFilePart` with markdown body |
| **Inline fallback** | Plan exceeds threshold but adapter cannot attach | Longer inline preview (≤ 1800 chars), explicit truncation marker |

Helper functions to add to `@pwragent/messaging-interface` (or co-located in the producer):
- `truncatePlanForInline(markdown, maxChars): string` — preserves heading boundaries, appends `[Preview truncated. Open the attachment for the full plan.]`
- `formatPlanAttachmentSummary(plan, maxPreviewChars)` — title + explanation + steps + bounded preview
- `formatPlanAttachmentFallback(plan, maxPreviewChars)` — fallback variant with explicit "couldn't attach" framing

### Controller wiring

Subscribe to `turn/plan/updated` (`TurnPlanUpdatedNotification`) and `turn/completed` notifications in `MessagingController`. The plan artifact is built up across deltas (`item/plan/delta`, `PlanDeltaNotification`) and finalized at `turn/completed` with the full structured `plan` array + optional `explanation`.

When a turn completes with a non-empty plan:
1. Build the structured `PlanArtifact` (steps + explanation + serialized markdown body).
2. For each active binding on this thread, call `buildPlanArtifactIntent({ plan, capabilityProfile: this.capabilityProfile })`.
3. Deliver via the existing `MessagingAdapter.deliver` path. The adapter's `uploadableFileParts` already routes `MessagingFilePart` to `sendDocument` (Telegram) / `attachments[]` (Discord).
4. Handle delivery failure: if the adapter returns a failed outcome on attachment delivery, retry with the inline-fallback intent.

### Status card integration

Replace the hardcoded `"Plan mode: unavailable"` line in `messaging-status-card.ts:106` with real status: idle vs. planning, link to last plan if present.

When the binding state has a recent plan artifact, the status card optionally shows an "Open plan" action that re-presents the plan delivery.

### Review mode

Same shape as plan mode but for code-review artifacts. The codex protocol does not currently emit a dedicated review notification — review mode is a forthcoming PwrAgent-specific concept. The producer signature should be generic enough to handle both:

```ts
buildArtifactDeliveryIntent({
  artifact: { kind: "plan" | "review", title, summary, steps?, markdown },
  capabilityProfile,
  // ...
})
```

Same three-mode rendering logic; differences are in title strings, action bar (e.g., "Implement plan" vs. "Approve review"), and the file extension/MIME type on the `MessagingFilePart`.

## Technical Considerations

### Architecture impacts
- Adds the first producer that emits a `MessagingFilePart`. Verifies the existing adapter file-upload paths in `discord-adapter.ts:386` and `telegram-adapter.ts:554` actually work end-to-end against real bot APIs.
- First consumer of `outboundAttachments` capability fields. Validates that the declared values are correct.
- New protocol subscriptions — controller starts handling `turn/plan/updated` events.

### Performance implications
- Plan markdown is generally short (a few KB). File upload per turn-completion is fine.
- Attachment delivery is async; the controller must not block on it before the user can continue typing.

### Security considerations
- Plan markdown comes from the agent — could contain user-supplied content via tool outputs. Treat as untrusted text. The existing adapter sanitization pipelines apply (Discord's `sanitizeDiscordContent`, Telegram's HTML escape).
- File names should not include thread IDs or other PII visible to the receiving messaging service if a chat is shared with non-authorized members. Use generic names like `plan-<short-hash>.md`.
- Temp file handling (if we materialize attachments to disk first, mirroring openclaw): ensure the temp dir is per-user state, mode 0o700, cleaned up after delivery.

### State lifecycle
- Plan artifacts may be re-delivered on demand (status card "Open plan" action). Decide: store the artifact in the binding record? In a new `messaging_plan_artifacts` table keyed by `(binding, turnId)`? Or just regenerate from thread history each time?
- Review artifacts are likely tied to a specific turn or PR-like artifact — needs its own state shape.

### API surface parity
- Desktop UI should also surface the plan in the renderer thread view. This plan doc covers messaging only; the desktop renderer integration is a separate concern (likely already in place since `turn/plan/updated` is a known protocol event).

### Integration test scenarios
1. **Inline-only path**: short plan (< threshold), assert `MessagingMessageIntent` with text body and no `MessagingFilePart`.
2. **Attachment + summary path**: long plan, adapter declares `supportsFileUpload: true`, assert intent has both inline summary AND `MessagingFilePart` with `text/markdown` MIME.
3. **Inline fallback path**: long plan, adapter has `outboundAttachments` undefined, assert intent has only inline preview with `[Preview truncated]` marker.
4. **Capability size limit**: long plan exceeds `maxUploadBytes`, assert fallback path is taken.
5. **Delivery failure retry**: adapter returns failed outcome on attachment delivery; controller retries with fallback intent.

## Acceptance Criteria

- [ ] `buildPlanArtifactIntent` produces three distinct intent shapes based on capability profile + plan size
- [ ] `outboundAttachments.supportsFileUpload`, `outboundAttachments.maxUploadBytes` are read by the producer
- [ ] Status card no longer says `"Plan mode: unavailable"` — reflects real plan state
- [ ] Discord and Telegram successfully deliver a markdown plan attachment with inline summary on real turn completions
- [ ] Inline fallback works when an adapter cannot attach (manual test by setting `supportsFileUpload: false` on Discord locally)
- [ ] Review-mode delivery follows the same shape via the generic `buildArtifactDeliveryIntent`
- [ ] Existing messaging E2E tests continue to pass

## Success Metrics

- Plan-mode runs from a Telegram or Discord channel result in a delivered Markdown file the user can open natively.
- No "Plan mode: unavailable" text reaches users after this lands.
- Future text-only providers (Signal) get the inline-fallback variant automatically without producer changes.

## Dependencies & Risks

- **Codex protocol shape**: `TurnPlanUpdatedNotification` carries `{ threadId, turnId, explanation, plan: TurnPlanStep[] }`. Confirm during planning whether the structured `plan` array is sufficient, or whether we need to render-to-markdown ourselves the same way openclaw does.
- **Backend support**: only Codex emits `turn/plan/updated` today. Grok agents may not emit equivalent events — investigate, and decide whether to emit a "plan unavailable" status for Grok-bound threads or generate a plan-equivalent from final assistant text.
- **Adapter file delivery path**: hasn't been exercised by any producer yet. There may be latent bugs in `uploadableFileParts` / `sendDocument` callbacks that surface only when the first real file part flows through.
- **Message edit semantics**: if the user receives the plan as a sequence of (1) summary, (2) attachment, (3) "Implement plan?" prompt, message-edit semantics may not apply cleanly — three separate messages, not a single edited surface.

## Sources & References

- **Reference implementation**: `~/github/openclaw-app-server/src/format.ts:907-986` (preview/summary/fallback formatters), `controller.ts:3855-3895` (delivery flow), `controller.ts:6650-6675` (`buildPlanDelivery` switching logic).
- **Capability profile scaffolding**: `packages/messaging/interface/src/index.ts:803-841` (`MessagingOutboundAttachmentCapabilities`, with annotation pointing to this plan).
- **Adapter file delivery infrastructure**:
  - Discord: `packages/messaging/providers/discord/src/discord-adapter.ts:386-388, 1158-1209`
  - Telegram: `packages/messaging/providers/telegram/src/telegram-adapter.ts:554-619, 1699-1792`
- **Protocol notifications**:
  - `packages/codex-app-server-protocol/src/v2/TurnPlanUpdatedNotification.ts`
  - `packages/codex-app-server-protocol/src/v2/PlanDeltaNotification.ts`
  - `packages/codex-app-server-protocol/src/v2/TurnPlanStep.ts`
- **Status card stub to replace**: `apps/desktop/src/main/messaging/core/messaging-status-card.ts:106` (`"Plan mode: unavailable"`).
- **Capability framework PR**: PR #180 (`feat(messaging): capability discovery and adaptive rendering`) — established the `MessagingCapabilityProfile` and the consumption helpers (`applyActionCapabilityLimits`) this work will use.
