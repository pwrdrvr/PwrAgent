import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { MessagingChannelRef, MessagingInboundTextEvent } from "@pwragent/messaging-interface";
import { buildSourceEventKey } from "../automations/automation-trigger-matcher";
import { messagingDestinationIdentity } from "../messaging/core/messaging-request-projection";
import { MessagingStore } from "../messaging/core/messaging-store";
import { SqliteMessagingStore } from "../storage/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const connectionIds = fc.uniqueArray(fc.uuid(), { minLength: 3, maxLength: 3 });

function channel(connectionId: string | undefined): MessagingChannelRef {
  return {
    channel: "discord",
    ...(connectionId === undefined ? {} : { connectionId }),
    conversation: { kind: "channel", id: "parent", parentId: "guild" },
  };
}

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
