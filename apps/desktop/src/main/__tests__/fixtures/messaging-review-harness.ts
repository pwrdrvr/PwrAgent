import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { MessagingReviewIntent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { messagingInboundHarness } from "./messaging-inbound-harness";

// Only the provider and transport are contrived. Routing, pending records,
// callback selection and delivery run through the actual controller and store.
export async function messagingReviewHarness(channel: "telegram" | "discord" = "telegram", workspaceCount = 1, maxActions?: number) {
  const real = await messagingInboundHarness({ channel, maxActions });
  const trace: string[] = [];
  const receipts = new Map<string, MessagingSurfaceRef>();
  const requests: Array<Parameters<NonNullable<MessagingBackendBridge["submitReview"]>>[0]> = [];
  const controls = { modes: true, autoFix: true, runner: true, available: true, startReview: true,
    refuse: false, outcome: "started" as "started" | "scheduled" };
  const hooks: { submit?: () => Promise<void> } = {};
  const thread: NavigationThreadSummary = {
    id: "fixture-thread", source: "codex", title: "Fixture review target", titleSource: "explicit", inbox: { inInbox: false },
    model: "inherited-model", reasoningEffort: "high", serviceTier: "priority", fastMode: true,
    linkedDirectories: Array.from({ length: workspaceCount }, (_, index) => ({
      id: `fixture-project-${index}`, kind: "local" as const, label: `Fixture project ${index}`, path: `/fixture/project-${index}`,
    })),
  };
  const summary = (kind: "codex" | "claude"): BackendSummary => ({
    kind, label: kind === "codex" ? "Fixture Codex" : "Fixture Claude", available: controls.available, methods: [], executionModes: [],
    capabilities: { listThreads: true, createThread: true, resumeThread: true, renameThread: true, readThread: true,
      startTurn: true, startReview: controls.startReview, interruptTurn: true, steerTurn: true, transcriptPagination: false,
      toolUse: true, approvalRequests: true, multiDirectoryThreads: true, reviewRunner: controls.runner,
      reviewRunMode: controls.modes, reviewAutoFix: controls.autoFix, reviewCodexSubAgent: true },
    launchpadOptions: { models: [{ id: `${kind}-model`, label: `Fixture ${kind} model`, reasoningEfforts: ["low", "high"] }] },
  });
  const backend: MessagingBackendBridge = {
    ...real.backend,
    listBackends: async () => ({ fetchedAt: 1_000, backends: [summary("codex"), summary("claude")] }),
    getNavigationSelectedDetail: async request => ({ protocol: 2, ref: request.ref, revision: "fixture", identity: "present", readiness: "ready", thread,
      workspaceDirectories: thread.linkedDirectories.map(directory => ({ key: directory.id, path: directory.path!, label: directory.label })),
    }),
    getNavigationLaunchpadConfig: async () => ({ protocol: 2, revision: "fixture", defaults: { backend: "codex", executionMode: "default" } }),
    submitReview: async function (request) {
      if (this !== backend) throw new Error("Fixture backend receiver lost");
      requests.push(request); trace.push("submit:issued");
      await hooks.submit?.();
      if (controls.refuse) throw new Error("Fixture review refused");
      trace.push("submit:accepted");
      if (controls.outcome === "scheduled") return { status: "scheduled", pendingReviewId: "fixture-pending-review", invokingTurnId: "fixture-invoking-turn" };
      return { status: "started", response: { backend: request.backend, threadId: request.threadId,
        reviewThreadId: "fixture-review", turnId: "fixture-review-turn" } };
    },
  };
  real.controllerOptions.backend = backend;
  real.controllerOptions.store = new Proxy(real.store, {
    get(target, property) {
      if (property === "deletePendingIntent") return async (id: string) => { trace.push("pending:delete"); return target.deletePendingIntent(id); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const deliver = real.controllerOptions.adapter.deliver.bind(real.controllerOptions.adapter);
  real.controllerOptions.adapter.deliver = async intent => {
    trace.push(`deliver:${intent.kind}`);
    const result = await deliver(intent);
    if (result.surface) receipts.set(intent.id, result.surface);
    return result;
  };
  const pending = () => real.store.findActivePendingIntentForChannel({ channel: real.channel, actorId: "fixture-actor", now: 1_000 });
  const review = (): MessagingReviewIntent => {
    const intent = real.deliveries.filter(intent => intent.kind === "review").at(-1);
    if (!intent) throw new Error("Fixture expected a review picker");
    return intent;
  };
  return {
    ...real, backend, trace, requests, controls, hooks, thread, pending, review, receipts,
    command: async (args: string[] = []) => real.controller.handleInboundEvent({ ...real.event(), kind: "command", command: "review", args, rawText: `/review ${args.join(" ")}` }),
    click: async (actionId: string) => real.controller.handleInboundEvent({ ...real.event(), kind: "callback", actionId,
      interaction: { channel, id: "fixture-review-interaction" }, sourceSurface: (await pending())?.surface }),
  };
}
