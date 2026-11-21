import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MessagingCommandHandlers } from "../messaging/core/messaging-command-handlers";
import { commandBinding, commandEvent, commandHarness } from "./fixtures/messaging-command-harness";

// Independent policy table: permission before scope before effect; only local
// detach and the two pickers bypass the remote scope check. Review also needs
// reply permission. Do not derive this table from dispatch.
const cases = [
  { command: "status", args: [], permission: true, scope: true, tail: ["status"] },
  { command: "status", args: ["handoff"], permission: true, scope: true, tail: ["handoff"] },
  { command: "resume", args: [], permission: true, scope: false, tail: ["resume"] },
  { command: "agent", args: [], permission: true, scope: false, tail: ["agent"] },
  { command: "new", args: ["fixture"], permission: true, scope: true, tail: ["new"] },
  { command: "detach", args: [], permission: true, scope: false, tail: ["detach"] },
  { command: "monitor", args: ["stop"], permission: true, scope: true, tail: ["monitor-stop"] },
  { command: "agent", args: ["default", "set"], permission: true, scope: false, tail: ["default-set"] },
  { command: "agent", args: ["default", "clear"], permission: true, scope: false, tail: ["default-clear"] },
  { command: "agent", args: ["default"], permission: true, scope: false, tail: ["default-status"] },
  { command: "review", args: [], permission: true, scope: false, tail: ["binding", "review-picker"] },
  { command: "review", args: ["--custom", "Fixture"], permission: true, scope: false, tail: ["binding", "review"] },
  { command: "review", args: ["--pr", "1", "2"], permission: true, scope: false, tail: ["binding", "review"] },
  { command: "unknown", args: ["fixture"], permission: false, scope: false, tail: ["binding", "input:/unknown fixture"] },
  { command: "help", args: [], permission: false, scope: true, tail: ["binding", "deliver"] },
  { command: "schedule", args: [], permission: true, scope: true, tail: ["binding", "deliver"] },
  { command: "scheduled", args: [], permission: true, scope: true, tail: ["binding", "deliver"] },
  { command: "continue", args: [], permission: true, scope: true, tail: ["permission", "binding", "scope", "deliver"] },
];
type Model = { permission: boolean; scope: boolean };
type Real = ReturnType<typeof commandHarness> & Model;

