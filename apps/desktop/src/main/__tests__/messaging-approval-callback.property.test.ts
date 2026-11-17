import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingPermissionId, NavigationThreadSummary, SubmitServerRequestRequest } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingInboundCallbackEvent, MessagingSurfaceIntent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingController } from "../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Independent of the move-only callback oracle: delivery order and the request
// shown on each card are the model's authority; wall time need not advance.
async function approvals(options: {
  channel?: "telegram" | "discord";
  store?: SqliteMessagingStore;
  binding?: Partial<MessagingBindingRecord>;
  beforeSubmit?: (request: SubmitServerRequestRequest) => Promise<void>;
} = {}) {
  const db = options.store ? undefined : openInMemoryStateDb();
  const store = options.store ?? new SqliteMessagingStore(db!);
  const channel = options.channel ?? "telegram";
  const binding: MessagingBindingRecord = {
    id: `binding-${channel}`, backend: "codex", threadId: "fixture-thread",
    channel: { channel, conversation: { id: "fixture-chat", kind: "dm", isDirectMessage: true } },
    authorizedActorIds: ["fixture-actor"], createdAt: 1000, updatedAt: 1000,
    ...options.binding,
  };
  await store.upsertBinding(binding);
  const thread: NavigationThreadSummary = {
    id: binding.threadId, source: "codex", title: "Fixture", titleSource: "explicit",
    executionMode: "default", linkedDirectories: [], inbox: { inInbox: false },
  };
  let now = 1000;
  let sequence = 0;
  let idle = false;
  let failCleanup = false;
  const deliveries: { intent: MessagingSurfaceIntent; surface: MessagingSurfaceRef }[] = [];
  const submitted: SubmitServerRequestRequest[] = [];
  const permissions = new Set<MessagingPermissionId>(["thread.status.view", "approval.respond.escalation"]);
  const backend = {
    getNavigationSnapshot: async () => { throw new Error("Unexpected broad navigation read"); },
    getNavigationSelectedDetail: async request => ({ protocol: 2, revision: "fixture", ref: request.ref, identity: "present", readiness: "ready", thread }),
    getThreadAdmissionState: async () => ({ thread, threadStatus: "active" }),
    startTurn: async request => ({ backend: request.backend, threadId: request.threadId, turnId: "fixture-turn" }),
    readThreadStatus: async () => idle ? "idle" : "active",
    submitServerRequest: async request => {
      await options.beforeSubmit?.(request);
      await setImmediate();
      submitted.push(request);
      return { backend: request.backend, threadId: request.threadId, turnId: request.turnId, requestId: request.requestId };
    },
  } satisfies MessagingBackendBridge;
  const controller = new MessagingController({
    store, backend, channel, now: () => now, authorizedActorIds: ["fixture-actor"], logger: {},
    rbacPolicy: {
      isEnforcing: () => true,
      resolve: () => ({ permissions, roleIds: ["fixture"], matchedSubjects: [], rejected: false }),
    },
    adapter: {
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      deliver: async intent => {
        await setImmediate();
        if (failCleanup && intent.kind === "approval" && intent.decisions.length === 0) throw new Error("Fixture cleanup failure");
        const surface = intent.targetSurface ?? { channel, id: `${options.binding?.id ?? "fixture"}:card-${++sequence}` };
        deliveries.push({ intent, surface });
        return { outcome: "presented", channel, deliveredAt: now, surface };
      },
    },
  });
  return {
    controller, store, binding, submitted, deliveries, permissions,
    setTime: (value: number) => { now = value; },
    setIdle: () => { idle = true; },
    failCleanup: () => { failCleanup = true; },
    present: async (requestId: string) => {
      await controller.handleBackendPendingRequest("codex", {
        method: "item/commandExecution/requestApproval",
        params: { threadId: binding.threadId, turnId: "fixture-turn", requestId, command: "fixture", prompt: "Allow fixture?" },
      }, binding.federatedThread?.target);
      const card = deliveries.findLast(delivery => delivery.intent.kind === "approval" && delivery.intent.requestContext?.requestId === requestId);
      if (!card || card.intent.kind !== "approval") throw new Error("Approval was not delivered");
      const accept = card.intent.decisions.find(decision => decision.decision === "accept");
      if (!accept) throw new Error("Accept decision was not delivered");
      return { ...card, actionId: accept.id, requestId };
    },
    click: async (card: { actionId: string; surface: MessagingSurfaceRef }, overrides: Partial<MessagingInboundCallbackEvent> = {}) => {
      await controller.handleInboundEvent({
        id: `click-${++sequence}`, kind: "callback", receivedAt: now,
        channel: binding.channel, actor: { platformUserId: "fixture-actor" },
        actionId: card.actionId, sourceSurface: card.surface,
        interaction: { channel, id: `interaction-${sequence}` }, ...overrides,
      });
    },
    close: async () => { controller.dispose(); await controller.whenToolUpdatesSettled(); db?.close(); },
  };
}

