import { ResearchService } from "@pwragent/owner-core/research-service";
import fc from "fast-check";
import { expect, it } from "vitest";
import { MemoryResearchStorage } from "../../../../../packages/owner-core/src/__tests__/fixtures/research-memory-storage";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildResearchToolDefinitions } from "../agent-tools/pwragent-research-agent-tools";
import { createResearchAgentHandler } from "../research/research-runtime";

async function expectBothUpdatesApplied(backend: "claude" | "acp:grok", requestId: number | string, notes: [string, string]) {
  const turn = { backend, threadId: "coordinator", turnId: "active-turn" };
  const coordinator = { ...turn, kind: "agent", callId: "start" } as const;
  const service = new ResearchService(new MemoryResearchStorage(), {
    ownerId: "owner", ownerPid: 123, ownerStartedAt: 500, isOwnerAlive: () => false, now: () => 1000,
    schedule: () => () => {}, changed: () => {}, onError: (error) => { throw error; },
    stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}),
    spawn: async (_context, _task, _title, _mode, created) => {
      const worker = { backend, threadId: "worker", turnId: "worker-turn" };
      created(worker);
      return worker;
    },
  });
  const handle = createResearchAgentHandler(service, () => true, () => true);
  const callIds: Array<string | undefined> = [];
  const router = new AgentToolRouter(buildResearchToolDefinitions((name, args, context) => {
    callIds.push(context.callId);
    return handle(name, args, context);
  }));
  const server = new AgentToolMcpServer({
    resolveCatalogs: () => [{ id: "thread_orchestration", router }],
    resolveCallContext: () => turn,
  });
  try {
    const run = await service.start({ objective: "Investigate a queue race", workspaceMode: "none",
      approaches: [{ title: "Events", task: "Trace event order" }] }, coordinator);
    const { server: registration } = await server.registerClient(turn);
    const replies = [];
    // Close each HTTP connection after its response. Both stateless MCP calls
    // deliberately use the same JSON-RPC id and the same thread credentials.
    for (const note of notes) {
      const response = await fetch(registration.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(registration.headers.map(({ name, value }) => [name, value])),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Connection: "close",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: requestId, method: "tools/call",
          params: { name: "research_update", arguments: { runId: run.id,
            command: { action: "finding", approachId: "a1", kind: "note", text: note, paths: [] } } },
        }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const data = body.split("\n").find((line) => line.startsWith("data:"));
      expect(data, body).toBeDefined();
      replies.push(JSON.parse(data!.slice("data:".length)));
    }

    // Each wire call must get its own identity and append one finding, even
    // when the request IDs and the full command arguments are identical.
    expect({
      distinctCallIds: new Set(callIds).size,
      replies,
      findings: service.read(run.id, coordinator).findings.map(({ text }) => text).sort(),
    }).toEqual({
      distinctCallIds: 2,
      replies: notes.map(() => expect.objectContaining({
        id: requestId, result: expect.objectContaining({ structuredContent: expect.objectContaining({ runId: run.id }) }),
      })),
      findings: [...notes].sort(),
    });
  } finally {
    await server.close();
    service.close();
  }
}

it("keeps overlapping MCP request IDs distinct within a turn and applies both research updates", async () => {
  const note = fc.stringMatching(/^[a-z]{1,20}$/);
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("claude" as const, "acp:grok" as const),
    fc.oneof(fc.nat(), fc.string()),
    fc.oneof(note.map((text): [string, string] => [text, text]), fc.tuple(note, note)),
    expectBothUpdatesApplied,
  ), { numRuns: 25 });
});

it("applies two identical findings from separate MCP connections that both use request ID zero", async () => {
  await expectBothUpdatesApplied("claude", 0, ["a", "a"]);
});
