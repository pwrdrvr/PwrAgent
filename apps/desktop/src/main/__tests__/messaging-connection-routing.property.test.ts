import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { MessagingBindingRecord, MessagingChannelRef, MessagingInboundTextEvent } from "@pwragent/messaging-interface";
import { buildSourceEventKey } from "../automations/automation-trigger-matcher";
import { listDesktopMessagingRoutes } from "../messaging/messaging-routes-service";
import { messagingDestinationIdentity } from "../messaging/core/messaging-request-projection";
import { OPEN_REPLY_RECEIPT_PREFIX, openReplyReceiptId } from "../messaging/core/messaging-reply-receipts";
import { MessagingStore } from "../messaging/core/messaging-store";
import { mergeMessagingBindingChannelMetadata } from "../messaging/core/messaging-store-merge";
import { SqliteMessagingRequestStore } from "../storage/messaging-request-store";
import { SqliteMessagingStore } from "../storage/messaging-store-sqlite";
import { messagingMonitorHarness } from "./fixtures/messaging-monitor-harness";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const connectionIds = fc.uniqueArray(fc.uuid(), { minLength: 3, maxLength: 3 });

function channel(connectionId: string | undefined): MessagingChannelRef {
  return {
    channel: "discord",
    ...(connectionId === undefined ? {} : { connectionId }),
    conversation: { kind: "channel", id: "parent", parentId: "guild" },
  };
}

function binding(channel: MessagingChannelRef, id = "binding"): MessagingBindingRecord {
  return {
    id, channel, backend: "codex", threadId: "thread", authorizedActorIds: ["fixture-actor"],
    createdAt: 1, updatedAt: 1,
  };
}

async function checkSingletonRoutePicker(id: string, singletonPresent: boolean): Promise<void> {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteMessagingStore(db);
    const singleton = channel(undefined);
    singleton.conversation.title = "Singleton channel";
    const named = channel(id);
    named.conversation.title = "Named channel";
    if (singletonPresent) await store.upsertObservedSurface(singleton, 1);
    await store.upsertBinding(binding(named));
    await store.upsertObservedSurface(named, 2);
    const routes = await listDesktopMessagingRoutes({ store, registry: {
      listBackends: async () => ({ backends: [] }),
      listThreads: async () => [],
      getThreadAgentMetadata: async () => undefined,
    } });
    expect(routes.observedSurfaces.map((surface) => [surface.conversation.title, surface.lastSeenAt]))
      .toEqual(singletonPresent ? [["Singleton channel", 1]] : []);
  } finally {
    db.close();
  }
}

it("keeps the singleton title when a newer named surface shares its provider ID", async () => {
  await checkSingletonRoutePicker("work", true);
});

it("offers only singleton surfaces to route settings across connections", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.boolean(), checkSingletonRoutePicker), { numRuns: 8 });
});

function checkBindingMetadata([first, second]: string[]): void {
  const scopes = [undefined, first, second];
  for (const stored of scopes) for (const observed of scopes) {
    const current = binding(channel(stored));
    const update = { bindingId: current.id, channel: channel(observed), observedAt: 2, title: "New title", routingState: { opaque: "new-route" } };
    const merged = mergeMessagingBindingChannelMetadata(current, update);
    if (stored === observed) expect(merged?.changed).toBe(true);
    else expect(merged).toBeUndefined();
  }
}

it("rejects a named metadata update that points at the singleton binding", () => {
  checkBindingMetadata(["work", "personal"]);
});

it("accepts binding metadata updates only from the binding's own connection", () => {
  fc.assert(fc.property(connectionIds, checkBindingMetadata));
});

