import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isPermanentMessagingTargetFailure, managedTopicRecordFromConversation, resolveMonitorStateOptions } from "../messaging/core/messaging-monitor-helpers";
import { topicChannelRef } from "../messaging/core/messaging-callback-helpers";

describe("monitor workflow helpers", () => {
  it("cycles independently specified intervals and row limits without losing other preferences", () => {
    const intervals = [10_000, 30_000, 60_000, 300_000]; const limits = [0, 5, 10];
    fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 2 }), fc.boolean(), (i, n, snippets) => {
      const current = { enabled: true, intervalMs: intervals[i]!, pinnedThreadLimit: limits[n]!, recentThreadLimit: 5,
        showLastResponseSnippet: snippets, showStatusLine: true, updatedAt: 1_000 };
      expect(resolveMonitorStateOptions(current, { kind: "cycle-interval" })).toEqual({ intervalMs: intervals[(i + 1) % 4],
        pinnedThreadLimit: limits[n], recentThreadLimit: 5, showLastResponseSnippet: snippets, showStatusLine: true });
      expect(resolveMonitorStateOptions(current, { kind: "cycle-pinned" }).pinnedThreadLimit).toBe(limits[(n + 1) % 3]);
    }));
  });

  it("keeps topic identity independent from mutable labels and opaque routing state", () => {
    fc.assert(fc.property(fc.constantFrom("telegram", "discord"), fc.string(), fc.string(), (channel, title, opaque) => {
      const record = managedTopicRecordFromConversation({ actorIds: ["fixture-actor"], channel,
        conversation: { id: "fixture-topic", kind: "topic", parentId: "fixture-parent", title }, now: 1_000,
        routingState: { opaque: { fixture: opaque } }, source: "linked" });
      expect(record).toMatchObject({ id: `topic:${channel}:fixture-parent:fixture-topic`, supergroupId: "fixture-parent", topicId: "fixture-topic",
        title, routingState: { opaque: { fixture: opaque } }, source: "linked", lifecycle: "open" });
    }));
  });

  it("keeps managed topic routes in the originating connection across identical provider topic IDs", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 2 }), (connections) => {
      const topic = managedTopicRecordFromConversation({
        actorIds: [], channel: "telegram", now: 1, source: "owned",
        conversation: { id: "101", kind: "topic", parentId: "-100777" },
      });
      expect(topicChannelRef(topic)).not.toHaveProperty("connectionId");
      expect(connections.map((id) => topicChannelRef(topic, id).connectionId)).toEqual(connections);
    }));
  });

  it("retires only failed deliveries that identify a permanently missing destination", () => {
    fc.assert(fc.property(fc.constantFrom("presented", "updated", "failed", "discarded"), fc.boolean(), (outcome, missing) => {
      expect(isPermanentMessagingTargetFailure({ outcome, channel: "telegram", deliveredAt: 1_000,
        errorMessage: missing ? "Fixture: chat not found" : "Fixture transient connection failure" })).toBe(outcome === "failed" && missing);
    }));
  });
});
