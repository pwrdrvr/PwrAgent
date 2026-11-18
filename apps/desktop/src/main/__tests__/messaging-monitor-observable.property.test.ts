import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingMonitorHarness } from "./fixtures/messaging-monitor-harness";

type Real = Awaited<ReturnType<typeof messagingMonitorHarness>>;
type Model = { enabled: boolean; seen: boolean; pins: number; recent: number; interval: number; snippets: boolean; statusLine: boolean };

// The projection is the durable configuration, provider-visible selected rows
// and native timer resources. Normal command sequences settle one render before
// the next command; the old-render/stop race (repair card 17f8d62c-de3d-4c98-8cc4-ba740abb2ee8) is not an
// intended-behavior oracle. Revocation/disposal interleavings are tested below.
async function check(model: Model, f: Real) {
  const saved = await f.subscription();
  expect(saved?.monitor.enabled ?? false).toBe(model.enabled);
  expect(f.timers.size).toBe(model.enabled ? 1 : 0);
  if (!model.seen) return;
  expect(saved?.monitor).toMatchObject({ pinnedThreadLimit: model.pins, recentThreadLimit: model.recent,
    intervalMs: model.interval, showLastResponseSnippet: model.snippets, showStatusLine: model.statusLine });
  if (!model.enabled) return;
  const intent = f.delivered.filter(intent => intent.kind === "status").at(-1);
  expect(intent?.kind).toBe("status");
  if (intent?.kind !== "status") return;
  const expected = [...f.rows.slice(0, Math.min(3, model.pins)), ...f.rows.slice(3, 3 + model.recent)];
  for (const row of f.rows) expect(intent.text.includes(`${row.title} (`)).toBe(expected.some(selected => selected.id === row.id));
  expect([...f.timers.values()].map(timer => timer.delay)).toEqual([model.interval]);
}

