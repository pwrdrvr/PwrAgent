import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingBrowseSessionRecord, MessagingInboundCallbackEvent } from "@pwragent/messaging-interface";
import { isSameMessagingSurface, normalizeNewThreadSessionForBackend, readBindingTargetFromValue, readFullAccessRiskContext, readHelpNavAction, readHelpPageIndex, readPermissionsQueueCancelAction, readPrivateReplyAction, readQueuedTurnAction, readNullableStringValue, readThreadExecutionModeValue, readAcpRuntimeOptionSource } from "../messaging/core/messaging-callback-helpers";

const id = fc.stringMatching(/^[a-z]{1,8}$/);
function event(actionId: string): MessagingInboundCallbackEvent {
  return { id: "event", kind: "callback", actionId, actor: { platformUserId: "actor" },
    channel: { channel: "telegram", conversation: { id: "source", kind: "dm" } }, receivedAt: 1_000,
    interaction: { channel: "telegram", id: "interaction" } };
}

describe("messaging callback helpers", () => {
  it("accepts only declared access/runtime choices and preserves an explicit nullable string", () => {
    const value = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.string(), { maxLength: 3 }),
      fc.record({ fixture: fc.string() }), fc.constantFrom("default", " default ", "auto", "full-access", "mode", "configOption", "model", null));
    fc.assert(fc.property(value, raw => {
      const normalized = typeof raw === "string" ? raw : undefined;
      expect(readNullableStringValue({ slot: raw }, "slot")).toBe(typeof raw === "string" || raw === null ? raw : undefined);
      expect(readThreadExecutionModeValue({ executionMode: raw })).toBe(
        ["default", "auto", "full-access"].includes(normalized ?? "") ? normalized : undefined,
      );
      expect(readAcpRuntimeOptionSource({ source: raw })).toBe(
        ["mode", "configOption", "model"].includes(normalized ?? "") ? normalized : undefined,
      );
      expect(readNullableStringValue([raw], "slot")).toBeUndefined();
    }));
  });

  it("preserves queue and private-reply identities with the documented option bound", () => {
    fc.assert(fc.property(id, fc.constantFrom("cancel" as const, "retry" as const, "steer" as const), fc.integer({ min: -2, max: 5 }), (key, kind, optionIndex) => {
      expect(readQueuedTurnAction(event(`queued-turn:${kind}:${key}`))).toEqual({ kind, entryId: key });
      expect(readPermissionsQueueCancelAction(event(`permissions:queue:cancel:${key}`))).toEqual({ queueId: key });
      expect(readPrivateReplyAction(event(`private-reply:${key}:cancel`))).toEqual({ kind: "cancel", requestId: key });
      expect(readPrivateReplyAction(event(`private-reply:${key}:reply:${optionIndex}`))).toEqual(
        optionIndex >= 0 && optionIndex <= 2 ? { kind: "reply", requestId: key, optionIndex } : undefined,
      );
      expect(readPrivateReplyAction(event(`private-reply:${key}:reply:3`))).toBeUndefined();
      expect(readPermissionsQueueCancelAction(event("permissions:queue:cancel:"))).toBeUndefined();
    }));
  });

  it("requires both provider and message identity, independent of opaque surface state", () => {
    fc.assert(fc.property(id, fc.boolean(), fc.boolean(), (leftId, sameMessage, sameProvider) => {
      const rightId = sameMessage ? leftId : `${leftId}-other`;
      const left = { id: leftId, channel: "telegram" as const, state: { opaque: "old" } };
      const right = { id: rightId, channel: sameProvider ? "telegram" as const : "discord" as const, state: { opaque: "new" } };
      expect(isSameMessagingSurface(left, right)).toBe(sameProvider && leftId === rightId);
      expect(isSameMessagingSurface(left, undefined)).toBe(false);
    }));
  });

  it("keeps owning instance and thread identity intact in binding and risk payloads", () => {
    fc.assert(fc.property(fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const), id, id, (backend, threadId, owner) => {
      const target = readBindingTargetFromValue({ backend, threadId, federationInstanceId: owner });
      expect(target).toMatchObject({ backend, threadId, federatedThread: { backend, threadId, target: { scope: "remote", instanceId: owner } } });
      expect(readBindingTargetFromValue({ backend, threadId })).toEqual({ backend, threadId });
      expect(readBindingTargetFromValue({ backend: "invalid", threadId })).toBeUndefined();
      const risk = { kind: "resume-thread", backend, threadId, sessionId: "session", federationInstanceId: owner };
      expect(readFullAccessRiskContext(risk)).toEqual(risk);
      expect(readFullAccessRiskContext({ kind: "resume-thread", backend, sessionId: "session", federationInstanceId: owner })).toBeUndefined();
      expect(readFullAccessRiskContext({ kind: "thread", bindingId: "binding", threadId })).toEqual({ kind: "thread", bindingId: "binding", threadId });
    }));
  });

  it("recognizes only help navigation actions and accepts nonnegative integer pages", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), (pageIndex) => {
      expect(readHelpPageIndex({ ...event("help:page:next"), value: { pageIndex } })).toBe(pageIndex);
      expect(readHelpPageIndex({ ...event("help:page:next"), value: { pageIndex: -pageIndex - 1 } })).toBe(0);
      expect(readHelpNavAction(event("help:page:next"))).toBe("help:page:next");
      expect(readHelpNavAction(event("help:page:prev"))).toBe("help:page:prev");
      expect(readHelpNavAction(event("help:cancel"))).toBe("help:cancel");
      expect(readHelpNavAction(event("help:unknown"))).toBeUndefined();
    }));
  });

  it("drops unsupported provider preferences without changing the saved session", () => {
    fc.assert(fc.property(id, fc.boolean(), (model, fastMode) => {
      const session: MessagingBrowseSessionRecord = {
        id: "session", channel: event("browse:new").channel, allowedActorIds: ["actor"], createdAt: 1_000,
        updatedAt: 1_000, expiresAt: 5_000, launchAction: "start_new_thread", mode: "projects", pageIndex: 0, pageSize: 5,
        preferences: { model, permissionsMode: "full-access", fastMode, serviceTier: "flex", reasoningEffort: "high", updatedAt: 1_000 },
      };
      const before = structuredClone(session);
      const normalized = normalizeNewThreadSessionForBackend(session, { kind: "acp:grok", label: "Fixture", available: true,
        methods: [], executionModes: [], capabilities: {
          listThreads: true, createThread: true, resumeThread: true, renameThread: false, readThread: true, startTurn: true,
          interruptTurn: true, steerTurn: false, transcriptPagination: false, toolUse: false, approvalRequests: false, multiDirectoryThreads: false,
        } }, 2_000,
        { kind: "launchpad", launchpadDefaults: { backend: "codex", executionMode: "default" } });
      expect(normalized.preferences).toBeUndefined();
      expect(normalized).toMatchObject({ id: session.id, channel: session.channel, allowedActorIds: session.allowedActorIds });
      expect(session).toEqual(before);
    }));
  });
});