describe("messaging command owner protocol", () => {
  it("routes valid command sessions through permission and scope in order", async () => {
    const change = fc.record({ permission: fc.boolean(), scope: fc.boolean() }).map(next => ({
      check: () => true,
      run: async (model: Model, real: Real) => { model.permission = real.permission = next.permission; model.scope = real.scope = next.scope; },
      toString: () => `access(${JSON.stringify(next)})`,
    }));
    const dispatch = fc.constantFrom(...cases).map(spec => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        real.trace.length = 0;
        await real.owner.handleCommand(commandEvent(spec.command, spec.args));
        const expected: string[] = [];
        if (spec.permission) expected.push("permission");
        if (!spec.permission || model.permission) {
          if (spec.scope) expected.push("binding", "scope");
          if (!spec.scope || model.scope) expected.push(...spec.tail);
        }
        expect(real.trace).toEqual(expected);
      },
      toString: () => `dispatch(${spec.command},${spec.args.join(" ")})`,
    }));
    await fc.assert(fc.asyncProperty(fc.commands([change, dispatch], { maxCommands: 18 }), async commands => {
      const access = { permission: true, scope: true };
      const f = commandHarness({
        requirePermission: async () => { f.trace.push("permission"); return access.permission; },
        requireRemoteScopeForBinding: async () => { f.trace.push("scope"); return access.scope; },
      });
      const real: Real = {
        ...f,
        get permission() { return access.permission; },
        set permission(value: boolean) { access.permission = value; },
        get scope() { return access.scope; },
        set scope(value: boolean) { access.scope = value; },
      };
      await fc.asyncModelRun(() => ({ model: { permission: true, scope: true }, real }), commands);
    }), { numRuns: 70, seed: 1493805 });
  });

  it("requires reply permission before checking peer scope or submitting a PR review", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (remote, canReply, canControlPeer) => {
      const binding = remote ? { ...commandBinding, federatedThread: {
        backend: commandBinding.backend, threadId: commandBinding.threadId,
        target: { scope: "remote" as const, instanceId: "peer" },
      } } : commandBinding;
      const f = commandHarness({
        requirePermission: async (_event, permission) => { f.trace.push(permission); return canReply; },
        requireRemoteScopeForBinding: async () => { f.trace.push("peer scope"); return canControlPeer; },
      });
      const owner = new MessagingCommandHandlers({ ...f.context, store: {
        findActiveBindingForChannel: async () => { f.trace.push("binding"); return binding; },
      } });
      await owner.handleCommand(commandEvent("review", ["--pr", "1,2"]));
      const expected = ["message.reply"];
      if (canReply) {
        expected.push("binding");
        if (remote) expected.push("peer scope");
        if (!remote || canControlPeer) expected.push("review");
      }
      expect(f.trace).toEqual(expected);
    }));
  });

  it("reads optional mutation getters inside their existing catch boundary and binds list to its backend", async () => {
    const f = commandHarness();
    let gets = 0;
    const backend: typeof f.context.backend = {
      listScheduledThreadActions: async function () {
        expect(this).toBe(backend);
        return { actions: [{ id: "action", backend: "codex", threadId: "thread", kind: "turn", origin: "messaging", status: "scheduled", scheduledFor: 2_000, displayText: "Fixture", createdAt: 1_000, updatedAt: 1_000 }] };
      },
      get cancelScheduledThreadAction(): NonNullable<typeof f.context.backend.cancelScheduledThreadAction> { gets += 1; throw new Error("Fixture getter failure"); },
    };
    const owner = new MessagingCommandHandlers({ ...f.context, backend });
    await expect(owner.handleCommand(commandEvent("scheduled", ["cancel", "action"]))).resolves.toBeUndefined();
    expect(gets).toBe(1);
    expect(f.delivered).toEqual([expect.objectContaining({ kind: "error", body: "Fixture getter failure" })]);
  });

  it("propagates list getter and schedule creation failures instead of changing their error boundary", async () => {
    const f = commandHarness();
    const list = new MessagingCommandHandlers({ ...f.context, backend: { get listScheduledThreadActions(): NonNullable<typeof f.context.backend.listScheduledThreadActions> { throw new Error("List getter"); } } });
    await expect(list.handleCommand(commandEvent("scheduled"))).rejects.toThrow("List getter");
    const create = new MessagingCommandHandlers({ ...f.context, backend: { createScheduledThreadAction: async () => { throw new Error("Create failure"); } } });
    await expect(create.handleCommand(commandEvent("schedule", ["2m", "Fixture"]))).rejects.toThrow("Create failure");
    expect(f.delivered).toEqual([]);
  });

  it("reads host and store after each await rather than capturing an earlier overlay", async () => {
    const f = commandHarness();
    let current = f.host;
    let currentStore = f.context.store;
    const owner = new MessagingCommandHandlers({
      ...f.context, host: () => current, get store() { return currentStore; },
    });
    const first = f.host;
    current = { ...first, requirePermission: async () => {
      await setImmediate();
      currentStore = { findActiveBindingForChannel: async () => ({ ...commandBinding, threadId: "replacement" }) };
      current = { ...first, requireRemoteScopeForBinding: async (_event, binding) => {
        expect(binding?.threadId).toBe("replacement"); return true;
      }, presentStatus: async () => { f.trace.push("replacement-status"); } };
      return true;
    } };
    await owner.handleCommand(commandEvent("status"));
    expect(f.trace).toEqual(["replacement-status"]);
  });

  it("awaits the workflow promise and preserves its rejection", async () => {
    const failure = new Error("Status failure");
    const f = commandHarness({ presentStatus: async () => { await setImmediate(); throw failure; } });
    await expect(f.owner.handleCommand(commandEvent("status"))).rejects.toBe(failure);
  });

  it("keeps concurrent deliveries independent across scheduled permission continuations", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), fc.boolean(), async (scheduler, firstAllowed, secondAllowed) => {
      const projection = new Map<string, string[]>();
      const record = (id: string, effect: string) => { projection.set(id, [...projection.get(id) ?? [], effect]); };
      const f = commandHarness({
        requirePermission: async event => {
          record(event.id, "permission");
          return await scheduler.schedule(Promise.resolve(event.id === "first" ? firstAllowed : secondAllowed), event.id);
        },
        requireRemoteScopeForBinding: async event => { record(event.id, "scope"); return true; },
        presentStatus: async event => { record(event.id, "status"); },
      });
      const first = f.owner.handleCommand({ ...commandEvent("status"), id: "first" });
      const second = f.owner.handleCommand({ ...commandEvent("status"), id: "second" });
      await scheduler.waitFor(Promise.all([first, second]));
      await setImmediate();
      expect(projection.get("first")).toEqual(firstAllowed ? ["permission", "scope", "status"] : ["permission"]);
      expect(projection.get("second")).toEqual(secondAllowed ? ["permission", "scope", "status"] : ["permission"]);
    }), { numRuns: 20 });
  });

  it("does not read collaborators while constructing an owner", () => {
    const f = commandHarness();
    let reads = 0;
    new MessagingCommandHandlers({
      get store() { reads += 1; return f.context.store; },
      get backend() { reads += 1; return f.context.backend; },
      get capabilityProfile() { reads += 1; return f.context.capabilityProfile; },
      get now() { reads += 1; return f.context.now; },
      host: () => { reads += 1; return f.host; },
    });
    expect(reads).toBe(0);
  });

  it("honors provider action budgets when updating help", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 3, max: 12 }), async maxActions => {
      const f = commandHarness();
      const actions = f.context.capabilityProfile.actions;
      if (!actions) throw new Error("Fixture needs action capabilities");
      const owner = new MessagingCommandHandlers({ ...f.context, capabilityProfile: {
        ...f.context.capabilityProfile, actions: { ...actions, maxActions },
      } });
      await owner.presentHelp(commandEvent("help"), { targetSurface: { id: "existing", channel: "telegram" } });
      const intent = f.delivered[0];
      expect(intent).toMatchObject({ kind: "confirmation", delivery: { mode: "update", replaceMarkup: true }, targetSurface: { id: "existing" }, body: expect.stringContaining("/review") });
      if (intent.kind !== "confirmation") throw new Error("Missing help confirmation");
      expect(intent.actions.length).toBeLessThanOrEqual(maxActions);
    }), { numRuns: 10 });
  });
});

