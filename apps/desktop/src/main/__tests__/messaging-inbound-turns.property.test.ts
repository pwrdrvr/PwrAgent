import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { MessagingAdapter } from "../messaging/core/messaging-adapter";
import type { MessagingInboundContext, MessagingInboundHost } from "../messaging/core/messaging-inbound-context";
import { MessagingInboundTurns } from "../messaging/core/messaging-inbound-turns";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";
import { messagingModules } from "./fixtures/messaging-controller-modules";

function contextFor(f: Awaited<ReturnType<typeof messagingInboundHarness>>, host: () => MessagingInboundHost): MessagingInboundContext {
  return {
    get store() { return f.controllerOptions.store; },
    get backend() { return f.controllerOptions.backend; },
    get adapter() { return f.controllerOptions.adapter; },
    get capabilityProfile() { return f.controllerOptions.adapter.capabilityProfile; },
    now: () => f.controllerOptions.now!(),
    get logger() { return f.controllerOptions.logger!; },
    get config() { return f.controllerOptions; },
    host,
  };
}

describe("messaging inbound owner", () => {
  it("does not read a collaborator while constructing the owner", async () => {
    const f = await messagingInboundHarness();
    try {
      const reads: PropertyKey[] = [];
      const context = new Proxy(contextFor(f, messagingModules(f.controller).inboundHost), {
        get: (target, key, receiver) => { reads.push(key); return Reflect.get(target, key, receiver); },
      });
      new MessagingInboundTurns(context);
      expect(reads).toEqual([]);
    } finally { await f.close(); }
  });

  it("resolves a replaced host after awaited permission admission", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const f = await messagingInboundHarness();
      const entered = Promise.withResolvers<void>();
      const trace: string[] = [];
      const actual = messagingModules(f.controller).inboundHost();
      // Object spread cannot copy prototype operations from an actual owner.
      // Supply the exact ingress operations as bound ports, even though this
      // protocol only appends; no missing method may turn a mutation green.
      const admission = actual.turnAdmission;
      const admissionPorts = {
        append: async () => { trace.push("replacement append"); },
        markStarting: admission.markStarting.bind(admission), clearStarting: admission.clearStarting.bind(admission),
        isStarting: admission.isStarting.bind(admission),
      };
      let selected: MessagingInboundHost = {
        ...actual,
        requirePermission: async () => { entered.resolve(); await scheduler.schedule(Promise.resolve(), "permission admitted"); return true; },
        turnAdmission: { ...admissionPorts, append: async () => { trace.push("old append"); } },
      };
      const owner = new MessagingInboundTurns(contextFor(f, () => selected));
      let pending: Promise<void> | undefined;
      try {
        pending = owner.handleText(f.event());
        await entered.promise;
        selected = { ...selected, turnAdmission: admissionPorts };
        await scheduler.waitAll(); await pending;
        expect(trace).toEqual(["replacement append"]);
      } finally { await scheduler.waitAll(); await pending; await f.close(); }
    }), { numRuns: 25 });
  });

  it("releases a failed private-reply claim for retry and completes an accepted claim once", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), async channel => {
      const f = await messagingInboundHarness({ channel });
      const actual = messagingModules(f.controller).inboundHost();
      let calls = 0;
      const admission = actual.turnAdmission;
      const owner = new MessagingInboundTurns(contextFor(f, () => ({ ...actual, turnAdmission: {
        append: async () => { if (++calls === 1) throw failure; },
        markStarting: admission.markStarting.bind(admission), clearStarting: admission.clearStarting.bind(admission),
        isStarting: admission.isStarting.bind(admission),
      } })));
      const failure = new Error("Fixture append rejection");
      try {
        const source = (await f.store.getBinding("fixture-binding"))!;
        const binding = { ...source, privateReplyContinuation: {
          requestId: "fixture-private-request", createdAt: 1_000, expiresAt: 20_000, instructions: "Fixture private instructions", source,
        } };
        const params = { binding, event: f.event() };
        await expect(owner.admitTurnInput(params)).rejects.toBe(failure);
        await expect(owner.admitTurnInput(params)).resolves.toBe(true);
        await expect(owner.admitTurnInput(params)).resolves.toBe(false);
        expect(calls).toBe(2);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("stops before admission when the permission or remote owner gate denies a turn", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("permission", "remote"), async denial => {
      const f = await messagingInboundHarness();
      try {
        const actual = messagingModules(f.controller).inboundHost();
        let appended = 0;
        const admission = actual.turnAdmission;
        const owner = new MessagingInboundTurns(contextFor(f, () => ({
          ...actual, requirePermission: async () => denial !== "permission", requireRemoteScopeForBinding: async () => denial !== "remote",
          turnAdmission: {
            append: async () => { appended++; },
            markStarting: admission.markStarting.bind(admission), clearStarting: admission.clearStarting.bind(admission),
            isStarting: admission.isStarting.bind(admission),
          },
        })));
        await owner.handleText(f.event());
        expect(appended).toBe(0);
        expect(f.starts).toEqual([]);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("keeps the optional PDF support getter outside the provider-call catch", async () => {
    const f = await messagingInboundHarness();
    try {
      const failure = new Error("Fixture support getter failure");
      f.controllerOptions.backend = new Proxy(f.backend, { get: (target, key, receiver) => {
        if (key === "supportsMessagingPdfTools") throw failure;
        return Reflect.get(target, key, receiver);
      } });
      const binding = (await f.store.getBinding("fixture-binding"))!;
      await expect(messagingModules(f.controller).inbound.resolveMessagingPdfHandling(binding)).rejects.toBe(failure);
    } finally { await f.close(); }
  });

  it("awaits binding enrichment before observing the managed topic", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const f = await messagingInboundHarness();
      const actual = messagingModules(f.controller).inboundHost();
      const binding = actual.bindingService;
      const entered = Promise.withResolvers<void>();
      const trace: string[] = [];
      let enrichment: Promise<void> | undefined;
      let refresh: Promise<void> | undefined;
      const owner = new MessagingInboundTurns(contextFor(f, () => ({
        ...actual,
        bindingService: {
          notifyBindingChanged: binding.notifyBindingChanged.bind(binding), renderAutomaticBindingStatus: binding.renderAutomaticBindingStatus.bind(binding),
          bindChannelToThread: binding.bindChannelToThread.bind(binding), updateBindingPreferences: binding.updateBindingPreferences.bind(binding),
          renderBindingStatus: binding.renderBindingStatus.bind(binding),
          refreshBindingFromInbound: () => {
            trace.push("binding:entered"); entered.resolve();
            enrichment = scheduler.schedule(Promise.resolve(), "binding metadata settled").then(() => { trace.push("binding:settled"); });
            return enrichment;
          },
        },
        observeManagedTopicFromInbound: async () => { trace.push("topic:observed"); },
      })));
      try {
        refresh = owner.refreshInboundMetadata(f.event());
        await entered.promise;
        expect(trace).toEqual(["binding:entered"]);
        await scheduler.waitAll(); await refresh;
        expect(trace).toEqual(["binding:entered", "binding:settled", "topic:observed"]);
      } finally { await scheduler.waitAll(); await enrichment; await refresh; await f.close(); }
    }), { numRuns: 25 });
  });

  it("preserves the native download receiver and prepares attachments in event order", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("First fixture", "Second fixture"), { minLength: 2, maxLength: 4 }), async texts => {
      const f = await messagingInboundHarness();
      try {
        const adapter = f.controllerOptions.adapter;
        const receivers: unknown[] = [];
        adapter.downloadAttachment = async function(this: MessagingAdapter, { attachment }) {
          receivers.push(this);
          const data = new TextEncoder().encode("Fixture attachment content");
          return { data, fileName: attachment.name, mimeType: "text/plain", sizeBytes: data.length };
        };
        const events = texts.map(text => ({ ...f.event(text), kind: "media" as const, disposition: "available" as const, attachments: [{
          id: text, kind: "file" as const, name: `${text}.txt`, disposition: "available" as const, mimeType: "text/plain", sizeBytes: 26,
        }] }));
        const binding = (await f.store.getBinding("fixture-binding"))!;
        const prepared = await messagingModules(f.controller).inbound.prepareTurnInput(events, binding, events[0]);
        expect(receivers).toHaveLength(texts.length);
        expect(receivers.every(receiver => receiver === adapter)).toBe(true);
        expect(prepared?.input).toHaveLength(texts.length);
        for (const [index, text] of texts.entries()) expect(prepared?.input[index]).toMatchObject({
          type: "text", text: expect.stringContaining(`${text}\n\nAttached file: \`${text}.txt\``),
        });
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("keeps timing marks bounded, uses the first mark and consumes each event once", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 257, max: 270 }), fc.integer({ min: 1, max: 10 }), async (count, elapsed) => {
      let now = 1_000;
      const f = await messagingInboundHarness({ clock: () => now });
      try {
        const owner = messagingModules(f.controller).inbound;
        const events = Array.from({ length: count }, () => f.event());
        for (const event of events) {
          owner.markAdmissionStage(event, "handled");
          now += elapsed;
          owner.markAdmissionStage(event, "handled");
          owner.markAdmissionStage(event, "routed");
        }
        expect(owner.admissionStageMarks.size).toBe(256);
        for (const event of events.slice(0, count - 256)) expect(owner.takeAdmissionStageTiming(event, now)).toEqual({});
        for (const event of events.slice(count - 256)) {
          expect(owner.takeAdmissionStageTiming(event, now).handledToRoutedMs).toBe(elapsed);
          expect(owner.takeAdmissionStageTiming(event, now)).toEqual({});
        }
        expect(owner.admissionStageMarks.size).toBe(0);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("retains native configuration callbacks and the facade clock receiver", async () => {
    const receivers: unknown[] = [];
    const f = await messagingInboundHarness({ clock: function(this: unknown) { receivers.push(this); return 1_000; } });
    try {
      const callbacks: unknown[] = [];
      f.controllerOptions.responseModeForConversation = function(this: unknown) { callbacks.push(this); return "mention_only"; };
      const owner = messagingModules(f.controller).inbound;
      await expect(owner.responseModeForConversation(f.channel)).resolves.toBe("mention_only");
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]).toBe(f.controllerOptions);
      receivers.length = 0;
      await owner.resolvePdfAnalysisEnabled();
      expect(receivers).toEqual([f.controller]);
    } finally { await f.close(); }
  });

  it("coalesces a pending prompt in arrival order and cancels its timer during facade shutdown", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("Fixture first", "Fixture second"), { minLength: 2, maxLength: 5 }), async texts => {
      const f = await messagingInboundHarness();
      const owner = messagingModules(f.controller).inbound;
      const clear = vi.spyOn(globalThis, "clearTimeout");
      try {
        f.controllerOptions.inputDebounceMs = 500;
        const session = {
          id: "fixture-prompt-session", channel: f.channel, allowedActorIds: ["fixture-actor"], launchAction: "start_new_thread" as const,
          mode: "new_thread_options" as const, selectedProject: { directoryKey: "fixture-project", path: "/fixture/project", label: "Fixture project" },
          pageIndex: 0, pageSize: 5, createdAt: 1_000, updatedAt: 1_000, expiresAt: 20_000,
        };
        let previous: ReturnType<typeof setTimeout> | undefined;
        for (const text of texts) {
          const event = f.event(text);
          owner.markAdmissionStage(event, "handled");
          await owner.appendPendingNewThreadPrompt(session, event);
          if (previous) expect(clear).toHaveBeenCalledWith(previous);
          previous = [...owner.pendingNewThreadPrompts.values()][0]!.timer;
        }
        expect([...owner.pendingNewThreadPrompts.values()].map(window => window.events.map(event => event.text))).toEqual([texts]);
        f.controller.dispose();
        expect(clear).toHaveBeenCalledWith(previous);
        expect(owner.pendingNewThreadPrompts.size).toBe(0);
        expect(owner.admissionStageMarks.size).toBe(0);
      } finally { owner.clearPendingPrompts(); clear.mockRestore(); await f.close(); }
    }), { numRuns: 25 });
  });
});
