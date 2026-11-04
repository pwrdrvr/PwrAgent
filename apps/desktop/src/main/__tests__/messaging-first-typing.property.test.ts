import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { StartTurnRequest } from "@pwragent/shared";
import type {
  MessagingInboundTextEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { TelegramAdapter, type TelegramBotApi } from "@pwragent/messaging-provider-telegram";
import type { MessagingAdapter, MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingController } from "../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// The configured input debounce is a separate, intentional wait. Once an idle
// thread's input has passed admission and policy, a slow backend must not own
// the first typing request. This budget measures requests at the real Telegram
// adapter's API seam, not controller delivery results or provider responses.
const FIRST_TYPING_BUDGET_MS = 100;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type Scenario = {
  backend: "codex" | "claude" | "acp:grok";
  route: "binding" | "default-agent";
  delayMs: number;
  outcome: "started" | "queued" | "failed";
  overlap?: boolean;
  requestFails?: boolean;
};

const scenario = fc.record({
  backend: fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
  route: fc.constantFrom("binding" as const, "default-agent" as const),
  delayMs: fc.integer({ min: FIRST_TYPING_BUDGET_MS + 1, max: 30_000 }),
  outcome: fc.constantFrom("started" as const, "queued" as const, "failed" as const),
  overlap: fc.boolean(),
  requestFails: fc.boolean(),
// Default Agent support for ACP requires a negotiated capability report, and
// Claude is not a supported Default Agent. This fixture supplies neither;
// bound replies exercise both backends without inventing an accepted route.
}).filter((value) => value.backend === "codex" || value.route === "binding");

async function runScenario(input: Scenario, scheduler: fc.Scheduler, denied?: "actor" | "policy"): Promise<void> {
  let now = 1_000;
  const receivedAt = now;
  const db = openInMemoryStateDb();
  const store = new SqliteMessagingStore(db);
  const startupEntered = gate();
  const startup = gate();
  const response = gate();
  const requests: Array<{ at: number; chatId: number | string; topicId?: number }> = [];
  const states: string[] = [];
  let starts = 0;
  const transport = new TelegramAdapter({
    config: { channel: "telegram", botToken: "12345:fixture", authorizedActorIds: [{ id: "42", displayName: "Fixture" }] },
    now: () => now,
    api: {
      sendChatAction: async (request) => {
        requests.push({ at: now, chatId: request.chat_id, topicId: request.message_thread_id });
        await scheduler.schedule(response.promise, "Telegram response");
        if (input.requestFails && requests.length === 1) throw new Error("Fixture typing request failure");
        return true;
      },
    } as TelegramBotApi,
  });
  const adapter: MessagingAdapter = {
    capabilityProfile: transport.capabilityProfile,
    deliver: async (intent: MessagingSurfaceIntent) => {
      if (intent.kind === "activity") {
        states.push(intent.state);
        return await transport.deliver(intent);
      }
      return { channel: "telegram", deliveredAt: now, outcome: "presented" };
    },
  };
  const event: MessagingInboundTextEvent = {
    id: "inbound-fixture",
    kind: "text",
    actor: { platformUserId: denied === "actor" ? "43" : "42" },
    channel: { channel: "telegram", conversation: { id: "-1001", kind: "channel" } },
    routingState: { opaque: { chatId: -1001, messageThreadId: 1 } },
    receivedAt,
    text: "Fixture request",
  };
  const backend = {
    getThreadAdmissionState: async () => ({
      threadStatus: "idle" as const,
      thread: {
        id: "thread-1", source: input.backend, title: "Fixture", linkedDirectories: [],
        executionMode: denied === "policy" ? "full-access" as const : "default" as const,
        agent: { name: "Fixture", instructionLineCount: 1, instructionsTooLong: false, updatedAt: now },
      },
    }),
    startTurn: async (request: StartTurnRequest) => {
      starts += 1;
      if (starts > 1) return { backend: request.backend, threadId: request.threadId, turnId: "queued-2", queueStatus: "queued" as const };
      startupEntered.resolve();
      await scheduler.schedule(startup.promise, "backend preflight");
      if (input.outcome === "failed") throw new Error("Fixture startup failure");
      return { backend: request.backend, threadId: request.threadId, turnId: "turn-1", queueStatus: input.outcome };
    },
  } satisfies Pick<MessagingBackendBridge, "getThreadAdmissionState" | "startTurn">;
  const controller = new MessagingController({
    adapter, backend: backend as MessagingBackendBridge, store,
    authorizedActorIds: ["42"], now: () => now, inputDebounceMs: 0,
    fullAccessControls: { allowThreadResume: false, allowEscalation: false, warningPolicy: "always" },
  });
  let handling: Promise<void> | undefined;
  try {
    if (input.route === "binding") {
      await store.upsertBinding({
        id: "binding-1", backend: input.backend, threadId: "thread-1", channel: event.channel,
        authorizedActorIds: ["42"], routingState: event.routingState, createdAt: now, updatedAt: now,
      });
    } else {
      await store.upsertDefaultAgentAssignment({
        id: "assignment-1", scope: { kind: "conversation", channel: event.channel },
        target: { kind: "agent", backend: input.backend, threadId: "thread-1" }, createdAt: now, updatedAt: now,
      });
    }
    handling = controller.handleInboundEvent(event);
    if (denied) {
      await scheduler.waitFor(handling);
      expect(starts).toBe(0);
      expect(requests).toEqual([]);
      return;
    }
    // A provider has begun accepting the turn, while its preparation and the
    // Telegram response are both unresolved. The clock advances only here;
    // no real sleep, timer, or model inference participates in this test.
    await Promise.race([
      startupEntered.promise,
      handling.then(() => { throw new Error("Input completed before backend startup was reached"); }),
    ]);
    now += input.delayMs;
    expect(requests[0], "first typing request must precede blocked backend preparation").toBeDefined();
    expect(requests[0]!.at - receivedAt).toBeLessThanOrEqual(FIRST_TYPING_BUDGET_MS);
    expect(requests[0]).toMatchObject({ chatId: -1001, topicId: 1 });
    if (input.overlap) {
      await controller.handleInboundEvent({ ...event, id: "second-fixture" });
      expect(states.at(-1), "a queued follow-up cannot stop the preparing attempt").toBe("active");
      expect(requests).toHaveLength(1);
    }
  } finally {
    startup.resolve();
    response.resolve();
    if (handling) await scheduler.waitFor(handling);
    await scheduler.waitIdle();
    controller.dispose();
    await controller.whenToolUpdatesSettled();
    await transport.stop();
    db.close();
  }
  // Reference lifecycle: a started turn keeps activity; a failed or queued
  // attempt on this idle thread must not leave a preparation lease running.
  expect(states.at(-1)).toBe(input.outcome === "started" ? "active" : "idle");
  if (input.outcome === "started" && input.requestFails) expect(requests).toHaveLength(2);
}

describe("first typing request (property)", () => {
  it("does not charge backend preparation or Telegram response time to first typing", async () => {
    await fc.assert(fc.asyncProperty(scenario, fc.scheduler(),
      (input, scheduler) => runScenario(input, scheduler)), { numRuns: 25 });
  });

  it("requests typing while a ten-second cold start remains blocked", async () => {
    await runScenario({ backend: "codex", route: "default-agent", delayMs: 10_000, outcome: "started" }, fc.schedulerFor([1, 2]));
  });

  it("never requests typing for an unauthorized actor or a denied Full Access resume", async () => {
    await fc.assert(fc.asyncProperty(scenario, fc.scheduler(), fc.constantFrom("actor" as const, "policy" as const),
      (input, scheduler, denied) => runScenario(input, scheduler, denied)), { numRuns: 25 });
  });

  it("keeps the replacement lease when a cancelled typing request fails late", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (failBeforeReplacement) => {
      const pending = gate();
      let calls = 0;
      const transport = new TelegramAdapter({
        config: { channel: "telegram", botToken: "12345:fixture", authorizedActorIds: [{ id: "42", displayName: "Fixture" }] },
        api: {
          sendChatAction: async () => {
            calls += 1;
            if (calls === 1) {
              await pending.promise;
              throw new Error("Cancelled request failed late");
            }
            return true;
          },
        } as TelegramBotApi,
      });
      const activity = (id: string, state: "active" | "idle"): MessagingSurfaceIntent => ({
        id, kind: "activity", activity: "typing", state, createdAt: 1_000,
        targetSurface: { channel: "telegram", id: "fixture", state: { opaque: { chatId: -1001, messageThreadId: 1 } } },
      });
      const first = transport.deliver(activity("first", "active"));
      try {
        await transport.deliver(activity("cancel", "idle"));
        if (failBeforeReplacement) {
          pending.resolve();
          await first;
        }
        await transport.deliver(activity("replacement", "active"));
        pending.resolve();
        await first;
        // Reference model: cancellation ended the first lease; replacement
        // owns a second one. An old response cannot end that new lease, so a
        // subsequent activity renews it instead of issuing a third start.
        await transport.deliver(activity("renew", "active"));
        expect(calls).toBe(2);
      } finally {
        pending.resolve();
        await first;
        await transport.stop();
      }
    }), { numRuns: 25 });
  });
});
