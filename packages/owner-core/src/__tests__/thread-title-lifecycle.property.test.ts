import fc from "fast-check";
import { expect, it } from "vitest";
import {
  buildThreadIdentityKey,
  isAcpBackendId,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
} from "@pwragent/shared";
import { ThreadNamingLifecycle } from "../thread-naming-lifecycle";
import type { OwnerThreadIdentity } from "../thread-storage";
import { ThreadTitleLifecycle, type ThreadTitleHelperUpdate, type ThreadTitleLifecycleHost } from "../thread-title-lifecycle";

const backend = fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:kimi", "acp:claude");
const key = (id: OwnerThreadIdentity) => buildThreadIdentityKey(id.backend, id.threadId);
const input = (text: string): AppServerTurnInputItem[] => [{ type: "text", text }, { type: "text", text: "  " }];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
};

function fixture() {
  let available = true;
  const names = new Map<string, { title: string; source: string }>();
  const events: AgentEvent[] = [];
  const calls: Array<OwnerThreadIdentity & { userPrompt: string }> = [];
  const updates: ThreadTitleHelperUpdate[] = [];
  const preparations: string[] = [];
  const readTitle = async (id: OwnerThreadIdentity): Promise<AppServerThreadSummary | undefined> => {
    const name = names.get(key(id));
    return name ? { id: id.threadId, title: name.title, titleSource: "explicit", source: id.backend, linkedDirectories: [] } : undefined;
  };
  const naming = new ThreadNamingLifecycle({
    readTitle,
    readName: async (id) => names.get(key(id))?.title,
    renameProvider: async (request, source) => {
      names.set(key({ ...request, backend: request.backend ?? "codex" }), { title: request.name, source });
      return { threadId: request.threadId };
    },
    getAgent: async () => undefined,
    setAgent: async () => {},
    invalidate: () => {},
    emit: async (event) => { events.push(event); },
    now: () => 1,
  });
  const host: ThreadTitleLifecycleHost = {
    canGenerateTitle: () => available,
    readTitle,
    prepareHelper: async (id) => { preparations.push(key(id)); },
    generateTitle: async (params) => {
      calls.push(params);
      return { status: "generated", title: `Generated ${params.userPrompt}`, helperTurnId: "helper-turn", tokenUsage: { total: 12 } };
    },
    persistHelper: async (update) => { updates.push(update); },
    log: () => {},
  };
  return { naming, host, names, events, calls, updates, preparations,
    setAvailable: (value: boolean) => { available = value; },
    lifecycle: new ThreadTitleLifecycle(naming, host) };
}

// Model: prepared input is consumed once at admission. Unsupported/empty input
// spends no attempt; each admitted backend-qualified identity spends one even
// if the helper fails. Retransmitted lifecycle events cannot launch it twice.
it("matches the prepared-input admission model across identities and capability changes", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    backend, threadId: fc.constantFrom("shared", "other"),
    action: fc.constantFrom("remember", "forget", "lifecycle", "direct", "capability"),
    text: fc.constantFrom("", "  ", "Prompt", " Second prompt ", "One\nTwo"), available: fc.boolean(),
  }), { minLength: 1, maxLength: 50 }), async (operations) => {
    const f = fixture();
    let available = true;
    const pending = new Map<string, string>();
    const attempted = new Set<string>();
    const expectedCalls: typeof f.calls = [];
    const expectedNames: typeof f.names = new Map();
    for (const op of operations) {
      const id = { backend: op.backend, threadId: op.threadId };
      const k = key(id);
      let admitted: string | undefined;
      if (op.action === "remember") {
        pending.set(k, op.text); f.lifecycle.rememberPendingInput(id, input(op.text));
      } else if (op.action === "forget") {
        pending.delete(k); f.lifecycle.forgetPendingInput(id);
      } else if (op.action === "capability") {
        available = op.available; f.setAvailable(available);
      } else if (op.action === "direct") {
        admitted = op.text; f.lifecycle.schedule({ ...id, input: input(op.text) });
      } else {
        admitted = pending.get(k); pending.delete(k); f.lifecycle.schedulePending(id);
      }
      const prompt = admitted?.trim();
      if (available && prompt && !attempted.has(k)) {
        attempted.add(k);
        if (op.backend !== "acp:claude") expectedCalls.push({ ...id, userPrompt: prompt });
        expectedNames.set(k, { title: op.backend === "acp:claude" ? prompt.split(/\s+/u).join(" ") : `Generated ${prompt}`,
          source: op.backend === "acp:claude" ? "fallback" : "derived" });
      }
      await f.lifecycle.whenSettled();
      expect(f.calls).toEqual(expectedCalls);
      expect(f.names).toEqual(expectedNames);
      expect(f.events).toHaveLength(attempted.size);
    }
  }));
});

