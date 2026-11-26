import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

describe("observable inbound turn protocol", () => {
  it("submits permitted text and media to the bound owner and preserves acceptance through terminal sessions", async () => {
    type Model = { active?: string; attempts: number; ownsQueue: boolean };
    type Real = Awaited<ReturnType<typeof messagingInboundHarness>>;
    const send = fc.record({ media: fc.boolean(), outcome: fc.constantFrom("started", "queued", "failed") }).map(({ media, outcome }) => ({
      check: (model: Model) => !model.active && (outcome !== "queued" || model.ownsQueue),
      run: async (model: Model, real: Real) => {
        real.hooks.outcome = outcome;
        const before = real.deliveries.length;
        const event = real.event(`Fixture prompt ${model.attempts}`);
        await real.controller.handleInboundEvent(media ? { ...event, kind: "media", attachments: [], disposition: "available" } : event);
        model.attempts++;
        expect(real.starts).toHaveLength(model.attempts);
        expect(real.starts.at(-1)).toMatchObject({ threadId: "fixture-thread", input: [{ type: "text", text: event.text }], executionMode: "default" });
        const visible = real.deliveries.slice(before);
        expect(visible.some(intent => intent.kind === "error" && intent.title === "Turn could not start")).toBe(outcome === "failed");
        expect(visible.some(intent => intent.kind === "confirmation" && intent.title === "Message queued")).toBe(outcome === "queued");
        if (outcome === "started") model.active = `fixture-turn-${model.attempts}`;
      },
      toString: () => `send(${media ? "media" : "text"},${outcome})`,
    }));
    const finish = fc.constantFrom("completed", "failed", "cancelled").map(terminal => ({
      check: (model: Model) => Boolean(model.active),
      run: async (model: Model, real: Real) => {
        await real.finish(terminal, model.active);
        // Providers may repeat terminal evidence. It cannot submit new input.
        await real.finish(terminal, model.active);
        expect(real.starts).toHaveLength(model.attempts);
        model.active = undefined;
      },
      toString: () => `terminal(${terminal},repeat)`,
    }));
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.constantFrom("codex", "claude"), fc.boolean(), fc.commands([send, finish], { maxCommands: 10 }), async (channel, backend, ownsQueue, commands) => {
      const real = await messagingInboundHarness({ channel, backend, ownsQueue });
      try { await fc.asyncModelRun(() => ({ model: { attempts: 0, ownsQueue }, real }), commands); }
      finally { await real.close(); }
    }), { numRuns: 8 });
  });

  it("applies provider mention capability, conversation policy and Full Access resume policy before submission", async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      channel: fc.constantFrom("telegram", "discord"), shared: fc.boolean(), reportsMention: fc.boolean(), mention: fc.boolean(),
      responseMode: fc.constantFrom("every_message", "mention_only"), fullAccess: fc.boolean(), allowResume: fc.boolean(), media: fc.boolean(),
    }), async value => {
      const f = await messagingInboundHarness(value);
      try {
        const event = f.event("Fixture policy prompt", value.mention);
        await f.controller.handleInboundEvent(value.media ? { ...event, kind: "media", attachments: [], disposition: "available" } : event);
        const addressed = !value.shared || !value.reportsMention || value.responseMode === "every_message" || value.mention;
        const permitted = addressed && (!value.fullAccess || value.allowResume);
        expect(f.starts).toHaveLength(permitted ? 1 : 0);
        if (permitted) expect(f.starts[0]!.executionMode).toBe(value.fullAccess ? "full-access" : "default");
      } finally { await f.close(); }
    }), { numRuns: 8 });
  });

  it("starts preparation activity before backend acceptance and reports acceptance only after it settles", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("started", "queued", "failed"), async (scheduler, outcome) => {
      const f = await messagingInboundHarness();
      const entered = Promise.withResolvers<void>();
      let pending: Promise<void> | undefined;
      try {
        f.hooks.outcome = outcome;
        f.hooks.start = async () => { entered.resolve(); await scheduler.schedule(Promise.resolve(), "backend acceptance"); };
        pending = f.controller.handleInboundEvent(f.event());
        await entered.promise;
        expect(f.trace).toContain("deliver:activity");
        expect(f.trace).not.toContain("started:reported");
        await scheduler.waitAll(); await pending;
        expect(f.trace.includes("started:reported")).toBe(outcome === "started");
        if (outcome === "started") expect(f.trace.indexOf("start:accepted")).toBeLessThan(f.trace.indexOf("started:reported"));
      } finally { await scheduler.waitAll(); await pending; await f.close(); }
    }), { numRuns: 8 });
  });

  it.each(["telegram", "discord"] as const)("retains accepted input when a later status effect fails [%#]", async (channel) => {
    const f = await messagingInboundHarness({ channel });
    try {
      f.hooks.postStartFailure = true;
      await expect(f.controller.handleInboundEvent(f.event())).resolves.toBeUndefined();
      expect(f.starts).toHaveLength(1);
      expect(f.deliveries.some(intent => intent.kind === "error" && intent.title === "Turn could not start")).toBe(false);
      expect(f.trace).toContain("started:reported");
    } finally { await f.close(); }
  });

  it("reads the replacement overlay after a pending-intent read yields", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const f = await messagingInboundHarness();
      const replacementDb = openInMemoryStateDb();
      const replacement = new SqliteMessagingStore(replacementDb);
      const entered = Promise.withResolvers<void>();
      let pending: Promise<void> | undefined;
      try {
        await replacement.upsertBinding({ id: "replacement-binding", backend: "codex", threadId: "replacement-thread", channel: f.channel,
          authorizedActorIds: ["fixture-actor"], createdAt: 1_000, updatedAt: 1_000,
        });
        const original = f.store.findActivePendingIntentForChannel.bind(f.store);
        f.store.findActivePendingIntentForChannel = async request => {
          entered.resolve(); await scheduler.schedule(Promise.resolve(), "pending intent read"); return await original(request);
        };
        pending = f.controller.handleInboundEvent(f.event());
        await entered.promise;
        f.controllerOptions.store = replacement;
        await scheduler.waitAll(); await pending; await setImmediate();
        expect(f.starts).toHaveLength(1);
        expect(f.starts[0]!.threadId).toBe("replacement-thread");
      } finally { await scheduler.waitAll(); await pending; await f.close(); replacementDb.close(); }
    }), { numRuns: 8 });
  });

  it.each(["telegram", "discord"] as const)("keeps optional metadata failures off the accepted reply path [%#]", async (channel) => {
    const f = await messagingInboundHarness({ channel });
    try {
      f.store.mergeBindingChannelMetadata = async () => { throw new Error("Fixture optional metadata failure"); };
      await f.controller.handleInboundEvent(f.event());
      await setImmediate();
      expect(f.trace).toContain("metadata:failed");
      expect(f.starts).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each([
    ["telegram", false],
    ["telegram", true],
    ["discord", false],
    ["discord", true],
  ] as const)("uses a Default Agent without creating a persistent binding [%#]", async (channel, media) => {
    const f = await messagingInboundHarness({ channel, route: "default-agent" });
    try {
      const event = f.event();
      await f.controller.handleInboundEvent(media ? { ...event, kind: "media", attachments: [], disposition: "available" } : event);
      expect(f.starts).toHaveLength(1);
      expect(f.admissions.every(id => id === "fixture-thread")).toBe(true);
      expect(await f.store.findActiveBindingForChannel(f.channel)).toBeUndefined();
      expect(await f.store.findActiveDefaultAgentAssignmentsForChannel(f.channel)).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each([
    ["telegram", false],
    ["telegram", true],
    ["discord", false],
    ["discord", true],
  ] as const)("keeps a pending new-thread prompt recoverable when the backend cannot create threads [%#]", async (channel, media) => {
    const f = await messagingInboundHarness({ channel });
    try {
      await f.store.upsertBrowseSession({
        id: "fixture-new-thread", channel: f.channel, allowedActorIds: ["fixture-actor"], launchAction: "start_new_thread",
        mode: "new_thread_options", selectedProject: { directoryKey: "fixture-project", path: "/fixture/project", label: "Fixture project" },
        pageIndex: 0, pageSize: 5, createdAt: 1_000, updatedAt: 1_000, expiresAt: 20_000,
      });
      const event = f.event();
      await f.controller.handleInboundEvent(media ? { ...event, kind: "media", attachments: [], disposition: "available" } : event);
      expect(f.starts).toEqual([]);
      expect(f.deliveries.some(intent => intent.kind === "error" && intent.title === "New thread unavailable")).toBe(true);
      expect(await f.store.getBrowseSession("fixture-new-thread", { now: 1_000 })).toBeDefined();
    } finally { await f.close(); }
  });

  it.each(["telegram", "discord"] as const)("preserves the owning peer on a bound inbound turn [%#]", async (channel) => {
    const f = await messagingInboundHarness({ channel });
    try {
      const binding = (await f.store.getBinding("fixture-binding"))!;
      await f.store.upsertBinding({ ...binding, federatedThread: {
        backend: "codex", threadId: "fixture-thread", target: { scope: "remote", instanceId: "fixture-peer" },
      } });
      await f.controller.handleInboundEvent(f.event());
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]!).toMatchObject({ threadId: "fixture-thread", federationTarget: { scope: "remote", instanceId: "fixture-peer" } });
    } finally { await f.close(); }
  });
});
