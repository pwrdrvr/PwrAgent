import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import fc from "fast-check";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingPendingRequestHarness } from "./fixtures/messaging-pending-request-harness";

type Fixture = Awaited<ReturnType<typeof messagingPendingRequestHarness>>;
type Model = { index: number; answers: Array<string | null>; submitted: boolean };
type Action = "alpha" | "beta" | "text" | "back" | "next" | "submit";
class Answer implements fc.AsyncCommand<Model, Fixture> {
  constructor(readonly action: Action) {}
  check(model: Readonly<Model>) { return !model.submitted; }
  async run(model: Model, f: Fixture) {
    const row = await f.pending();
    expect(row?.intent.kind).toBe("questionnaire");
    if (row?.intent.kind !== "questionnaire") throw new Error("Missing live questionnaire");
    if (this.action === "alpha" || this.action === "beta" || this.action === "text") {
      const index = this.action === "beta" ? 1 : 0;
      model.answers[model.index] = this.action === "text" ? "Fixture custom answer" : index ? "Choice Beta" : "Choice Alpha";
      if (this.action === "text") await f.controller.handleInboundEvent(f.event("  Fixture custom answer  "));
      else await f.callback(row.intent.questions[model.index]!.options[index]!.id);
      if (model.index < model.answers.length - 1) model.index++;
      else model.submitted = model.answers.every(value => value !== null);
    } else {
      if (this.action === "back") model.index = Math.max(0, model.index - 1);
      if (this.action === "next" && model.answers[model.index] !== null) model.index = Math.min(model.answers.length - 1, model.index + 1);
      if (this.action === "submit") model.submitted = model.index === model.answers.length - 1 && model.answers.every(value => value !== null);
      await f.callback("questionnaire:" + this.action);
    }
    const current = await f.pending();
    expect(current === undefined).toBe(model.submitted);
    expect(f.submissions).toHaveLength(model.submitted ? 1 : 0);
    if (current?.intent.kind === "questionnaire") {
      expect({ index: current.intent.currentIndex, answers: current.intent.answers.map(answer => answer?.value ?? null) })
        .toEqual({ index: model.index, answers: model.answers });
    }
    if (model.submitted) {
      expect(f.submissions[0]?.response).toEqual({ answers: Object.fromEntries(model.answers.map((value, index) =>
        ["question-" + index, { answers: value ? [value] : [] }])) });
      expect(f.questionnaires().at(-1)?.phase).toBe("submitted");
    }
  }
  toString() { return this.action; }
}

it("matches an independent answer/cursor protocol through real callbacks, free text and duplicate delivery", async () => {
  const command = fc.constantFrom<Action>("alpha", "beta", "text", "back", "next", "submit").map(action => new Answer(action));
  await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.integer({ min: 1, max: 4 }),
    fc.commands([command], { maxCommands: 12, size: "+1" }), async (channel, count, commands) => {
      const f = await messagingPendingRequestHarness({ channel });
      try {
        const request = f.request(count);
        await f.controller.handleBackendPendingRequest("codex", request);
        await f.controller.handleBackendPendingRequest("codex", request);
        expect(f.questionnaires()).toHaveLength(1);
        const model: Model = { index: 0, answers: Array.from({ length: count }, () => null), submitted: false };
        await fc.asyncModelRun(() => ({ model, real: f }), commands);
        // Every run reaches the final question and actual backend acceptance.
        while (!model.submitted) await new Answer("alpha").run(model, f);
        await f.callback("questionnaire:submit");
        expect(f.submissions).toHaveLength(1);
      } finally { await f.close(); }
    }), { numRuns: 25 });
});

it("coalesces overlapping presentations, releases failed reservations and reads a replacement store at call time", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, fail) => {
    const f = await messagingPendingRequestHarness();
    const entered = Promise.withResolvers<void>();
    let reads = 0;
    f.controllerOptions.store = new Proxy(f.store, { get(target, key) {
      if (key === "findActiveBindingsForThread") return async (...args: Parameters<typeof target.findActiveBindingsForThread>) => {
        reads++; entered.resolve();
        await scheduler.schedule(Promise.resolve(), "binding read");
        if (fail) throw new Error("Fixture binding read failure");
        return await target.findActiveBindingsForThread(...args);
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const work = Promise.allSettled(Array.from({ length: 3 }, () => f.controller.handleBackendPendingRequest("codex", f.request())));
    try {
      await Promise.race([entered.promise, work.then(() => expect.fail("Presentation must reach the current store"))]);
      await scheduler.waitAll();
      const settled = await work;
      expect(reads).toBe(1);
      expect(settled.map(result => result.status)).toEqual(Array.from({ length: 3 }, () => fail ? "rejected" : "fulfilled"));
      f.controllerOptions.store = f.store;
      await expect(f.controller.handleBackendPendingRequest("codex", f.request())).resolves.toBeUndefined();
      expect(f.questionnaires()).toHaveLength(1);
    } finally { await scheduler.waitAll(); await work; await f.close(); }
  }), { numRuns: 25 });
});

