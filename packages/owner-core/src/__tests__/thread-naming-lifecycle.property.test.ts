import fc from "fast-check";
import { expect, it } from "vitest";
import { buildThreadIdentityKey, isAcpBackendId, type AgentEvent, type AppServerBackendKind, type AppServerNotification } from "@pwragent/shared";
import { ThreadNamingLifecycle, type ThreadNamingHost } from "../thread-naming-lifecycle";
import type { OwnerThreadIdentity } from "../thread-storage";

const backend = fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:kimi", "acp:claude");
const identityKey = (identity: OwnerThreadIdentity) => buildThreadIdentityKey(identity.backend, identity.threadId);
const identity = { backend: "codex" as AppServerBackendKind, threadId: "same-id" };

function fixture() {
  const names = new Map<string, string>();
  const events: AgentEvent[] = [];
  const trace: string[] = [];
  const host: ThreadNamingHost = {
    readName: async (id) => names.get(identityKey(id)) ?? "Original",
    readTitle: async (id) => ({ id: id.threadId, title: names.get(identityKey(id)) ?? "Untitled thread",
      titleSource: names.has(identityKey(id)) ? "explicit" : "fallback", source: id.backend, linkedDirectories: [] }),
    renameProvider: async (request) => {
      if (request.name.startsWith("Fail")) throw new Error("Provider refused");
      names.set(identityKey({ ...request, backend: request.backend ?? "codex" }), request.name.trim());
      trace.push("provider");
      return { threadId: request.threadId };
    },
    getAgent: async () => ({ name: "Agent", instructions: "Keep these instructions", instructionLineCount: 1, instructionsTooLong: false, updatedAt: 1 }),
    setAgent: async (_id, agent) => { expect(agent.instructions).toBe("Keep these instructions"); trace.push("agent"); },
    invalidate: () => { trace.push("invalidate"); },
    emit: async (event) => { events.push(event); trace.push("event"); },
    now: () => 123,
  };
  return { host, names, events, trace, lifecycle: new ThreadNamingLifecycle(host) };
}

// Model: each backend-qualified identity folds its admitted renames in FIFO
// order. Failed provider writes and failed compare-and-set leave its name alone.
it("matches the per-identity conditional rename model across failures", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    backend, id: fc.constantFrom("same-id", "other-id"), fail: fc.boolean(),
    condition: fc.constantFrom("none", "match", "stale"), agent: fc.boolean(),
  }), { minLength: 1, maxLength: 30 }), async (operations) => {
    const { lifecycle, names, events } = fixture();
    const model = new Map<string, string>();
    const expectedEvents: Record<string, Array<{ title: string; previous?: string }>> = {};
    const work: Array<Promise<unknown>> = [];
    for (const [i, op] of operations.entries()) {
      const id = { backend: op.backend, threadId: op.id };
      const key = identityKey(id);
      const previous = model.get(key) ?? "Original";
      const name = `${op.fail ? "Fail" : "Name"} ${i}`;
      const succeeds = !op.fail && op.condition !== "stale";
      if (succeeds) {
        model.set(key, name);
        (expectedEvents[key] ??= []).push({ title: name, ...(op.agent ? { previous } : {}) });
      }
      const pending = lifecycle.renameThread({ ...id, name,
        ...(op.condition !== "none" ? { expectedName: op.condition === "match" ? previous : "Never current" } : {}),
      }, op.agent ? { renameOrigin: "agent_tool" } : undefined);
      work.push(succeeds
        ? pending.then((result) => { expect(result).toEqual({ ...id, renamedAt: 123 }); })
        : pending.then(() => { throw new Error("Model expected rejection"); }, () => {}));
    }
    await Promise.all(work);
    expect(names).toEqual(model);
    const actual: typeof expectedEvents = {};
    for (const event of events) {
      if (event.notification.method !== "thread/name/updated") throw new Error("Unexpected event");
      const params = event.notification.params as Extract<AppServerNotification, { method: "thread/name/updated" }>["params"];
      if (typeof params.threadName !== "string") throw new Error("A successful rename must announce its name");
      expect(params.titleSource).toBe("explicit");
      (actual[identityKey({ backend: event.backend, threadId: params.threadId })] ??= []).push({
        title: params.threadName, ...(params.previousThreadName ? { previous: params.previousThreadName } : {}),
      });
    }
    expect(actual).toEqual(expectedEvents);
  }));
});

it("preserves explicit admission while the generated title's owner read is pending", async () => {
  await fc.assert(fc.asyncProperty(backend, fc.boolean(), fc.constantFrom("Operator", "Prompt", "Untitled thread"), async (kind, providerHasStarted, operatorTitle) => {
    const f = fixture();
    const id = { ...identity, backend: kind };
    let release!: () => void;
    let arrived!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    f.host.readTitle = async () => {
      if (!providerHasStarted) { arrived(); await blocked; }
      return { id: id.threadId, title: "Prompt", titleSource: "fallback", source: kind, linkedDirectories: [] };
    };
    const rename = f.host.renameProvider;
    f.host.renameProvider = async (request, source) => {
      if (request.name === "Generated" && providerHasStarted) { arrived(); await blocked; }
      return await rename(request, source);
    };
    const attempt = f.lifecycle.beginTitleGeneration(id);
    const generated = f.lifecycle.applyGeneratedTitle({ attempt, prompt: "Prompt", title: "Generated" });
    await reached;
    const operator = f.lifecycle.renameThread({ ...id, name: operatorTitle });
    // A colliding thread id on another backend must not wait for this owner I/O.
    const other = { ...id, backend: kind === "codex" ? "claude" as const : "codex" as const };
    await f.lifecycle.renameThread({ ...other, name: "Independent" });
    release();
    expect((await generated).applied).toBe(providerHasStarted);
    await operator;
    expect(f.names.get(identityKey(id))).toBe(operatorTitle);
    expect(f.names.get(identityKey(other))).toBe("Independent");
    f.lifecycle.finishTitleGeneration(attempt);
  }));
});

