import { describe, expect, it } from "vitest";
import { ResearchService } from "@pwragent/owner-core/research-service";
import type { ResearchStorage } from "@pwragent/owner-core/research-storage";
import { projectResearchRun, sameResearchThread, type ResearchEvent } from "@pwragent/shared";
import { createResearchAgentHandler } from "../../research/research-runtime";
import { resolveAgentToolCatalogs } from "../agent-tool-catalog-registry";
import { withPwrAgentToolDiscovery } from "../pwragent-tool-search";

describe("ordinary research tools", () => {
  it("runs three approaches through the native tool contract without native tool search", async () => {
    // Tool contracts depend on the storage port. The real SQLite implementation
    // and write budgets are exercised in main/__tests__/research-store.test.ts.
    const journals = new Map<string, ResearchEvent[]>();
    const starts = new Map<string, string>();
    const get = (id: string) => journals.has(id) ? projectResearchRun(id, structuredClone(journals.get(id)!)) : undefined;
    const storage: ResearchStorage = {
      get,
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
      const handler = createResearchAgentHandler(service, (context) => context.backend === "codex" && Boolean(context.turnId));
      const catalog = resolveAgentToolCatalogs({ researchHandler: handler }).find((c) => c.id === "thread_orchestration")!;
      const eager = withPwrAgentToolDiscovery(catalog.dynamicTools, true).flatMap((spec) => spec.type === "namespace" ? spec.tools : [spec]).filter((tool) => tool.name.startsWith("research_"));
      expect(eager).toHaveLength(3);
      expect(eager.every((tool) => tool.deferLoading === false)).toBe(true);
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
      const foreign = await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: "research_read", threadId: "foreign", turnId: "other", callId: "read", arguments: { runId: run.id } } });
      expect(foreign.success).toBe(false);
      expect(catalog.router.buildMcpTools().filter((tool) => tool.name.startsWith("research_"))).toHaveLength(3);
    } finally { service.close(); }
  });
});