it("does not resurrect waiting activity when terminal evidence arrives during presentation delivery", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("completed", "failed", "cancelled"), async (scheduler, terminal) => {
    const f = await messagingPendingRequestHarness();
    const entered = Promise.withResolvers<void>();
    await f.begin();
    f.hooks.deliver = async intent => {
      if (intent.kind === "questionnaire") { entered.resolve(); await scheduler.schedule(Promise.resolve(), "presentation delivery"); }
    };
    const work = f.controller.handleBackendPendingRequest("codex", f.request(1, "fixture-request", "pending-turn"));
    try {
      await Promise.race([entered.promise, work.then(() => expect.fail("Presentation must reach delivery"))]);
      await f.finish(terminal, "pending-turn");
      const binding = await f.store.getBinding("fixture-binding");
      expect(binding).toBeDefined();
      // The canonical owner projects provider cancellation onto its terminal
      // bus status. A late presentation must preserve that observed terminal.
      const settledStatus = messagingModules(f.controller).turns.get(binding!)?.status;
      expect(["completed", "failed", "cancelled"]).toContain(settledStatus);
      await scheduler.waitAll(); await work; await setImmediate();
      expect(await f.pending()).toBeUndefined();
      expect(messagingModules(f.controller).turns.get(binding!)?.status).toBe(settledStatus);
    } finally { await scheduler.waitAll(); await work; await f.close(); }
  }), { numRuns: 25 });
});

it("keeps approvals actionable until backend acceptance, then retires markup and resumes the same waiting turn", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), async (scheduler, channel) => {
    const f = await messagingPendingRequestHarness({ channel });
    const entered = Promise.withResolvers<void>();
    let work: Promise<void> | undefined;
    try {
      await f.begin();
      await f.controller.handleBackendPendingRequest("codex", { method: "item/commandExecution/requestApproval",
        params: { threadId: "fixture-thread", requestId: "fixture-request", turnId: "pending-turn", command: "fixture-command", prompt: "Run fixture?" } });
      const row = await f.pending();
      if (row?.intent.kind !== "approval") throw new Error("Missing fixture approval");
      const binding = await f.store.getBinding("fixture-binding");
      expect(binding).toBeDefined();
      expect(messagingModules(f.controller).turns.get(binding!)?.status).toBe("waiting");
      f.trace.length = 0;
      f.hooks.submit = async () => { entered.resolve(); await scheduler.schedule(Promise.resolve(), "approval acceptance"); };
      work = f.callback(row.intent.decisions[0]!.id);
      await Promise.race([entered.promise, work.then(() => expect.fail("Must reach approval submission"))]);
      expect(await f.pending()).toBeDefined();
      expect(f.submissions).toHaveLength(0);
      expect(messagingModules(f.controller).turns.get(binding!)?.status).toBe("waiting");
      await scheduler.waitAll(); await work;
      expect(await f.pending()).toBeUndefined();
      expect(f.submissions).toHaveLength(1);
      const approvals = f.deliveries.filter(intent => intent.kind === "approval");
      expect(approvals).toHaveLength(2);
      expect(approvals.at(-1)).toMatchObject({ decisions: [], delivery: { fallback: "fail", mode: "update", replaceMarkup: true }, targetSurface: row.surface });
      expect(f.trace.filter(step => step.startsWith("submit:") || step === "deliver:approval")).toEqual(["submit:issued", "submit:accepted", "deliver:approval"]);
      expect(messagingModules(f.controller).turns.get(binding!)).toMatchObject({ turnId: "pending-turn", status: "working" });
      await f.emit({ backend: "codex", notification: { method: "serverRequest/resolved",
        params: { threadId: "fixture-thread", requestId: "fixture-request" } } });
      expect(f.deliveries.filter(intent => intent.kind === "approval")).toHaveLength(2);
    } finally { await scheduler.waitAll(); await work; await f.close(); }
  }), { numRuns: 25 });
});