it("keeps provider-specific notification order and generated provenance", async () => {
  await fc.assert(fc.asyncProperty(backend, async (kind) => {
    const f = fixture();
    const id = { ...identity, backend: kind };
    await f.lifecycle.renameThread({ ...id, name: "  Operator name  " });
    expect(f.trace).toEqual(isAcpBackendId(kind)
      ? ["provider", "event", "agent", "invalidate"]
      : ["provider", "agent", "invalidate", "event"]);
    const g = fixture();
    const attempt = g.lifecycle.beginTitleGeneration(id);
    if (isAcpBackendId(kind)) {
      // The provider's generic fallback must match its own placeholder.
      g.host.readTitle = async () => ({ id: id.threadId, title: "ACP session", titleSource: "fallback", source: kind, linkedDirectories: [] });
    }
    expect((await g.lifecycle.applyGeneratedTitle({ attempt, prompt: "Prompt", title: "Generated" })).applied).toBe(true);
    expect(g.events[0].notification).toMatchObject({ method: "thread/name/updated", params: { threadName: "Generated", titleSource: "derived" } });
    if (isAcpBackendId(kind)) expect(g.trace).toEqual(["provider", "event"]);
    g.lifecycle.finishTitleGeneration(attempt);
  }));
});

it("omits fallback on the wire while preserving it at the ACP storage port", async () => {
  const f = fixture();
  const id = { ...identity, backend: "acp:kimi" as const };
  let storedSource: unknown;
  const rename = f.host.renameProvider;
  f.host.renameProvider = async (request, source) => { storedSource = source; return await rename(request, source); };
  f.host.readTitle = async () => ({ id: id.threadId, title: "ACP session", titleSource: "fallback", source: id.backend, linkedDirectories: [] });
  const attempt = f.lifecycle.beginTitleGeneration(id);
  await f.lifecycle.applyGeneratedTitle({ attempt, prompt: "Prompt", title: "Prompt", titleSource: "fallback" });
  expect(storedSource).toBe("fallback");
  expect(f.events[0].notification).toEqual({ method: "thread/name/updated", params: { threadId: id.threadId, threadName: "Prompt" } });
});

it("fails closed for conditional metadata errors and preserves optional notice reads", async () => {
  const f = fixture();
  f.host.readName = async () => { throw new Error("Unavailable"); };
  await expect(f.lifecycle.renameThread({ ...identity, name: "Undo", expectedName: "Original" })).rejects.toThrow("Unavailable");
  expect(f.events).toEqual([]);
  await f.lifecycle.renameThread({ ...identity, name: "Requested" }, { renameOrigin: "agent_tool" });
  expect(f.events[0].notification).toEqual({ method: "thread/name/updated", params: {
    threadId: identity.threadId, threadName: "Requested", titleSource: "explicit", renameOrigin: "agent_tool",
  } });
});

it("does not let a superseded attempt retire a newer placeholder's eligibility", async () => {
  const f = fixture();
  f.host.readTitle = async () => ({ id: identity.threadId, title: "Untitled thread", titleSource: "explicit", source: identity.backend, linkedDirectories: [] });
  f.lifecycle.markSystemPlaceholder(identity);
  const old = f.lifecycle.beginTitleGeneration(identity);
  const current = f.lifecycle.beginTitleGeneration(identity);
  f.lifecycle.finishTitleGeneration(old);
  expect((await f.lifecycle.applyGeneratedTitle({ attempt: old, prompt: "Prompt", title: "Old" })).applied).toBe(false);
  expect((await f.lifecycle.applyGeneratedTitle({ attempt: current, prompt: "Prompt", title: "Current" })).applied).toBe(true);
  f.lifecycle.finishTitleGeneration(current);
  expect(f.lifecycle.hasSystemPlaceholder(identity)).toBe(false);
});

it("keeps explicit intent when a later generation starts with the same prompt title", async () => {
  await fc.assert(fc.asyncProperty(backend, async (kind) => {
    const f = fixture();
    const id = { ...identity, backend: kind };
    await f.lifecycle.renameThread({ ...id, name: "Prompt" });
    const attempt = f.lifecycle.beginTitleGeneration(id);
    expect((await f.lifecycle.applyGeneratedTitle({ attempt, prompt: "Prompt", title: "Helper" })).applied).toBe(false);
    expect(f.names.get(identityKey(id))).toBe("Prompt");
    f.lifecycle.finishTitleGeneration(attempt);
  }));
});