describe("messaging /code-review", () => {
  /**
   * Rule: a bare /code-review on a thread that reviews as Claude Code is a
   * PwrAgent review like /review: reply permission, then peer scope for a
   * peer's thread, then one Claude Code review of the current changes.
   * Anywhere else, or with arguments, it goes to the thread as typed.
   */
  it("starts a tracked Claude Code review only for a bare command on a supporting thread", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<string[]>([], ["high"], ["12"], ["--fix"]),
      fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
      async (args, supported, remote, canReply, canControlPeer, addressed) => {
        const binding = {
          ...commandBinding,
          targetKind: "agent_thread" as const,
          ...(remote ? { federatedThread: {
            backend: commandBinding.backend, threadId: commandBinding.threadId,
            target: { scope: "remote" as const, instanceId: "peer" },
          } } : {}),
        };
        const submissions: unknown[] = [];
        const f = commandHarness({
          claudeCodeReviewSupportedForBinding: async () => { f.trace.push("supported"); return supported; },
          requirePermission: async (_event, permission) => { f.trace.push(permission); return canReply; },
          requireRemoteScopeForBinding: async () => { f.trace.push("peer scope"); return canControlPeer; },
          submitMessagingReview: async (params) => { f.trace.push("review"); submissions.push(params); },
          shouldHandleAmbientSharedMessage: async () => { f.trace.push("ambient"); return addressed; },
        });
        const owner = new MessagingCommandHandlers({ ...f.context, store: {
          findActiveBindingForChannel: async () => { f.trace.push("binding"); return binding; },
        } });
        await owner.handleCommand(commandEvent("code-review", args));
        const typed = `input:/code-review${args.length ? ` ${args.join(" ")}` : ""}`;
        const expected: string[] = [];
        // A shared conversation ignores a command not addressed to PwrAgent,
        // whether it would start a review or go to the thread as typed.
        if (args.length > 0 || !supported) {
          expected.push("binding", ...(args.length > 0 ? [] : ["supported"]), "ambient");
          if (addressed) expected.push(typed);
        } else if (!addressed) {
          expected.push("binding", "supported", "ambient");
        } else {
          expected.push("binding", "supported", "ambient", "message.reply");
          if (canReply) {
            if (remote) expected.push("peer scope");
            if (!remote || canControlPeer) expected.push("review");
          }
        }
        expect(f.trace).toEqual(expected);
        expect(submissions).toEqual(f.trace.includes("review")
          ? [expect.objectContaining({ runMode: "claude-code-review", target: { type: "uncommittedChanges" } })]
          : []);
      },
    ));
  });
});

describe("messaging /review on an owner without review/start", () => {
  /**
   * Rule: a bare /review opens the picker where the owner runs review/start
   * or Claude Code's /code-review; typed targets still need review/start.
   */
  it("opens the picker for Claude Code and refuses typed targets it cannot run", async () => {
    await fc.assert(fc.asyncProperty(
      fc.boolean(), fc.boolean(), fc.constantFrom<string[]>([], ["--custom", "Fixture"], ["main"]),
      async (startReview, claudeCode, args) => {
        const f = commandHarness({
          reviewSupportedForBinding: async () => startReview,
          claudeCodeReviewSupportedForBinding: async () => claudeCode,
        });
        await f.owner.handleCommand(commandEvent("review", args));
        const runs = startReview || (args.length === 0 && claudeCode);
        expect(f.trace.at(-1)).toBe(!runs ? "unsupported" : args.length === 0 ? "review-picker" : "review");
      },
    ));
  });
});