it("keeps presentation reservations and deliveries isolated by provider and owning instance", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), async (scheduler, channel) => {
    const f = await messagingPendingRequestHarness({ channel });
    try {
      const original = await f.store.getBinding("fixture-binding");
      if (!original) throw new Error("Missing fixture binding");
      const target = { scope: "remote" as const, instanceId: "fixture-peer" };
      await f.store.upsertBinding({ ...original, id: "remote-binding",
        channel: { ...f.channel, conversation: { ...f.channel.conversation, id: "remote-conversation" } },
        federatedThread: buildFederatedThreadRef({ backend: "codex", threadId: "fixture-thread", instanceId: target.instanceId }) });
      await f.store.upsertBinding({ ...original, id: "foreign-provider-binding",
        channel: { ...f.channel, channel: channel === "telegram" ? "discord" : "telegram" } });
      let reads = 0;
      f.controllerOptions.store = new Proxy(f.store, { get(store, key) {
        if (key === "findActiveBindingsForThread") return async (...args: Parameters<typeof store.findActiveBindingsForThread>) => {
          reads++; await scheduler.schedule(Promise.resolve(), "scoped binding read");
          return await store.findActiveBindingsForThread(...args);
        };
        const value = Reflect.get(store, key, store); return typeof value === "function" ? value.bind(store) : value;
      } });
      const work = Promise.all([
        f.controller.handleBackendPendingRequest("codex", f.request()),
        f.controller.handleBackendPendingRequest("codex", f.request(), target),
      ]);
      await scheduler.waitAll(); await work;
      expect(reads).toBe(2);
      expect(f.questionnaires().map(intent => intent.bindingId).sort()).toEqual(["fixture-binding", "remote-binding"]);
      expect((await f.store.findActivePendingIntentsForRequest({
        backend: "codex", threadId: "fixture-thread", requestId: "fixture-request", now: 1_000,
      })).map(row => row.bindingId).sort()).toEqual(["fixture-binding", "remote-binding"]);
    } finally { await scheduler.waitAll(); await f.close(); }
  }), { numRuns: 25 });
});

it("routes async replies through accepted steering or canonical admission and restores cards after refused sending", async () => {
  const scenario = fc.constantFrom("idle-start", "idle-queued", "idle-failed", "busy-steer", "busy-fallback", "busy-failed", "admission-failed");
  await fc.assert(fc.asyncProperty(scenario, fc.constantFrom("telegram", "discord"), async (mode, channel) => {
    const f = await messagingPendingRequestHarness({ channel });
    try {
      await f.begin(); await f.presentAsync();
      const row = await f.asyncPending();
      if (row?.intent.kind !== "questionnaire") throw new Error("Missing fixture async question");
      const expectsFailure = mode === "idle-failed" || mode === "busy-failed" || mode === "admission-failed";
      if (mode.startsWith("idle")) f.setThreadStatus("idle");
      if (mode === "idle-queued") f.inputHooks.outcome = "queued";
      if (mode === "idle-failed" || mode === "busy-failed") f.inputHooks.outcome = "failed";
      if (mode === "admission-failed") f.inputHooks.admission = async () => { throw new Error("Fixture admission read failure"); };
      f.hooks.steer = async () => {
        expect(await f.asyncPending()).toBeUndefined();
        if (mode === "busy-fallback" || mode === "busy-failed") throw new Error("Fixture steering failure");
      };
      f.inputHooks.start = async () => { expect(await f.asyncPending()).toBeUndefined(); };
      await f.callback(row.intent.questions[0]!.options[1]!.id);
      expect(f.submissions).toHaveLength(0);
      expect((await f.asyncPending()) !== undefined).toBe(expectsFailure);
      expect(f.questionnaires().at(-1)?.phase).toBe(expectsFailure ? "answering" : "submitted");
      expect(f.steers).toHaveLength(mode === "busy-steer" ? 1 : 0);
      expect(f.starts).toHaveLength(mode === "busy-steer" || mode === "admission-failed" ? 0 : 1);
      if (!expectsFailure) {
        const input = mode === "busy-steer" ? f.steers[0]!.input : f.starts[0]!.input;
        const itemId = JSON.stringify(["request_user_input_async", "async-fixture", 0]);
        const text = "<send_user_message_question_reply>\n" + JSON.stringify([
          { answer: "Production", question: "Choose an environment", questionItemId: itemId },
        ]) + "\n</send_user_message_question_reply>";
        expect(input).toEqual([{ type: "text", text }]);
        if (mode === "busy-steer") expect(f.steers[0]).toMatchObject({ expectedTurnId: "pending-turn", threadId: "fixture-thread", backend: "codex" });
      }
    } finally { await f.close(); }
  }), { numRuns: 25 });
});

