import { ResearchService } from "@pwragent/owner-core/research-service";
import fc from "fast-check";
import { expect, it } from "vitest";
import { MemoryResearchStorage } from "../../../../../packages/owner-core/src/__tests__/fixtures/research-memory-storage";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildResearchToolDefinitions } from "../agent-tools/pwragent-research-agent-tools";
import { createResearchAgentHandler } from "../research/research-runtime";

async function checkResearchCalls(
  backend: "claude" | "acp:grok", requestId: number | string, notes: [string, string], initializeAs: "none" | "object" | "batch",
) {
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
    const headers = Object.fromEntries(registration.headers.map(({ name, value }) => [name, value]));
    const post = (message: object | object[], sessionId?: string) => fetch(registration.url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Connection: "close",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(Array.isArray(message) ? message : { jsonrpc: "2.0", ...message }),
    });
    const readResult = async (response: Response) => {
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const data = body.split("\n").find((line) => line.startsWith("data:"));
      expect(data, body).toBeDefined();
      return JSON.parse(data!.slice("data:".length));
    };
    if (initializeAs === "none") {
      const start = { id: requestId, method: "tools/call", params: { name: "research_start", arguments: {
        objective: "Investigate a second issue", workspaceMode: "none",
        approaches: [{ title: "Events", task: "Trace event order" }],
      } } };
      const replies = [await readResult(await post(start)), await readResult(await post(start))];
      const forbidden = { result: { isError: true, structuredContent: { code: "forbidden" } } };
      expect({ replies, calls: callIds.length, runs: service.summaries(coordinator).length }).toMatchObject({
        replies: [forbidden, forbidden],
        calls: 0,
        runs: 1,
      });
      return;
    }
    const initialize = async () => {
      const request = { jsonrpc: "2.0", id: 0, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "research-fixture", version: "1" },
      } };
      const message = initializeAs === "batch" ? [request] : request;
      const response = await post(message);
      expect(response.status, await response.text()).toBe(200);
      const sessionId = response.headers.get("Mcp-Session-Id");
      expect(sessionId).toBeTruthy();
      const initialized = await post({ method: "notifications/initialized" }, sessionId!);
      expect(initialized.status).toBe(202);
      const repeated = await post(message, sessionId!);
      expect(repeated.status, await repeated.text()).toBe(400);
      return sessionId!;
    };
    const firstSession = await initialize();
    const secondSession = await initialize();
    // Separate HTTP connections carry independent calls and the replay, even
    // when the credentials, request IDs and research arguments match exactly.
    const update = async (note: string, sessionId: string) => readResult(await post({
      id: requestId, method: "tools/call",
        params: { name: "research_update", arguments: { runId: run.id,
          command: { action: "finding", approachId: "a1", kind: "note", text: note, paths: [] } } },
    }, sessionId));
    const replies = [await update(notes[0], firstSession), await update(notes[1], secondSession)];
    const revision = service.read(run.id, coordinator).revision;
    expect(await update(notes[1], secondSession)).toEqual(replies[1]);
    expect(callIds[2]).toBe(callIds[1]);
    expect(service.read(run.id, coordinator).revision).toBe(revision);

    // Each independent call must append a finding even when its request ID
    // and arguments match those of another call.
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

it("applies independent MCP calls once each and returns the original receipt on a same-session retry", async () => {
  const note = fc.stringMatching(/^[a-z]{1,20}$/);
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("claude" as const, "acp:grok" as const),
    fc.oneof(fc.integer({ min: 1 }), fc.string()),
    fc.oneof(note.map((text): [string, string] => [text, text]), fc.tuple(note, note)),
    fc.constantFrom("object" as const, "batch" as const),
    checkResearchCalls,
  ), { numRuns: 25 });
});

it("refuses both deliveries of a sessionless research start before spawning workers", async () => {
  await fc.assert(fc.asyncProperty(fc.nat(), (requestId) => checkResearchCalls("claude", requestId, ["a", "a"], "none")), { numRuns: 10 });
});

it("deduplicates an identical research update only within its MCP session", async () => {
  await checkResearchCalls("claude", 1, ["a", "a"], "object");
});

it("establishes a session for singleton initialization and rejects its reinitialization", async () => {
  await checkResearchCalls("claude", 1, ["a", "a"], "batch");
});
