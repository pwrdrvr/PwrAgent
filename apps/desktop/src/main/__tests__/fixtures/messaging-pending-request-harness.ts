import { setImmediate } from "node:timers/promises";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { MessagingDeliveryResult, MessagingInboundCallbackEvent, MessagingQuestionnaireIntent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { messagingInboundHarness } from "./messaging-inbound-harness";

export async function messagingPendingRequestHarness(options: {
  channel?: "telegram" | "discord";
  backend?: "codex" | "claude";
  route?: "default-agent";
  maxLabelLength?: number;
  clock?: () => number;
} = {}) {
  const f = await messagingInboundHarness(options);
  const submissions: Array<Parameters<NonNullable<MessagingBackendBridge["submitServerRequest"]>>[0]> = [];
  const steers: Array<Parameters<NonNullable<MessagingBackendBridge["steerTurn"]>>[0]> = [];
  const hooks: {
    submit?: () => Promise<void>;
    steer?: () => Promise<void>;
    deliver?: (intent: MessagingSurfaceIntent) => Promise<MessagingDeliveryResult | void>;
  } = {};
  const backend: MessagingBackendBridge = {
    ...f.backend,
    submitServerRequest: async function (request) {
      if (this !== backend) throw new Error("Pending request backend receiver lost");
      f.trace.push("submit:issued");
      await hooks.submit?.();
      submissions.push(request);
      f.trace.push("submit:accepted");
      return { backend: request.backend, threadId: request.threadId, turnId: request.turnId, requestId: request.requestId };
    },
    steerTurn: async function (request) {
      if (this !== backend) throw new Error("Async reply backend receiver lost");
      f.trace.push("steer:issued");
      await hooks.steer?.();
      steers.push(request);
      f.trace.push("steer:accepted");
      return { backend: request.backend, threadId: request.threadId, turnId: request.expectedTurnId };
    },
  };
  f.controllerOptions.backend = backend;
  const profile = f.controllerOptions.adapter.capabilityProfile;
  if (options.maxLabelLength !== undefined && profile.actions) {
    Object.assign(profile, { actions: { ...profile.actions, maxLabelLength: options.maxLabelLength } });
  }
  const deliver = f.controllerOptions.adapter.deliver;
  f.controllerOptions.adapter.deliver = async intent => {
    const result = await hooks.deliver?.(intent);
    return result ?? await deliver(intent);
  };
  const request = (count = 2, id = "fixture-request", turnId?: string): AppServerPendingRequestNotification => ({
    method: "item/tool/requestUserInput",
    params: { threadId: "fixture-thread", requestId: id, turnId, questions: Array.from({ length: count }, (_, index) => ({
      id: "question-" + index, header: "Fixture question", question: "Choose for question " + index,
      isOther: true, isSecret: false,
      options: [{ label: "Choice Alpha", description: "First" }, { label: "Choice Beta", description: "Second" }],
    })) },
  });
  const pending = async (id = "fixture-request") => (await f.store.findActivePendingIntentsForRequest({
    backend: options.backend ?? "codex", threadId: "fixture-thread", requestId: id, now: 1_000,
  }))[0];
  const asyncPending = async () => (await f.store.findActivePendingAsyncQuestionnaires({
    backend: "codex", threadId: "fixture-thread", now: 1_000,
  }))[0];
  const callback = async (actionId: string, sourceSurface?: MessagingInboundCallbackEvent["sourceSurface"]) => {
    const current = await pending() ?? await asyncPending();
    const event: MessagingInboundCallbackEvent = { id: f.event().id, kind: "callback", actor: { platformUserId: "fixture-actor" },
      channel: f.channel, receivedAt: 1_000, actionId,
      interaction: { channel: f.channel.channel, id: "fixture-callback-handle" }, sourceSurface: sourceSurface ?? current?.surface };
    await f.controller.handleInboundEvent(event);
  };
  const emit = async (event: AgentEvent) => { await f.controller.handleBackendEvent(event); await setImmediate(); };
  const begin = async () => {
    f.setThreadStatus("active");
    await emit({ backend: options.backend ?? "codex", notification: { method: "turn/started",
      params: { threadId: "fixture-thread", turnId: "pending-turn", turn: { id: "pending-turn" } } } });
  };
  const presentAsync = async () => {
    await emit({ backend: "codex", notification: { method: "item/completed", params: {
      threadId: "fixture-thread", turnId: "pending-turn", item: { id: "async-fixture", type: "agentMessage",
        phase: "final_answer", text: "Choose an environment", delivery: "async",
        questions: [{ title: "Choose an environment", options: ["Staging", "Production"] }] },
    } } });
  };
  const questionnaires = () => f.deliveries.filter((intent): intent is MessagingQuestionnaireIntent => intent.kind === "questionnaire");
  return { ...f, backend, inputHooks: f.hooks, hooks, submissions, steers, request, pending, asyncPending, callback, emit, begin, presentAsync, questionnaires };
}