it("retires async cards after skip, invisible delivery or an owning-instance answer, without capturing later text", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("skip", "failed-delivery", "external-answer"), fc.constantFrom("telegram", "discord"), async (mode, channel) => {
    const f = await messagingPendingRequestHarness({ channel });
    try {
      await f.begin();
      if (mode === "failed-delivery") f.hooks.deliver = async intent => intent.kind === "questionnaire"
        ? { outcome: "failed", channel, deliveredAt: 1_000, errorMessage: "Fixture invisible question" } : undefined;
      await f.presentAsync();
      if (mode === "skip") {
        expect(await f.asyncPending()).toBeDefined();
        await f.callback("questionnaire:skip");
        expect(f.questionnaires().at(-1)?.phase).toBe("skipped");
      }
      if (mode === "external-answer") {
        await f.finish("completed", "pending-turn");
        f.setThreadStatus("active");
        await f.emit({ backend: "codex", notification: { method: "turn/started",
          params: { threadId: "fixture-thread", turnId: "reply-turn", turn: { id: "reply-turn" } } } });
        const questionItemId = JSON.stringify(["request_user_input_async", "async-fixture", 0]);
        const text = "<send_user_message_question_reply>\n" + JSON.stringify([
          { answer: "Production", question: "Choose an environment", questionItemId },
        ]) + "\n</send_user_message_question_reply>";
        const notification = { method: "item/completed" as const, params: { threadId: "fixture-thread", turnId: "reply-turn",
          item: { id: "external-reply", type: "userMessage", content: [{ type: "text", text }] } } };
        await f.emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "foreign-owner" }, notification });
        expect(await f.asyncPending()).toBeDefined();
        await f.emit({ backend: "codex", notification });
        expect(f.questionnaires().at(-1)).toMatchObject({ phase: "submitted", answers: [{ kind: "option", value: "Production" }] });
        const presentations = f.questionnaires().length;
        await f.emit({ backend: "codex", notification });
        expect(f.questionnaires()).toHaveLength(presentations);
        await f.finish("completed", "reply-turn");
      }
      expect(await f.asyncPending()).toBeUndefined();
      expect(f.submissions).toHaveLength(0);
      f.setThreadStatus("idle");
      await f.controller.handleInboundEvent(f.event("A plain later reply"));
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]?.input).toEqual([{ type: "text", text: "A plain later reply" }]);
    } finally { await f.close(); }
  }), { numRuns: 25 });
});

it("persists an answer update only after delivery settles and records the returned editable surface", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), async (scheduler, channel) => {
    const f = await messagingPendingRequestHarness({ channel });
    let work: Promise<void> | undefined;
    try {
      await f.controller.handleBackendPendingRequest("codex", f.request(2));
      const row = await f.pending();
      if (row?.intent.kind !== "questionnaire") throw new Error("Missing fixture questionnaire");
      const entered = Promise.withResolvers<void>();
      const surface = { channel, id: "fixture-edited-surface" };
      f.hooks.deliver = async intent => {
        if (intent.kind !== "questionnaire") return;
        entered.resolve(); await scheduler.schedule(Promise.resolve(), "questionnaire update");
        return { outcome: "updated", channel, deliveredAt: 1_000, surface };
      };
      work = f.callback(row.intent.questions[0]!.options[0]!.id);
      await Promise.race([entered.promise, work.then(() => expect.fail("Answer must reach delivery"))]);
      expect((await f.pending())?.intent).toMatchObject({ currentIndex: 0, answers: [null, null] });
      await scheduler.waitAll(); await work;
      expect(await f.pending()).toMatchObject({ surface, intent: {
        currentIndex: 1, answers: [{ kind: "option", value: "Choice Alpha" }, null],
      } });
    } finally { await scheduler.waitAll(); await work; await f.close(); }
  }), { numRuns: 25 });
});

it("retires externally resolved requests only for the owning instance and resumes without submitting another response", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("telegram", "discord"), async (approval, channel) => {
    const f = await messagingPendingRequestHarness({ channel });
    try {
      await f.begin();
      await f.controller.handleBackendPendingRequest("codex", approval
        ? { method: "item/commandExecution/requestApproval", params: {
          threadId: "fixture-thread", requestId: "fixture-request", turnId: "pending-turn", command: "fixture-command", prompt: "Run fixture?",
        } } : f.request(1, "fixture-request", "pending-turn"));
      const binding = await f.store.getBinding("fixture-binding");
      if (!binding) throw new Error("Missing fixture binding");
      const notification = { method: "serverRequest/resolved" as const, params: {
        threadId: "fixture-thread", requestId: "fixture-request",
      } };
      await f.emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "foreign-owner" }, notification });
      expect(await f.pending()).toBeDefined();
      expect(messagingModules(f.controller).turns.get(binding)?.status).toBe("waiting");
      await f.emit({ backend: "codex", notification });
      expect(await f.pending()).toBeUndefined();
      expect(messagingModules(f.controller).turns.get(binding)).toMatchObject({ turnId: "pending-turn", status: "working" });
      expect(f.submissions).toHaveLength(0);
      const deliveries = f.deliveries.length;
      await f.emit({ backend: "codex", notification });
      expect(f.deliveries).toHaveLength(deliveries);
    } finally { await f.close(); }
  }), { numRuns: 25 });
});

