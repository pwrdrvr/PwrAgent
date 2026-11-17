import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AgentEvent, AppServerBackendKind } from "@pwragent/shared";
import type { MessagingChannelKind, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingController } from "../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// The oracle is the provider protocol: start, final item, terminal. It observes
// delivered text and activity through the real controller/store path, without
// reading the controller's state or using its event-normalization helpers.
const session = fc.record({
  backend: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok"),
  channel: fc.constantFrom<MessagingChannelKind>("telegram", "discord", "slack"),
  terminal: fc.constantFrom("turn/completed" as const, "turn/failed" as const, "turn/cancelled" as const),
  repeats: fc.integer({ min: 1, max: 3 }),
  textOnly: fc.boolean(),
});

type Session = typeof session extends fc.Arbitrary<infer Value> ? Value : never;

async function runSessions(sessions: Session[], concurrent: boolean): Promise<void> {
  const db = openInMemoryStateDb();
  const store = new SqliteMessagingStore(db);
  const delivered: MessagingSurfaceIntent[] = [];
  const controller = new MessagingController({
    store,
    backend: {} as MessagingBackendBridge,
    authorizedActorIds: ["fixture-actor"],
    now: () => 1_000,
    adapter: {
      capabilityProfile: { ...PERMISSIVE_CAPABILITY_PROFILE, actions: sessions[0]?.textOnly ? undefined : PERMISSIVE_CAPABILITY_PROFILE.actions },
      deliver: async (intent) => {
        // A macrotask boundary exercises independent concurrent deliveries.
        if (concurrent) await setImmediate();
        delivered.push(intent);
        return { channel: sessions[0]!.channel, deliveredAt: 1_000, outcome: "presented", surface: { id: intent.id, channel: sessions[0]!.channel } };
      },
    },
    logger: {},
  });
  try {
    for (const [index, input] of sessions.entries()) {
      await store.upsertBinding({
        id: `binding-${index}`, backend: input.backend, threadId: `thread-${index}`,
        channel: { channel: input.channel, conversation: { id: `conversation-${index}`, kind: "channel" } },
        authorizedActorIds: ["fixture-actor"], createdAt: 1_000, updatedAt: 1_000,
        statusPresentation: "on_demand",
      });
    }
    const run = async (input: Session, index: number) => {
      const event = (notification: AgentEvent["notification"]): AgentEvent => ({ backend: input.backend, notification });
      const threadId = `thread-${index}`;
      const turnId = `turn-${index}`;
      await controller.handleBackendEvent(event({ method: "turn/started", params: { threadId, turn: { id: turnId } } }));
      // Replayed starts and final items are valid transport redeliveries.
      for (let n = 0; n < input.repeats; n += 1) {
        await controller.handleBackendEvent(event({ method: "item/completed", params: {
          threadId, turnId, item: { id: `item-${index}`, type: "agentMessage", text: `Answer ${index}`, ...(input.backend === "codex" ? { phase: "final" } : {}) },
        } }));
      }
      for (let n = 0; n < input.repeats; n += 1) {
        const notification: AgentEvent["notification"] = input.terminal === "turn/failed"
          ? { method: "turn/failed", params: { threadId, turnId, turn: { id: turnId, status: "failed", error: { message: "Fixture failure" } } } }
          : input.terminal === "turn/cancelled"
            ? { method: "turn/cancelled", params: { threadId, turnId, turn: { id: turnId, status: "cancelled" } } }
            : { method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } } };
        await controller.handleBackendEvent(event(notification));
      }
    };
    if (concurrent) await Promise.all(sessions.map(run));
    else for (const [index, input] of sessions.entries()) await run(input, index);
    const answers = delivered.filter(intent => intent.kind === "message" && intent.role === "assistant")
      .map(intent => ({ bindingId: intent.bindingId, text: intent.kind === "message" ? intent.parts.filter(part => part.type === "text").map(part => part.text).join("") : "" }))
      .sort((a, b) => a.bindingId!.localeCompare(b.bindingId!));
    expect(answers).toEqual(sessions.map((_, index) => ({ bindingId: `binding-${index}`, text: `Answer ${index}` })));
    for (const [index] of sessions.entries()) {
      const activity = delivered.filter(intent => intent.bindingId === `binding-${index}` && intent.kind === "activity");
      expect(activity.map(intent => intent.kind === "activity" ? intent.state : undefined)).toEqual(["active", "idle"]);
    }
  } finally {
    controller.dispose();
    await controller.whenToolUpdatesSettled();
    db.close();
  }
}

describe("messaging backend observable protocol", () => {
  it("delivers one final answer and clears activity for valid sessions and redeliveries", async () => {
    await fc.assert(fc.asyncProperty(session, async input => {
      await runSessions([input], false);
    }), { numRuns: 25 });
  });

  it("keeps concurrently delivered threads and provider identities independent", async () => {
    // Each controller scopes one provider. Several backends may feed it.
    await fc.assert(fc.asyncProperty(fc.array(session, { minLength: 2, maxLength: 3 }), async inputs => {
      const channel = inputs[0]!.channel;
      await runSessions(inputs.map(input => ({ ...input, channel })), true);
    }), { numRuns: 25 });
  });
});