async function checkRetainedDestinations([first, second]: string[]): Promise<void> {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteMessagingRequestStore(db.raw);
    const remember = (id: string | undefined, receivedAt: number) => store.remember({
      agent: { backend: "codex", threadId: "agent" }, connectionId: "bot-account",
      event: { id: "same-provider-event", kind: "text", text: "Fixture request", receivedAt,
        actor: { platformUserId: "actor" }, channel: channel(id) },
    })!;
    const singleton = remember(undefined, 1);
    const named = remember(first, 2);
    const other = remember(second, 3);
    expect(singleton.principalScope).toBe(createHash("sha256").update(JSON.stringify([
      singleton.ref.ownerId, "discord", null, "bot-account", "codex", "agent", "actor",
    ])).digest("hex"));
    for (const source of [singleton, named, other]) {
      expect(store.list(source, 1).map((entry) => entry.ref)).toEqual([source.ref]);
      for (const candidate of [singleton, named, other]) {
        expect(store.destination(source, candidate.selector)?.ref)
          .toEqual(source === candidate ? source.ref : undefined);
      }
    }
  } finally {
    db.close();
  }
}

it("keeps a newer named destination from filling the singleton's one-row page", async () => {
  await checkRetainedDestinations(["work", "personal"]);
});

it("partitions retained destination lookups before paging and preserves singleton hashes", async () => {
  await fc.assert(fc.asyncProperty(connectionIds, checkRetainedDestinations), { numRuns: 8 });
});

it.each(["owed", "pending"] as const)("leaves a %s receipt for an unavailable connection untouched", async (state) => {
  const f = await messagingMonitorHarness({ clock: () => 1_000 });
  try {
    const check = async (id: string) => {
      const target = await f.store.upsertBinding(binding({ ...f.channel, connectionId: id }, id));
      const identity = { bindingId: id, kind: "assistant-final" as const, backend: target.backend, threadId: target.threadId, turnId: "turn", itemId: "reply" };
      const row = await f.store.recordDelivery({
        id: openReplyReceiptId(identity), bindingId: id, channel: f.channel.channel, deliveredAt: 999,
        outcome: "discarded", receipt: { ...identity, state, markedAt: 999, attempts: 1 },
      });
      expect(await f.controller.recoverDeliveryReceipts()).toMatchObject({ open: 0, flagged: 0 });
      expect(await f.store.listDeliveriesWithIdPrefix(OPEN_REPLY_RECEIPT_PREFIX)).toContainEqual(row);
    };
    await check("work");
    await fc.assert(fc.asyncProperty(fc.uuid(), check), { numRuns: 8 });
  } finally {
    await f.close();
  }
});

it("never renders or schedules a monitor subscription owned by an unavailable connection", async () => {
  const f = await messagingMonitorHarness({ clock: () => 1_000 });
  try {
    const check = async (id: string) => {
      const subscription = await f.store.upsertMonitorSubscription({
        id, channel: { ...f.channel, connectionId: id }, authorizedActorIds: ["fixture-actor"],
        createdAt: 1, updatedAt: 1, monitor: { enabled: true, intervalMs: 10_000, updatedAt: 1 },
      });
      await f.controller.startMonitoringForEnabledBindings();
      expect(f.reads).toEqual([]);
      expect(f.timers.size).toBe(0);
      expect(await f.store.getMonitorSubscription(id)).toEqual(subscription);
    };
    await check("work");
    await fc.assert(fc.asyncProperty(fc.uuid(), check), { numRuns: 8 });
  } finally {
    await f.close();
  }
});