it("honors detach and shutdown before a pending presentation's binding read settles", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("detach", "shutdown"), async (scheduler, mode) => {
    const f = await messagingPendingRequestHarness();
    const entered = Promise.withResolvers<void>();
    f.controllerOptions.store = new Proxy(f.store, { get(target, key) {
      if (key === "findActiveBindingsForThread") return async (...args: Parameters<typeof target.findActiveBindingsForThread>) => {
        entered.resolve(); await scheduler.schedule(Promise.resolve(), "pending binding lookup");
        return await target.findActiveBindingsForThread(...args);
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const work = f.controller.handleBackendPendingRequest("codex", f.request());
    try {
      await Promise.race([entered.promise, work.then(() => expect.fail("Presentation must reach binding lookup"))]);
      if (mode === "detach") {
        const text = f.event();
        await f.controller.handleInboundEvent({ id: text.id, channel: text.channel, actor: text.actor, receivedAt: text.receivedAt,
          kind: "command", command: "detach", args: [], rawText: "/detach" });
        expect((await f.store.getBinding("fixture-binding"))?.revokedAt).toBeDefined();
      } else f.controller.dispose();
      const delivered = f.deliveries.length;
      await scheduler.waitAll();
      await expect(work).resolves.toBeUndefined();
      expect(f.deliveries).toHaveLength(delivered);
      expect(f.questionnaires()).toHaveLength(0);
      expect(f.starts).toHaveLength(0);
      if (mode === "detach") expect(await f.pending()).toBeUndefined();
    } finally { await scheduler.waitAll(); await work; await f.close(); }
  }), { numRuns: 25 });
});

it("preserves the pending form when backend submission fails and retires it only after acceptance", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), async (scheduler, channel) => {
    const f = await messagingPendingRequestHarness({ channel });
    try {
      await f.controller.handleBackendPendingRequest("codex", f.request(1));
      const row = await f.pending();
      if (row?.intent.kind !== "questionnaire") throw new Error("Missing fixture questionnaire");
      f.hooks.submit = async () => { throw new Error("Fixture submission failure"); };
      await expect(f.callback(row.intent.questions[0]!.options[0]!.id)).rejects.toThrow("Fixture submission failure");
      expect(await f.pending()).toBeDefined();
      expect(f.submissions).toHaveLength(0);
      expect(f.questionnaires().some(intent => intent.phase === "submitted")).toBe(false);
      const entered = Promise.withResolvers<void>();
      f.hooks.submit = async () => { entered.resolve(); await scheduler.schedule(Promise.resolve(), "submission acceptance"); };
      const sent = f.callback(row.intent.questions[0]!.options[0]!.id);
      await Promise.race([entered.promise, sent.then(() => expect.fail("Must reach backend submission"))]);
      expect(await f.pending()).toBeDefined();
      expect(f.questionnaires().some(intent => intent.phase === "submitted")).toBe(false);
      await scheduler.waitAll(); await sent;
      expect(await f.pending()).toBeUndefined();
      expect(f.submissions).toHaveLength(1);
      expect(f.questionnaires().at(-1)?.phase).toBe("submitted");
    } finally { await scheduler.waitAll(); await f.close(); }
  }), { numRuns: 25 });
});

it("preserves full answer values while adapting labels to the current provider capability", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.integer({ min: 3, max: 8 }), async (channel, maxLabelLength) => {
    const f = await messagingPendingRequestHarness({ channel, maxLabelLength });
    try {
      await f.controller.handleBackendPendingRequest("codex", f.request(1));
      const intent = f.questionnaires()[0]!;
      expect(intent.questions[0]!.options.every(option => option.label.length <= maxLabelLength)).toBe(true);
      expect(intent.questions[0]!.options.map(option => option.value)).toEqual(["Choice Alpha", "Choice Beta"]);
      await f.callback(intent.questions[0]!.options[1]!.id);
      expect(f.submissions[0]?.response).toEqual({ answers: { "question-0": { answers: ["Choice Beta"] } } });
    } finally { await f.close(); }
  }), { numRuns: 25 });
});
