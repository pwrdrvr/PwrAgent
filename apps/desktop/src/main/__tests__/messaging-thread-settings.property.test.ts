import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationThreadSummary, SetThreadModelSettingsResponse, ThreadExecutionMode } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingInboundCallbackEvent, MessagingJsonValue } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { MessagingThreadSettings } from "../messaging/core/messaging-thread-settings";

type Context = ConstructorParameters<typeof MessagingThreadSettings>[0];

const binding: MessagingBindingRecord = {
  id: "binding", backend: "codex", threadId: "thread", authorizedActorIds: ["actor"],
  channel: { channel: "telegram", conversation: { id: "chat", kind: "dm" } },
  createdAt: 1, updatedAt: 1,
};
const thread: NavigationThreadSummary = {
  id: "thread", title: "Test thread", titleSource: "explicit", source: "codex",
  linkedDirectories: [], inbox: { inInbox: false }, executionMode: "default",
};
function callback(actionId: string, value: MessagingJsonValue): MessagingInboundCallbackEvent {
  return {
    id: "selection", kind: "callback", actionId, value, channel: binding.channel, receivedAt: 1,
    actor: { platformUserId: "actor" }, interaction: { channel: "telegram", id: "status" },
  };
}

function fixture() {
  const effects: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected settings port"); };
  const context: Context = {
    backend: {},
    store: {
      getBinding: unexpected, getBrowseSession: unexpected, upsertBrowseSession: unexpected,
      upsertPendingIntent: unexpected, upsertBinding: unexpected,
    },
    accessControl: {
      deliverFullAccessPolicyError: unexpected,
      ensureFullAccessEscalationAllowed: unexpected,
      requirePermission: unexpected,
      resolveFullAccessControls: unexpected,
      resolveFullAccessWarning: unexpected,
    },
    bindingService: {
      async updateBindingPreferences(record, patch) {
        effects.push(patch.executionMode ? `persist:${patch.executionMode}` : patch.model
          ? `persist:${patch.model}` : `persist:${patch.reasoningEffort}`);
        return { ...record, preferences: { ...record.preferences, ...patch, updatedAt: 1 } };
      },
      async clearActiveBindingSubmodeIntent() { effects.push("clear-picker"); },
      async renderBindingStatus(record) { effects.push("render"); return record; },
      deliverAndStoreStatusSubmode: unexpected,
      resolveToolUpdateDefaultMode: unexpected,
    },
    inboundTurns: { responseModeForConversation: unexpected },
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    streamingResponsesDefault: false,
    now: () => 1,
    newIntentId: prefix => prefix,
    deliver: unexpected,
    deliverInvalidStatusSelection: unexpected,
    getBackendSummary: async () => undefined,
    async readBoundThreadConfiguration() {
      return { kind: "thread", thread, defaults: { backend: "codex", executionMode: "default" } };
    },
    storePendingIntent: unexpected,
  };
  return { context, effects };
}

it("persists approved mode changes before the owning backend call and leaves refresh to the bus", async () => {
  const mode = fc.constantFrom<ThreadExecutionMode>("default", "auto", "full-access");
  await fc.assert(fc.asyncProperty(mode, mode, fc.boolean(), async (current, next, allowed) => {
    const f = fixture();
    const context: Context = {
      ...f.context,
      async readBoundThreadConfiguration() {
        return {
          kind: "thread",
          thread: { ...thread, executionMode: current === "default" ? "auto" : "default", queuedExecutionMode: current },
          defaults: { backend: "codex", executionMode: "default" },
        };
      },
      accessControl: {
        ...f.context.accessControl,
        async ensureFullAccessEscalationAllowed() { f.effects.push("gate"); return allowed; },
      },
      backend: {
        async setThreadExecutionMode(request) {
          expect(this).toBe(context.backend);
          expect(request).toEqual({ backend: "codex", threadId: "thread", executionMode: next, federationTarget: undefined });
          f.effects.push(`backend:${next}`);
          return request;
        },
      },
    };
    await new MessagingThreadSettings(context).setBindingPermissionsMode(binding, callback("permissions:set", { executionMode: next }));

    const expected = current === next ? ["clear-picker", "render"] : [
      ...(next === "full-access" ? ["gate"] : []),
      ...(next !== "full-access" || allowed ? [`persist:${next}`, "clear-picker", `backend:${next}`] : []),
    ];
    expect(f.effects).toEqual(expected);
  }));
});

it("waits for the backend model response before storing its reasoning and refreshing", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("medium", "high"), async reasoningEffort => {
    const f = fixture();
    const reported = Promise.withResolvers<SetThreadModelSettingsResponse>();
    const started = Promise.withResolvers<void>();
    const context: Context = {
      ...f.context,
      backend: {
        async setThreadModelSettings(request) {
          expect(this).toBe(context.backend);
          expect(request.model).toBe("selected-model");
          f.effects.push("backend");
          started.resolve();
          return reported.promise;
        },
      },
    };
    const pending = new MessagingThreadSettings(context).setBindingModel(binding, callback("model:set", { model: "selected-model" }));
    await Promise.race([started.promise, pending]);
    await setImmediate();
    const before = [...f.effects];
    reported.resolve({ backend: "codex", threadId: "thread", model: "selected-model", reasoningEffort });
    await pending;
    expect(before).toEqual(["persist:selected-model", "backend"]);
    expect(f.effects.slice(before.length)).toEqual([`persist:${reasoningEffort}`, "clear-picker", "render"]);
  }), { numRuns: 20 });
});