it("preserves result metadata, terminal helper effects and ACP fallback without retrying failed attempts", async () => {
  await fc.assert(fc.asyncProperty(backend, fc.constantFrom("generated", "invalid", "unavailable", "throw", "missing"), async (kind, outcome) => {
    const f = fixture();
    const id = { backend: kind, threadId: "same" };
    const result = outcome === "generated"
      ? { status: "generated" as const, title: "Helper", helperTurnId: "turn", tokenUsage: { total: 37 } }
      : outcome === "invalid"
        ? { status: "invalid" as const, reason: "invalid", helperTurnId: "turn", tokenUsage: { total: 37 } }
        : { status: "unavailable" as const, reason: "unavailable" };
    let calls = 0;
    f.host.generateTitle = async () => {
      calls++;
      if (outcome === "throw") throw new Error("helper refused");
      return outcome === "missing" ? undefined : result;
    };
    f.lifecycle.schedule({ ...id, input: input("Prompt") });
    await f.lifecycle.whenSettled();
    f.lifecycle.schedule({ ...id, input: input("A later turn") });
    await f.lifecycle.whenSettled();
    if (kind === "acp:claude") {
      expect(calls).toBe(0);
      expect(f.preparations).toEqual([]);
      expect(f.updates).toEqual([]);
      expect(f.names.get(key(id))).toEqual({ title: "Prompt", source: "fallback" });
    } else {
      expect(calls).toBe(1);
      expect(f.preparations).toEqual(kind === "claude" ? [] : [key(id)]);
      const generated = outcome === "generated";
      expect(f.updates).toEqual([{
        ...id, status: generated ? "success" : "failed",
        ...(!generated ? { existingOnly: true, reason: outcome === "throw" ? "helper refused" : outcome === "missing" ? "title_generation_unavailable" : outcome } : {}),
        ...(generated || outcome === "invalid" ? { result } : {}),
      }]);
      const fallback = !generated && isAcpBackendId(kind) && outcome !== "throw";
      expect(f.names.get(key(id))).toEqual(generated ? { title: "Helper", source: "derived" }
        : fallback ? { title: "Prompt", source: "fallback" } : undefined);
    }
    for (const event of f.events) {
      expect(event.notification).toMatchObject({ method: "thread/name/updated" });
      if (event.notification.method !== "thread/name/updated") throw new Error("Unexpected event");
      expect(event.notification.params.titleSource).toBe(f.names.get(key(id))?.source === "derived" ? "derived" : undefined);
    }
  }));
});

it("fences late helper results with the naming owner's explicit intent and isolates backend collisions", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:kimi"),
    fc.constantFrom("Prompt", "Untitled thread", "Operator"), async (kind, title) => {
      const f = fixture();
      const id = { backend: kind, threadId: "collision" };
      const other = { backend: kind === "codex" ? "claude" as const : "codex" as const, threadId: id.threadId };
      const started = deferred(); const release = deferred();
      const generate = f.host.generateTitle;
      f.host.generateTitle = async (params) => {
        if (params.backend === kind) { started.resolve(); await release.promise; }
        return await generate(params);
      };
      f.lifecycle.schedule({ ...id, input: input("Prompt") });
      await started.promise;
      // Concurrent duplicate admission cannot spend another helper turn.
      f.lifecycle.schedule({ ...id, input: input("Later prompt") });
      await f.naming.renameThread({ ...id, name: title });
      f.lifecycle.schedule({ ...other, input: input("Prompt") });
      release.resolve();
      await f.lifecycle.whenSettled();
      expect(f.names.get(key(id))).toEqual({ title, source: "explicit" });
      expect(f.names.get(key(other))).toEqual({ title: "Generated Prompt", source: "derived" });
      expect(f.calls).toHaveLength(2);
      expect(f.updates.find((update) => update.backend === kind)).toMatchObject({
        status: "success", existingOnly: true, reason: "The thread was renamed before title application.",
        result: { tokenUsage: { total: 12 } },
      });
      expect(f.events.filter((event) => event.backend === kind)).toHaveLength(1);
    }));
});

it("drains event-admitted work through the last helper and its persistence effect", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 11, max: 30 }), async (count) => {
    const f = fixture(); const last = deferred(); const release = deferred();
    let index = 0;
    const persist = f.host.persistHelper;
    f.host.persistHelper = async (update) => {
      if (++index < count) f.lifecycle.schedule({ backend: "codex", threadId: String(index), input: input("Prompt") });
      else { last.resolve(); await release.promise; }
      await persist(update);
    };
    f.lifecycle.schedule({ backend: "codex", threadId: "0", input: input("Prompt") });
    const completion = f.lifecycle.whenSettled();
    expect(await Promise.race([completion.then(() => "settled"), last.promise.then(() => "last")])).toBe("last");
    expect(f.updates).toHaveLength(count - 1);
    release.resolve();
    await completion;
    expect(f.updates).toHaveLength(count);
  }));
});