async function exerciseStore(
  store: MessagingStore | SqliteMessagingStore,
  reload: () => MessagingStore | SqliteMessagingStore,
  [first, second, unknown]: string[],
): Promise<void> {
  // The unscoped row represents a previously saved singleton record.
  const scopes = [undefined, first, second];
  await store.upsertDefaultAgentAssignment({
    id: "legacy-provider-default",
    scope: { kind: "provider", channel: "discord" },
    target: { kind: "agent", backend: "codex", threadId: "legacy-agent" },
    createdAt: 1,
    updatedAt: 1,
  });
  for (const [index, connectionId] of scopes.entries()) {
    const id = `binding-${index}`;
    await store.upsertBinding({
      id,
      channel: channel(connectionId),
      backend: "codex",
      threadId: `thread-${index}`,
      authorizedActorIds: [`actor-${index}`],
      createdAt: 1,
      updatedAt: index + 1,
    });
    await store.upsertCallbackHandle({
      id: `callback-${index}`,
      channel: channel(connectionId),
      handle: "same-button",
      actionId: id,
      bindingId: id,
      allowedActorIds: ["shared-actor", `actor-${index}`],
      createdAt: 1,
      updatedAt: index + 1,
      expiresAt: 100,
    });
  }

  const reloaded = reload();
  if (reloaded instanceof SqliteMessagingStore) {
    const surfaces = await reloaded.findObservedSurfaces();
    expect(surfaces).toHaveLength(scopes.length);
    expect(surfaces.map((row) => row.channel.connectionId)).toEqual(expect.arrayContaining(scopes));
  }
  for (const [index, connectionId] of [...scopes, unknown].entries()) {
    const ref = channel(connectionId);
    const expectedBinding = index < scopes.length ? `binding-${index}` : undefined;
    const child: MessagingChannelRef = {
      ...ref,
      conversation: {
        kind: "thread",
        id: "child",
        parentId: "guild",
        parentConversationId: "parent",
        parentConversationParentId: "guild",
      },
    };
    expect((await reloaded.findActiveBindingForChannel(ref))?.id).toBe(expectedBinding);
    expect((await reloaded.findActiveBindingForChannel(child))?.id).toBe(expectedBinding);
    const assignment = await reloaded.findActiveDefaultAgentAssignmentForChannel(child);
    expect(assignment?.id).toBe(connectionId === undefined ? "legacy-provider-default" : undefined);
    const callback = { channel: ref, handle: "same-button", now: 10 };
    expect((await reloaded.resolveCallbackHandle({ ...callback, actorId: "shared-actor" }))?.actionId)
      .toBe(expectedBinding);
    expect(await reloaded.resolveCallbackHandle({ ...callback, actorId: `actor-${(index + 1) % 3}` }))
      .toBeUndefined();
  }
}

it("keeps legacy and exact connection bindings and callback grants separate in SQLite", async () => {
  await fc.assert(fc.asyncProperty(connectionIds, async (ids) => {
    const db = openInMemoryStateDb();
    try {
      await exerciseStore(new SqliteMessagingStore(db), () => new SqliteMessagingStore(db), ids);
    } finally {
      db.close();
    }
  }), { numRuns: 12 });
});

it("keeps a legacy JSON record and named routes separate after reloading the file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "messaging-connection-routing-"));
  const file = path.join(directory, "messaging.json");
  try {
    await exerciseStore(new MessagingStore(file), () => new MessagingStore(file), ["first", "second", "unknown"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("deduplicates provider redeliveries within one connection while separating identical event IDs", () => {
  fc.assert(fc.property(connectionIds, ([first, second, third]) => {
    const event: MessagingInboundTextEvent = {
      id: "provider-event-1",
      kind: "text",
      actor: { platformUserId: "same-actor" },
      channel: channel(undefined),
      receivedAt: 1,
      text: "Example",
    };
    expect(buildSourceEventKey(event)).toBe("discord:parent:provider-event-1:guild:same-actor");
    expect(messagingDestinationIdentity(event.channel)).toBe(
      JSON.stringify(["discord", null, "channel", "parent", "guild", null]),
    );
    const keys = [undefined, first, second, third].map((connectionId) => {
      const delivery = { ...event, channel: channel(connectionId) };
      const key = buildSourceEventKey(delivery);
      expect(buildSourceEventKey({ ...delivery, receivedAt: 2 })).toBe(key);
      return key;
    });
    expect(new Set(keys).size).toBe(keys.length);
    const destinations = [undefined, first, second, third].map((id) => messagingDestinationIdentity(channel(id)));
    expect(new Set(destinations).size).toBe(destinations.length);
  }));
});
