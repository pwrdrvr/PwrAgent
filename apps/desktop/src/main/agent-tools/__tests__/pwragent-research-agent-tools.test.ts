import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchService } from "@pwragent/owner-core/research-service";
import type { ResearchStorage } from "@pwragent/owner-core/research-storage";
import { projectResearchRun, sameResearchThread, searchResearchItems, type ResearchEvent, type ResearchSearchPage, type ResearchItemContext } from "@pwragent/shared";
import type { ResearchAssignmentReceipt } from "@pwragent/owner-core/research-service";
import { createResearchAgentHandler } from "../../research/research-runtime";
import { resolveAgentToolCatalogs } from "../agent-tool-catalog-registry";
import { withPwrAgentToolDiscovery, searchPwrAgentTools } from "../pwragent-tool-search";

describe("ordinary research tools", () => {
  it("never adds research schemas to the eager working set", () => {
    const catalog = resolveAgentToolCatalogs({ researchHandler: async () => ({}) }).flatMap((entry) => entry.dynamicTools);
    const specs = withPwrAgentToolDiscovery(catalog, true);
    const tools = specs.flatMap((spec) => spec.type === "namespace" ? spec.tools : [spec]);
    expect(tools.filter((tool) => tool.name.startsWith("research_"))).toHaveLength(5);
    expect(tools.filter((tool) => tool.name.startsWith("research_")).every((tool) => tool.deferLoading === true)).toBe(true);
    expect(searchPwrAgentTools(specs, "research_start", 1)[0]?.name).toBe("research_start");
    expect(resolveAgentToolCatalogs({}).flatMap((entry) => entry.dynamicTools).flatMap((spec) => spec.type === "namespace" ? spec.tools : [spec]).some((tool) => tool.name.startsWith("research_"))).toBe(false);
  });

  it("the current feature gate rejects stale research calls after any enable/disable sequence", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async (states) => {
      let enabled = false;
      const summaries = vi.fn(() => []);
      const handler = createResearchAgentHandler({ summaries } as unknown as ResearchService, () => true, () => enabled);
      const context = { backend: "codex", threadId: "parent", turnId: "turn", callId: "call", transport: "codex_dynamic_tool" } as const;
      for (const state of states) {
        enabled = state;
        const calls = summaries.mock.calls.length;
        if (enabled) { expect(await handler("research_read", {}, context)).toEqual([]); expect(summaries).toHaveBeenCalledTimes(calls + 1); }
        else { await expect(handler("research_read", {}, context)).rejects.toThrow("Research runs are disabled"); expect(summaries).toHaveBeenCalledTimes(calls); }
      }
    }), { numRuns: 12 });
  });

  it("runs three approaches through the native tool contract without native tool search", async () => {
    // Tool contracts depend on the storage port. The real SQLite implementation
    // and write budgets are exercised in main/__tests__/research-store.test.ts.
    const journals = new Map<string, ResearchEvent[]>();
    const starts = new Map<string, string>();
    const get = (id: string) => journals.has(id) ? projectResearchRun(id, structuredClone(journals.get(id)!)) : undefined;
    const storage: ResearchStorage = {
      get,
      header: get,
      summaries: (thread) => [...journals.keys()].map((id) => get(id)!).filter((run) => sameResearchThread(run.coordinator, thread) || run.approaches.some((a) => a.worker && sameResearchThread(a.worker, thread))),
      members: (id) => { const run = get(id)!; return [run.coordinator, ...run.approaches.flatMap((a) => a.worker ? [a.worker] : [])]; },
      isMember: (id, thread) => { const run = get(id); return Boolean(run && (sameResearchThread(run.coordinator, thread) || run.approaches.some((a) => a.worker && sameResearchThread(a.worker, thread)))); },
      readItem: (id, itemId) => get(id)?.items.find((item) => item.id === itemId),
      search: (id, query) => { const run = get(id)!; return searchResearchItems(id, run.items, run.revision, query); },
      findCommand: (id, key) => journals.get(id)?.find((event) => event.commandId === key),
      findByStartKey: (key) => starts.has(key) ? get(starts.get(key)!) : undefined,
      list: (thread) => [...journals.keys()].map((id) => get(id)!).filter((run) => !thread || sameResearchThread(run.coordinator, thread) || run.approaches.some((a) => a.worker && sameResearchThread(a.worker, thread))),
      create: (id, key, event) => { starts.set(key, id); journals.set(id, [structuredClone(event)]); },
      append: (id, revision, event) => {
        const records = journals.get(id)!;
        if (records.length !== revision) throw new Error("Conflict");
        records.push(structuredClone(event));
      },
    };
    let spawned = 0;
    const service = new ResearchService(storage, {
      ownerId: "owner", ownerPid: 1, ownerStartedAt: 500, isOwnerAlive: () => false, schedule: () => () => {}, changed: () => {}, onError: () => {},
      spawn: async (_c, _task, _title, _mode, created) => {
        const worker = { backend: "codex" as const, threadId: `worker-${++spawned}`, turnId: `turn-${spawned}` };
        created(worker);
        return worker;
      },
      stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}),
    });
    try {
      const handler = createResearchAgentHandler(service, (context) => context.backend === "codex" && Boolean(context.turnId), () => true);
      const catalog = resolveAgentToolCatalogs({ researchHandler: handler }).find((c) => c.id === "thread_orchestration")!;
      const deferred = withPwrAgentToolDiscovery(catalog.dynamicTools, true).flatMap((spec) => spec.type === "namespace" ? spec.tools : [spec]).filter((tool) => tool.name.startsWith("research_"));
      expect(deferred).toHaveLength(5);
      expect(deferred.every((tool) => tool.deferLoading === true)).toBe(true);
      const result = await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: "research_start", threadId: "coordinator", turnId: "parent", callId: "start",
        arguments: { objective: "Investigate event ordering", minutes: 10, workspaceMode: "none", approaches: [
          { title: "Ordering", task: "Inspect event order" }, { title: "Lifetime", task: "Inspect owners" }, { title: "Persistence", task: "Inspect commits" },
        ] },
      } });
      expect(result.success).toBe(true);
      expect(spawned).toBe(3);
      const run = service.snapshot({ backend: "codex", threadId: "coordinator" }).runs[0]!;
      const posted = await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: "research_update", threadId: "worker-1", turnId: "turn-1", callId: "finding",
        arguments: { runId: run.id, command: { action: "finding", approachId: "a1", kind: "counterexample", text: "A reversed event sequence fails", paths: [] } },
      } });
      expect(posted.success).toBe(true);
      const read = await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: "research_read", threadId: "coordinator", turnId: "parent", callId: "read", arguments: { runId: run.id } } });
      expect(JSON.stringify(read)).toContain("A reversed event sequence fails");
      const coordinator = { backend: "codex", threadId: "coordinator", turnId: "parent", callId: "read-page", transport: "codex_dynamic_tool" } as const;
      for (let i = 0; i < 11; i++) await service.update(run.id, `candidate-${i}`, { action: "submit", approachId: "a1", text: `Candidate ${i}`, paths: [] }, { ...coordinator, kind: "agent" });
      const page = await handler("research_read", { runId: run.id, submissionOffset: 10 }, coordinator);
      expect(page).toMatchObject({ totalSubmissions: 11, submissions: [{ text: "Candidate 10" }] });
      const first = await handler("research_read", { runId: run.id }, coordinator);
      expect(first).toMatchObject({ nextSubmissionOffset: 10 });
      const call = async (name: string, args: Parameters<typeof catalog.router.handleDynamicToolCall>[0]["call"]["arguments"], threadId = "coordinator", turnId = "parent") => {
        const result = await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: name, threadId, turnId, callId: `${name}-${threadId}-${journals.get(run.id)!.length}`, arguments: args } });
        expect(result.success).toBe(true);
        const content = result.contentItems?.find((item) => item.type === "inputText");
        if (!content || content.type !== "inputText") throw new Error("Missing tool response");
        return JSON.parse(content.text);
      };
      const search = await call("research_search", { runId: run.id, query: "reversed", type: "finding" }) as ResearchSearchPage;
      expect(search.items).toHaveLength(1);
      const source = await call("research_read", { runId: run.id, itemId: search.items[0]!.id }) as ResearchItemContext;
      service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
      const assignment = await call("research_assign", { runId: run.id, itemId: source.item.id, expectedVersion: source.item.version, task: "Handle only the reversed-sequence counterexample" }) as ResearchAssignmentReceipt;
      expect(assignment.worker?.threadId).toBe("worker-4");
      const focused = await call("research_read", { runId: run.id, itemId: source.item.id }, "worker-4", "turn-4") as ResearchItemContext;
      expect(focused.item.work.assignee?.threadId).toBe("worker-4");
      expect(JSON.stringify(focused)).not.toContain("Candidate 10");
      expect(JSON.stringify(focused)).not.toContain('"events"');
      let version = focused.item.version;
      for (const state of ["claimed", "in_progress", "completed"]) {
        const receipt = await call("research_update", { runId: run.id, command: { action: "work", itemId: source.item.id, expectedVersion: version, state, reason: `Focused work ${state}` } }, "worker-4", "turn-4");
        expect(receipt.item.state).toBe(state);
        expect(JSON.stringify(receipt).length).toBeLessThan(1000);
        expect(JSON.stringify(receipt)).not.toContain("reversed event sequence");
        version = receipt.item.version;
      }
      const completed = await call("research_search", { runId: run.id, state: "completed" }) as ResearchSearchPage;
      expect(completed.items.map((item) => item.id)).toEqual([source.item.id]);
      for (let i = 0; i < 35; i++) await service.update(run.id, `large-${i}`, { action: "finding", approachId: "a2", kind: "note", text: `Searchable ${i} ${"e".repeat(3900)}`, paths: [] }, { ...coordinator, kind: "agent" });
      const bounded = await call("research_search", { runId: run.id, query: "Searchable", limit: 20 }) as ResearchSearchPage;
      expect(bounded.items).toHaveLength(20);
      expect(bounded.items.every((item) => item.excerpt.length <= 200)).toBe(true);
      expect(JSON.stringify(bounded).length).toBeLessThan(20_000);
      const foreign = await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: "research_read", threadId: "foreign", turnId: "other", callId: "read", arguments: { runId: run.id } } });
      expect(foreign.success).toBe(false);
      expect(catalog.router.buildMcpTools().filter((tool) => tool.name.startsWith("research_"))).toHaveLength(5);
    } finally { service.close(); }
  });
});
