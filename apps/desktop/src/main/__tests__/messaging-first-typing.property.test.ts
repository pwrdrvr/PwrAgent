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
  lifecycle?: "completed" | "approval" | "replacement";
  responseBeforeTransition?: boolean;
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
  // An unsolicited replacement turn has no messaging origin on a Default
  // Agent route. A persistent binding also receives that replacement's activity.
  const replacementOwnsActivity = input.lifecycle === "replacement" && input.route === "binding";
  let now = 1_000;
  const receivedAt = now;
  const db = openInMemoryStateDb();
  const store = new SqliteMessagingStore(db);
  const startupEntered = gate();
  const startup = gate();
  const response = gate();
  const accepted = gate();
  const requests: Array<{ at: number; chatId: number | string; topicId?: number }> = [];
  const states: string[] = [];
  let starts = 0;
  let providerStatus: "idle" | "active" = "idle";
  const transport = new TelegramAdapter({
    config: { channel: "telegram", botToken: "12345:fixture", authorizedActorIds: [{ id: "42", displayName: "Fixture" }] },
    now: () => now,
    api: {
      sendChatAction: async (request) => {
        requests.push({ at: now, chatId: request.chat_id, topicId: request.message_thread_id });
        const ordinal = requests.length;
        if (input.lifecycle) {
          if (ordinal === 1) await response.promise;
        } else {
          await scheduler.schedule(response.promise, "Telegram response");
        }
        if (input.requestFails && ordinal === 1) throw new Error("Fixture typing request failure");
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
      threadStatus: providerStatus,
      thread: {
        id: "thread-1", source: input.backend, title: "Fixture", titleSource: "explicit" as const, linkedDirectories: [],
        inbox: { inInbox: false },
        threadStatus: providerStatus,
        executionMode: denied === "policy" ? "full-access" as const : "default" as const,
        agent: { name: "Fixture", instructionLineCount: 1, instructionsTooLong: false, updatedAt: now },
      },
    }),
    startTurn: async (request: StartTurnRequest) => {
      starts += 1;
      if (starts > 1) return { backend: request.backend, threadId: request.threadId, turnId: "queued-2", queueStatus: "queued" as const };
      startupEntered.resolve();
      if (input.lifecycle) await startup.promise;
      else await scheduler.schedule(startup.promise, "backend preflight");
      if (input.outcome === "failed") throw new Error("Fixture startup failure");
      if (input.outcome === "started") providerStatus = "active";
      return { backend: request.backend, threadId: request.threadId, turnId: "turn-1", queueStatus: input.outcome };
    },
    readThreadStatus: async () => providerStatus,
  } satisfies Pick<MessagingBackendBridge, "getThreadAdmissionState" | "startTurn" | "readThreadStatus">;
  const controller = new MessagingController({
    adapter, backend: backend as unknown as MessagingBackendBridge, store,
    authorizedActorIds: ["42"], now: () => now, inputDebounceMs: 0,
    fullAccessControls: { allowThreadResume: false, allowEscalation: false, warningPolicy: "always" },
    logger: { info: (message) => { if (message === "messaging turn started") accepted.resolve(); } },
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
    if (input.lifecycle) {
      if (input.responseBeforeTransition) response.resolve();
      startup.resolve();
      await accepted.promise;
      if (input.responseBeforeTransition) await handling;
      if (input.lifecycle === "approval") {
        await controller.handleBackendPendingRequest(input.backend, {
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1", requestId: "approval-1", prompt: "Fixture approval", command: "fixture" },
        });
      } else {
        providerStatus = "idle";
        await controller.handleBackendEvent({
          backend: input.backend,
          notification: {
            method: "turn/completed",
            params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "completed", output: [] } },
          },
        });
        if (input.lifecycle === "replacement") {
          providerStatus = "active";
          await controller.handleBackendEvent({
            backend: input.backend,
            notification: {
              method: "turn/started",
              params: { threadId: "thread-1", turnId: "turn-2", turn: { id: "turn-2", status: "running" } },
            },
          });
        }
      }
      const activityCount = states.length;
      const requestCount = requests.length;
      expect(states.at(-1)).toBe(replacementOwnsActivity ? "active" : "idle");
      response.resolve();
      await handling;
      // The provider lifecycle owns the state now. Completing an earlier
      // activity request cannot retry a completed, waiting or superseded turn.
      expect(states.slice(activityCount)).toEqual([]);
      expect(requests).toHaveLength(requestCount);
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
  expect(states.at(-1)).toBe(input.lifecycle && !replacementOwnsActivity
    ? "idle" : input.outcome === "started" ? "active" : "idle");
  if (!input.lifecycle && input.outcome === "started" && input.requestFails) expect(requests).toHaveLength(2);
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

  it("preserves lifecycle ownership across preparation-response orderings", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("completed" as const, "approval" as const, "replacement" as const),
      fc.boolean(), fc.boolean(), fc.boolean(),
      (lifecycle, responseBeforeTransition, requestFails, defaultAgent) => runScenario({
        backend: "codex", route: defaultAgent ? "default-agent" : "binding", delayMs: 101,
        outcome: "started", lifecycle, responseBeforeTransition, requestFails,
      }, fc.schedulerFor([])),
    ), { numRuns: 25 });
  });

  it.each(["completed", "approval", "replacement"] as const)("does not retry a %s turn after the preparation response", async (lifecycle) => {
    await runScenario({ backend: "codex", route: "binding", delayMs: 101, outcome: "started", lifecycle }, fc.schedulerFor([]));
  });

  async function assertReplacementLease(failBeforeReplacement: boolean): Promise<void> {
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
        } as unknown as TelegramBotApi,
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
  }

  it("keeps the replacement lease regardless of the cancelled response order", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), assertReplacementLease), { numRuns: 25 });
  });

  it("does not cancel a replacement lease when the first start fails after idle", async () => {
    await assertReplacementLease(false);
  });
});
