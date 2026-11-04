import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { StartTurnRequest } from "@pwragent/shared";
import type {
  MessagingAdapter,
  MessagingInboundTextEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { TelegramAdapter, type TelegramBotApi } from "@pwragent/messaging-provider-telegram";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
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
  backend: "codex" | "claude";
  route: "binding" | "default-agent";
  delayMs: number;
  outcome: "started" | "queued" | "failed";
};

const scenario = fc.record({
  backend: fc.constantFrom("codex" as const, "claude" as const),
  route: fc.constantFrom("binding" as const, "default-agent" as const),
  delayMs: fc.integer({ min: FIRST_TYPING_BUDGET_MS + 1, max: 30_000 }),
  outcome: fc.constantFrom("started" as const, "queued" as const, "failed" as const),
});

async function runScenario(input: Scenario, scheduler: fc.Scheduler): Promise<void> {
  let now = 1_000;
  const receivedAt = now;
  const db = openInMemoryStateDb();
  const store = new SqliteMessagingStore(db);
  const startupEntered = gate();
  const startup = gate();
  const response = gate();
  const requests: Array<{ at: number; chatId: number | string; topicId?: number }> = [];
  const states: string[] = [];
  const transport = new TelegramAdapter({
    config: { channel: "telegram", botToken: "12345:fixture", authorizedActorIds: [{ id: "42", displayName: "Fixture" }] },
    now: () => now,
    api: {
      sendChatAction: async (request) => {
        requests.push({ at: now, chatId: request.chat_id, topicId: request.message_thread_id });
        await scheduler.schedule(response.promise, "Telegram response");
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
    actor: { platformUserId: "42" },
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
        executionMode: "default" as const,
        agent: { name: "Fixture", instructionLineCount: 1, instructionsTooLong: false, updatedAt: now },
      },
    }),
    startTurn: async (request: StartTurnRequest) => {
      startupEntered.resolve();
      await scheduler.schedule(startup.promise, "backend preflight");
      if (input.outcome === "failed") throw new Error("Fixture startup failure");
      return { backend: request.backend, threadId: request.threadId, turnId: "turn-1", queueStatus: input.outcome };
    },
  } satisfies Pick<MessagingBackendBridge, "getThreadAdmissionState" | "startTurn">;
  const controller = new MessagingController({
    adapter, backend: backend as MessagingBackendBridge, store,
    authorizedActorIds: ["42"], now: () => now, inputDebounceMs: 0,
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
    // A provider has begun accepting the turn, while its preparation and the
    // Telegram response are both unresolved. The clock advances only here;
    // no real sleep, timer, or model inference participates in this test.
    await startupEntered.promise;
    now += input.delayMs;
    expect(requests[0], "first typing request must precede blocked backend preparation").toBeDefined();
    expect(requests[0]!.at - receivedAt).toBeLessThanOrEqual(FIRST_TYPING_BUDGET_MS);
    expect(requests[0]).toMatchObject({ chatId: -1001, topicId: 1 });
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
}

describe("first typing request (property)", () => {
  it("does not charge backend preparation or Telegram response time to first typing", async () => {
    await fc.assert(fc.asyncProperty(scenario, fc.scheduler(), runScenario), { numRuns: 25 });
  });

  it("requests typing while a ten-second cold start remains blocked", async () => {
    await runScenario({ backend: "codex", route: "default-agent", delayMs: 10_000, outcome: "started" }, fc.schedulerFor([1, 2]));
  });
});