describe("monitor observable protocol", () => {
  it("keeps bounded selections, preferences and timer cardinality through valid command sequences", async () => {
    const settings = fc.constantFrom(
      { args: ["pins", "0"], change: { pins: 0 } }, { args: ["pins", "10"], change: { pins: 10 } },
      { args: ["recent", "0"], change: { recent: 0 } }, { args: ["recent", "10"], change: { recent: 10 } },
      { args: ["interval", "10s"], change: { interval: 10_000 } }, { args: ["interval", "1m"], change: { interval: 60_000 } },
      { args: ["snippet", "off"], change: { snippets: false } }, { args: ["snippet", "on"], change: { snippets: true } },
      { args: ["status", "line"], change: { statusLine: true } }, { args: ["status", "inline"], change: { statusLine: false } },
      { args: ["refresh"], change: {} },
    ).map(value => ({ check: () => true, toString: () => value.args.join(" "),
      run: async (model: Model, f: Real) => { await f.command([...value.args]); Object.assign(model, value.change, { enabled: true, seen: true }); await check(model, f); },
    }));
    const stop = fc.constant({ check: () => true, toString: () => "stop",
      run: async (model: Model, f: Real) => { await f.command(["stop"]); model.enabled = false; await check(model, f); },
    });
    const tick = fc.constant({ check: (model: Model) => model.enabled, toString: () => "timer fires",
      run: async (model: Model, f: Real) => {
        const before = f.reads.length; await f.tick();
        expect(f.reads.slice(before).filter(read => read.kind === "status" || read.kind === "snippet").every(read => read.countsAsActivity === false)).toBe(true);
        await check(model, f);
      },
    });
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), fc.commands([settings, stop, tick], { maxCommands: 6 }), async (channel, edits, commands) => {
      const f = await messagingMonitorHarness({ channel, edits });
      try {
        // Force both row bounds above the default five, not merely maxLength.
        await f.command(["pins", "10"]); await f.command(["recent", "10"]); await f.command(["snippet", "on"]);
        const model: Model = { enabled: true, seen: true, pins: 10, recent: 10, interval: 60_000, snippets: true, statusLine: false };
        await check(model, f);
        await fc.asyncModelRun(() => ({ model, real: f }), commands);
        expect(f.reads.filter(read => read.kind === "query").every(read => (read.size ?? 0) <= 10)).toBe(true);
        await f.command(["stop"]); expect(f.timers.size).toBe(0);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("retries transient delivery failures and retires permanently missing targets", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("transient", "permanent"), async failure => {
      const f = await messagingMonitorHarness();
      try {
        f.hooks.failure = failure; await f.command();
        const intent = f.delivered.find(intent => intent.kind === "status")!;
        const id = intent.bindingId!;
        expect(Boolean((await f.store.getMonitorSubscription(id))?.revokedAt)).toBe(failure === "permanent");
        expect(f.timers.size).toBe(failure === "permanent" ? 0 : 1);
        f.hooks.failure = undefined;
        if (failure === "transient") { await f.tick(); expect((await f.subscription())?.monitorSurface).toBeDefined(); expect(f.timers.size).toBe(1); }
        else { await f.controller.startMonitoringForEnabledBindings(); expect(f.timers.size).toBe(0); }
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("does not rearm timers after revocation or disposal while delivery is in flight", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, dispose) => {
      const f = await messagingMonitorHarness();
      const entered = Promise.withResolvers<void>();
      let pending: Promise<void> | undefined;
      try {
        f.hooks.deliver = async intent => {
          if (intent.kind === "status") { entered.resolve(); await scheduler.schedule(Promise.resolve(), "monitor delivery"); }
        };
        pending = f.command();
        await Promise.race([entered.promise, pending.then(() => { expect.fail("Monitor must reach delivery"); })]);
        const record = (await f.subscription())!;
        if (dispose) f.controller.dispose();
        else await f.store.revokeMonitorSubscription({ subscriptionId: record.id, revokedAt: 2_000 });
        await scheduler.waitFor(pending); await setImmediate();
        expect(f.timers.size).toBe(0);
        if (!dispose) expect((await f.store.getMonitorSubscription(record.id))?.revokedAt).toBe(2_000);
      } finally { await scheduler.waitAll(); await pending; await f.close(); }
    }), { numRuns: 25 });
  });

  it("keeps passive timer reads distinct from human refresh and respects provider edit capability", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async edits => {
      const f = await messagingMonitorHarness({ edits });
      try {
        await f.command(["snippet", "on"]);
        const first = f.delivered.filter(intent => intent.kind === "status").at(-1)!;
        const surface = (await f.subscription())!.monitorSurface;
        f.reads.length = 0; await f.tick();
        const passive = f.reads.filter(read => read.kind !== "query");
        expect(passive.length).toBeGreaterThan(0); expect(passive.every(read => read.countsAsActivity === false)).toBe(true);
        const updated = f.delivered.filter(intent => intent.kind === "status").at(-1)!;
        expect(first.delivery?.mode).toBe("present");
        expect(updated.delivery?.mode).toBe(edits ? "update" : "present");
        expect(updated.targetSurface).toEqual(edits ? surface : undefined);
        f.reads.length = 0; await f.command(["refresh"]);
        expect(f.reads.filter(read => read.kind !== "query").every(read => read.countsAsActivity === undefined)).toBe(true);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("creates only the bounded topic fanout and reuses the durable thread links", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), async (channel, supported) => {
      const f = await messagingMonitorHarness({ channel });
      try {
        let creates = 0;
        if (supported) f.controllerOptions.adapter.createManagedConversation = async request => ({ outcome: "created", channel,
          conversation: { id: `fixture-topic-${++creates}`, kind: "topic", parentId: request.parent.conversation.parentId ?? request.parent.conversation.id, title: request.title }, updatedAt: 1_000 });
        await f.command(["topics", "fanout"]);
        const expected = channel === "telegram" && supported;
        expect(creates).toBe(expected ? 4 : 0); // One control plus three selected threads, from twelve candidates.
        const links = await Promise.all(f.rows.map(row => f.store.findThreadTopicLink({ channel, supergroupId: f.channel.conversation.id, backend: row.source, threadId: row.id })));
        expect(links.filter(Boolean)).toHaveLength(expected ? 3 : 0);
        for (let n = 0; n < links.length; n++) {
          const link = links[n]; if (!link) continue;
          const topic = (await f.store.getManagedTopic(link.topicRecordId))!;
          const binding = await f.store.findActiveBindingForChannel({ channel, conversation: topic.conversation });
          expect(binding).toMatchObject({ backend: f.rows[n]!.source, threadId: f.rows[n]!.id });
        }
        await f.command(["topics", "fanout"]); expect(creates).toBe(expected ? 4 : 0);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("persists cleanup proposals without destructive operations and caps approval actions", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 8, max: 11 }), async eligible => {
      const f = await messagingMonitorHarness({ clock: () => 1_000 });
      try {
        f.controllerOptions.adapter.createManagedConversation = async () => ({ outcome: "created", channel: "telegram",
          conversation: { id: "control", kind: "topic", parentId: f.channel.conversation.id }, updatedAt: 1_000 });
        let destructive = 0;
        f.controllerOptions.adapter.closeManagedConversation = async () => { destructive++; throw new Error("No cleanup before approval"); };
        f.controllerOptions.adapter.deleteManagedConversation = async () => { destructive++; throw new Error("No cleanup before approval"); };
        await f.command(["topics"]);
        for (let n = 0; n < eligible + 2; n++) await f.store.upsertManagedTopic({
          id: `topic-fixture-${n}`, channel: "telegram", supergroupId: f.channel.conversation.id, topicId: `item-${n}`,
          conversation: { id: `item-${n}`, kind: "topic", parentId: f.channel.conversation.id }, authorizedActorIds: ["fixture-actor"],
          source: n >= eligible ? "linked" : "observed", lifecycle: n % 2 ? "closed" : "open", createdAt: 1_000, updatedAt: 1_000,
        });
        await f.command(["topics", "cleanup"]);
        const proposal = (await f.store.getTopicCleanupProposal(`topic-cleanup:${f.channel.conversation.id}:1000`))!;
        expect(proposal.status).toBe("pending"); expect(destructive).toBe(0);
        expect(proposal.items.filter(item => item.action !== "keep")).toHaveLength(eligible);
        const intent = f.delivered.at(-1)!;
        expect(intent.kind === "confirmation" ? intent.actions?.length : undefined).toBe(6);
        for (let n = 0; n < eligible + 2; n++) expect(proposal.items.find(item => item.id === `item-${n}`)?.action)
          .toBe(n >= eligible ? "keep" : n % 2 ? "delete" : "close");
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });
});