describe("approval callback identity with tied creation times", () => {
  it("lets proposal-1's delivered card answer proposal-1 at a constant clock of 1000", async () => {
    const f = await approvals();
    try {
      await f.present("proposal-0");
      const latest = await f.present("proposal-1");
      await f.click(latest);
      expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-1"]);
    } finally { await f.close(); }
  });

  it("lets the most recently delivered live card answer its own request for 2–4 tied cards", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async count => {
      const f = await approvals();
      try {
        let latest = await f.present("proposal-0");
        for (let index = 1; index < count; index += 1) latest = await f.present(`proposal-${index}`);
        await f.click(latest);
        expect(f.submitted.map(request => request.requestId)).toEqual([`proposal-${count - 1}`]);
        await f.click(latest);
        expect(f.submitted.map(request => request.requestId)).toEqual([`proposal-${count - 1}`]);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("models delivery, supersession, permission changes and replay independently of timestamp tie order", async () => {
    type Fixture = Awaited<ReturnType<typeof approvals>>;
    type Card = Awaited<ReturnType<Fixture["present"]>>;
    type Model = { now: number; allowed: boolean; cards: { at: number; live: boolean; requestId: string }[]; submitted: string[] };
    type Real = { fixture: Fixture; cards: Card[] };
    const deliver = fc.constantFrom(0, 1).map(gap => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        model.now += gap;
        real.fixture.setTime(model.now);
        const requestId = `proposal-${model.cards.length}`;
        real.cards.push(await real.fixture.present(requestId));
        model.cards.push({ at: model.now, live: true, requestId });
      },
      toString: () => `deliver(+${gap})`,
    }));
    const permission = fc.boolean().map(allowed => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        model.allowed = allowed;
        if (allowed) real.fixture.permissions.add("approval.respond.escalation");
        else real.fixture.permissions.delete("approval.respond.escalation");
      },
      toString: () => `permission(${allowed})`,
    }));
    type Route = "valid" | "actor" | "conversation" | "provider" | "missing";
    const clickCommand = (index: number, route: Route): fc.AsyncCommand<Model, Real> => ({
      check: (model: Readonly<Model>) => model.cards.length > 0,
      run: async (model: Model, real: Real) => {
        const at = index % model.cards.length;
        const card = model.cards[at]!;
        const shown = real.cards[at]!;
        const newest = Math.max(...model.cards.filter(candidate => candidate.live).map(candidate => candidate.at));
        if (route === "valid" && model.allowed && card.live && card.at === newest) {
          model.submitted.push(card.requestId);
          card.live = false;
        }
        const overrides: Partial<MessagingInboundCallbackEvent> = route === "actor" ? { actor: { platformUserId: "stranger" } }
          : route === "conversation" ? { channel: { channel: "telegram", conversation: { id: "other-chat", kind: "dm" } } }
            : route === "provider" ? { sourceSurface: { ...shown.surface, channel: "discord" } }
              : route === "missing" ? { sourceSurface: undefined } : {};
        await real.fixture.click(shown, overrides);
        expect(real.fixture.submitted.map(request => request.requestId)).toEqual(model.submitted);
      },
      toString: () => `click(${index},${route})`,
    });
    const click = fc.tuple(fc.nat({ max: 12 }), fc.constantFrom<Route>("valid", "actor", "conversation", "provider", "missing"))
      .map(([index, route]) => clickCommand(index, route));
    await fc.assert(fc.asyncProperty(fc.commands([deliver, permission, click], { maxCommands: 16, size: "max" }), async commands => {
      const f = await approvals();
      try {
        const first = await f.present("proposal-0");
        const last = await f.present("proposal-1");
        await fc.asyncModelRun(() => ({
          model: { now: 1000, allowed: true, submitted: [], cards: [
            { at: 1000, live: true, requestId: "proposal-0" },
            { at: 1000, live: true, requestId: "proposal-1" },
          ] },
          real: { fixture: f, cards: [first, last] },
        }), [clickCommand(1, "valid"), ...commands]);
      } finally { await f.close(); }
    }), { numRuns: 30 });
  });

  it("keeps durable handles tied to their own live request when a provider reuses a surface", async () => {
    const f = await approvals();
    try {
      const old = await f.present("proposal-0");
      const latest = await f.present("proposal-1");
      await f.store.upsertCallbackHandle({
        id: "old-handle", handle: "opaque-old", actionId: old.actionId,
        channel: f.binding.channel, bindingId: f.binding.id, allowedActorIds: ["fixture-actor"],
        pendingIntentId: old.intent.id, createdAt: 1000, updatedAt: 1000, expiresAt: 60_000,
      });
      await f.click(latest, { interaction: { channel: "telegram", id: "opaque-old" } });
      expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-0"]);
      await f.click(latest, { interaction: { channel: "telegram", id: "opaque-old" } });
      expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-0"]);
      await f.store.upsertCallbackHandle({
        id: "latest-handle", handle: "opaque-latest", actionId: latest.actionId,
        channel: f.binding.channel, bindingId: f.binding.id, allowedActorIds: ["fixture-actor"],
        pendingIntentId: latest.intent.id, createdAt: 1000, updatedAt: 1000, expiresAt: 60_000,
      });
      await f.click(latest, { sourceSurface: undefined, interaction: { channel: "telegram", id: "opaque-latest" } });
      expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-0", "proposal-1"]);
    } finally { await f.close(); }
  });

  it("resolves the latest tied card by its durable handle without a source surface", async () => {
    const f = await approvals();
    try {
      await f.present("proposal-0");
      const latest = await f.present("proposal-1");
      await f.store.upsertCallbackHandle({
        id: "latest-handle", handle: "opaque-latest", actionId: latest.actionId,
        channel: f.binding.channel, bindingId: f.binding.id, allowedActorIds: ["fixture-actor"],
        pendingIntentId: latest.intent.id, createdAt: 1000, updatedAt: 1000, expiresAt: 60_000,
      });
      await f.click(latest, { sourceSurface: undefined, interaction: { channel: "telegram", id: "opaque-latest" } });
      expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-1"]);
    } finally { await f.close(); }
  });

  it("rejects a strictly older card and its handle even if the source surface belongs to the latest card", async () => {
    const f = await approvals();
    try {
      const old = await f.present("proposal-0");
      f.setTime(1001);
      const latest = await f.present("proposal-1");
      await f.store.upsertCallbackHandle({
        id: "stale-handle", handle: "opaque-stale", actionId: old.actionId,
        channel: f.binding.channel, bindingId: f.binding.id, allowedActorIds: ["fixture-actor"],
        pendingIntentId: old.intent.id, createdAt: 1000, updatedAt: 1000, expiresAt: 60_000,
      });
      await f.click(old);
      await f.click(latest, { interaction: { channel: "telegram", id: "opaque-stale" } });
      expect(f.submitted).toEqual([]);
      await f.click(latest);
      expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-1"]);
    } finally { await f.close(); }
  });

  it("isolates equal surface ids by provider in one real store", async () => {
    const telegram = await approvals();
    const discord = await approvals({ store: telegram.store, channel: "discord" });
    try {
      await telegram.present("telegram-0");
      const t = await telegram.present("telegram-1");
      await discord.present("discord-0");
      const d = await discord.present("discord-1");
      expect(t.surface.id).toBe(d.surface.id);
      await telegram.click(t, { sourceSurface: d.surface });
      expect(telegram.submitted).toEqual([]);
      await telegram.click(t);
      await discord.click(d);
      expect(telegram.submitted.map(request => request.requestId)).toEqual(["telegram-1"]);
      expect(discord.submitted.map(request => request.requestId)).toEqual(["discord-1"]);
    } finally { await discord.close(); await telegram.close(); }
  });

  it("does not use a tied card or durable handle from another thread owner", async () => {
    const local = await approvals();
    const remote = await approvals({ store: local.store, binding: {
      id: "remote-binding",
      federatedThread: { backend: "codex", threadId: "fixture-thread", target: { scope: "remote", instanceId: "fixture-owner" } },
    } });
    try {
      const own = await local.present("local-proposal");
      const other = await remote.present("remote-proposal");
      await remote.store.upsertCallbackHandle({
        id: "remote-handle", handle: "opaque-remote", actionId: other.actionId,
        channel: remote.binding.channel, bindingId: remote.binding.id, allowedActorIds: ["fixture-actor"],
        pendingIntentId: other.intent.id, createdAt: 1000, updatedAt: 1000, expiresAt: 60_000,
      });
      await local.click(own, { interaction: { channel: "telegram", id: "opaque-remote" } });
      await local.click(other);
      expect(local.submitted).toEqual([]);
      expect(remote.submitted).toEqual([]);
      await local.click(own);
      expect(local.submitted.map(request => request.requestId)).toEqual(["local-proposal"]);
      expect(local.submitted[0]?.federationTarget).toBeUndefined();
    } finally { await remote.close(); await local.close(); }
  });

  it("keeps the tied proposal live through denial and backend failure, then retires it after acceptance despite cleanup failure", async () => {
    let fail = true;
    const f = await approvals({ beforeSubmit: async () => { if (fail) throw new Error("Fixture rejection"); } });
    try {
      await f.present("proposal-0");
      const latest = await f.present("proposal-1");
      f.permissions.delete("approval.respond.escalation");
      await f.click(latest);
      expect(f.submitted).toEqual([]);
      expect(await f.store.getPendingIntent(latest.intent.id, { now: 1000 })).toBeDefined();
      f.permissions.add("approval.respond.escalation");
      await expect(f.click(latest)).rejects.toThrow("Fixture rejection");
      expect(f.submitted).toEqual([]);
      expect(await f.store.getPendingIntent(latest.intent.id, { now: 1000 })).toBeDefined();
      expect(f.deliveries.filter(delivery => delivery.intent.kind === "approval" && delivery.intent.decisions.length === 0)).toEqual([]);
      fail = false;
      f.failCleanup();
      await f.click(latest);
      expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-1"]);
      expect(await f.store.getPendingIntent(latest.intent.id, { now: 1000 })).toBeUndefined();
      await f.click(latest);
      expect(f.submitted).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("waits for backend acceptance before completing the clicked tied card", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      let enter!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const f = await approvals({ beforeSubmit: async () => {
        enter();
        await scheduler.schedule(Promise.resolve(), "accept clicked proposal");
      } });
      let click: Promise<void> | undefined;
      try {
        await f.present("proposal-0");
        const latest = await f.present("proposal-1");
        click = f.click(latest);
        await Promise.race([entered, click.then(() => { throw new Error("No backend submission"); })]);
        expect(f.submitted).toEqual([]);
        expect(await f.store.getPendingIntent(latest.intent.id, { now: 1000 })).toBeDefined();
        expect(f.deliveries.filter(delivery => delivery.intent.kind === "approval" && delivery.intent.decisions.length === 0)).toEqual([]);
        await scheduler.waitFor(click);
        expect(f.submitted.map(request => request.requestId)).toEqual(["proposal-1"]);
        expect(await f.store.getPendingIntent(latest.intent.id, { now: 1000 })).toBeUndefined();
        expect(f.deliveries.findLast(delivery => delivery.intent.kind === "approval")?.intent).toMatchObject({ decisions: [], targetSurface: latest.surface });
      } finally {
        await scheduler.waitAll();
        if (click) await Promise.allSettled([click]);
        await f.close();
      }
    }), { numRuns: 15 });
  });

  it("retires an idle backend request and refuses expired records", async () => {
    const f = await approvals();
    try {
      await f.present("proposal-0");
      const latest = await f.present("proposal-1");
      f.setIdle();
      await f.click(latest);
      expect(f.submitted).toEqual([]);
      expect(await f.store.getPendingIntent(latest.intent.id, { now: 1000 })).toBeUndefined();
      f.setTime(1_000_000_000);
      await f.click(latest);
      expect(f.submitted).toEqual([]);
    } finally { await f.close(); }
  });
});
