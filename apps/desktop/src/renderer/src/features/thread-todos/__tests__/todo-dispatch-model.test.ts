import { describe, expect, it } from "vitest";
import {
  resolveThreadTodoModelSettings,
  sameThreadTodoModelSettings,
  type BackendSummary,
  type ThreadTodoAction,
} from "@pwragent/shared";
import { fitTodoDispatchSettings, todoDispatchMachines, todoDispatchSpeed } from "../todo-dispatch-model";

const thread = { backend: "claude" as const, model: "opus", reasoningEffort: "high" };
const lastDispatch = { backend: "codex" as const, model: "sol", reasoningEffort: "high" };
const pick = { backend: "claude" as const, model: "sonnet", reasoningEffort: "medium" };
const action: ThreadTodoAction = { type: "start_thread", prompt: "Build it", reasoningEffort: "xhigh" };

describe("to-do dispatch precedence", () => {
  it("resolves card pick, thread memory, suggestion, then thread settings", () => {
    expect(resolveThreadTodoModelSettings({ thread, action, lastDispatch, pick })).toEqual({ settings: pick, source: "pick" });
    expect(resolveThreadTodoModelSettings({ thread, action, lastDispatch })).toEqual({ settings: lastDispatch, source: "memory" });
    expect(resolveThreadTodoModelSettings({ thread, action })).toEqual({ settings: { ...thread, reasoningEffort: "xhigh" }, source: "suggestion" });
    expect(resolveThreadTodoModelSettings({ thread })).toEqual({ settings: thread, source: "thread" });
  });

  it("inherits just the missing fields of an agent suggestion", () => {
    expect(resolveThreadTodoModelSettings({ thread, action: { ...action, model: "sonnet", reasoningEffort: undefined } }).settings)
      .toEqual({ ...thread, model: "sonnet" });
    expect(sameThreadTodoModelSettings(thread, { ...thread })).toBe(true);
    expect(sameThreadTodoModelSettings(thread, { ...thread, backend: "codex" })).toBe(false);
  });
});

const claude = {
  kind: "claude", label: "Claude", available: true, capabilities: { createThread: true },
  launchpadOptions: { models: [
    { id: "opus", label: "Opus 5.5", current: true, reasoningEfforts: ["medium", "high"] },
    { id: "sonnet", label: "Sonnet 5.5", reasoningEfforts: ["low", "medium"] },
  ] },
} as BackendSummary;
const codex = {
  kind: "codex", label: "OpenAI", available: true, capabilities: { createThread: true },
  launchpadOptions: { models: [
    { id: "sol", label: "GPT-6.1-Sol", current: true, reasoningEfforts: ["medium", "high"], supportsFast: true, serviceTiers: ["ultrafast"] },
    { id: "mini", label: "Mini", reasoningEfforts: ["low"], supportsFast: false },
  ] },
} as BackendSummary;

describe("fitting a handoff to another machine's catalog", () => {
  it("keeps settings the machine can run", () => {
    expect(fitTodoDispatchSettings(thread, [codex, claude])).toEqual({ settings: thread, fit: "kept" });
    // A provider that lists no models refutes nothing.
    expect(fitTodoDispatchSettings(thread, [{ ...claude, launchpadOptions: { models: [] } } as BackendSummary]))
      .toEqual({ settings: thread, fit: "kept" });
  });

  it("changes only what the machine lacks", () => {
    expect(fitTodoDispatchSettings({ ...thread, model: "sonnet" }, [claude]))
      .toEqual({ settings: { backend: "claude", model: "sonnet", reasoningEffort: "low" }, fit: "effort" });
    expect(fitTodoDispatchSettings({ ...thread, model: "haiku" }, [claude]))
      .toEqual({ settings: { backend: "claude", model: "opus", reasoningEffort: "high" }, fit: "model" });
    expect(fitTodoDispatchSettings(thread, [codex]))
      .toEqual({ settings: { backend: "codex", model: "sol", reasoningEffort: "high" }, fit: "provider" });
  });

  it("skips providers that cannot start a thread, and waits for an empty catalog", () => {
    const offline = { ...claude, available: false } as BackendSummary;
    expect(fitTodoDispatchSettings(thread, [offline, codex])?.fit).toBe("provider");
    expect(fitTodoDispatchSettings(thread, [offline])).toBeUndefined();
    expect(fitTodoDispatchSettings(thread, [])).toBeUndefined();
    expect(fitTodoDispatchSettings(thread, undefined)).toBeUndefined();
  });
});

describe("handoff speed", () => {
  it("offers Codex speeds the model has, Ultrafast only on the card's own machine", () => {
    expect(todoDispatchSpeed({ backend: codex, model: "sol", fastAllowed: true, onOwner: true, preferred: "ultrafast" }))
      .toEqual({ options: ["standard", "fast", "ultrafast"], speed: "ultrafast" });
    expect(todoDispatchSpeed({ backend: codex, model: "sol", fastAllowed: true, onOwner: false, preferred: "ultrafast" }))
      .toEqual({ options: ["standard", "fast"], speed: "standard" });
    expect(todoDispatchSpeed({ backend: codex, fastAllowed: true, onOwner: false, preferred: "fast" }))
      .toEqual({ options: ["standard", "fast"], speed: "fast" });
  });

  it("locks Standard when Settings turned Fast off, or the model has no Fast", () => {
    expect(todoDispatchSpeed({ backend: codex, model: "sol", fastAllowed: false, onOwner: true, preferred: "fast" }))
      .toEqual({ options: ["standard"], speed: "standard", locked: "settings" });
    expect(todoDispatchSpeed({ backend: codex, model: "mini", fastAllowed: true, onOwner: true, preferred: "fast" }))
      .toEqual({ options: ["standard"], speed: "standard", locked: "model" });
  });

  it("has no speed for other providers", () => {
    expect(todoDispatchSpeed({ backend: claude, model: "opus", fastAllowed: true, onOwner: true })).toBeUndefined();
    expect(todoDispatchSpeed({ backend: undefined, fastAllowed: true, onOwner: true })).toBeUndefined();
  });
});

describe("handoff machines", () => {
  const studio = { instanceId: "mac", label: "studio" };
  const winLab = { instanceId: "win", label: "win-lab / dev", dispatchTarget: true };

  it("lists this machine first for its own card, then reachable peers", () => {
    const { owner, machines } = todoDispatchMachines({
      peers: [winLab, { instanceId: "ci", label: "ci-runner", availability: "offline" }, { instanceId: "mac", label: "studio" }],
      local: studio,
    });
    expect(owner).toEqual({ key: "local", label: "studio", available: true, dispatchTarget: true });
    expect(machines.map((machine) => [machine.key, machine.label, machine.available, machine.unavailableReason]))
      .toEqual([
        ["local", "studio", true, undefined],
        ["win", "win-lab / dev", true, undefined],
        ["ci", "ci-runner", false, "Offline"],
      ]);
  });

  it("offers this machine for a peer's card", () => {
    const { owner, machines } = todoDispatchMachines({ ownerInstanceId: "win", peers: [winLab], local: studio });
    expect(owner.key).toBe("win");
    expect(machines.map((machine) => [machine.key, machine.instanceId])).toEqual([["win", undefined], ["local", "mac"]]);
  });

  it("offers no other machine when the card's owner predates dispatch choices", () => {
    const { owner, machines } = todoDispatchMachines({
      ownerInstanceId: "win", peers: [{ ...winLab, dispatchTarget: false }], local: studio,
    });
    expect(owner.dispatchTarget).toBe(false);
    expect(machines).toEqual([owner]);
  });
});
