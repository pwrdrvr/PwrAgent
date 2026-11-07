import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentToolRouter } from "../agent-tool-router";
import { AgentToolMcpServer, type AgentToolMcpRegistration } from "../agent-tool-mcp-server";
import { agentToolSuccess, type AgentToolCallContext } from "../agent-tool-definition";
import type { ResolvedAgentToolCatalog } from "../agent-tool-catalog-registry";

// Claude Code aborts a call whose response headers have not arrived after
// 60 seconds, and one with no response or progress for 300 seconds after
// that. These tests scale both limits down: the headers must arrive within
// HEADER_DEADLINE_MS whatever the tool takes, and no silent stretch on the
// stream may outlast IDLE_LIMIT_MS before the result. Both bounds leave room
// for a loaded test worker; every call lasts longer than the header deadline,
// so a server that answers only when the tool finishes still fails.
const PROGRESS_INTERVAL_MS = 50;
const HEADER_DEADLINE_MS = 500;
const IDLE_LIMIT_MS = PROGRESS_INTERVAL_MS * 8;

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function buildCatalog(dispatch: (args: unknown, context: AgentToolCallContext) => unknown): ResolvedAgentToolCatalog {
  const router = new AgentToolRouter([{
    namespace: "pwragent",
    name: "wait_for_operator",
    annotations: { readOnlyHint: false },
    description: "Waits like a confirmation card.",
    inputSchema: { type: "object", additionalProperties: false },
    dispatch: dispatch as never,
  }]);
  return {
    id: "app_management",
    dynamicTools: router.buildDynamicToolSpecs(),
    router,
    summary: { id: "app_management", namespace: "pwragent", enabled: true, toolCount: 1, fingerprint: "test" },
  };
}

function callRequest(registration: AgentToolMcpRegistration, signal?: AbortSignal): Promise<Response> {
  return fetch(registration.server.url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(registration.server.headers.map((header) => [header.name, header.value])),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "wait_for_operator", arguments: {}, _meta: { progressToken: "call-7" } },
    }),
    ...(signal ? { signal } : {}),
  });
}

/** Each SSE data message with the time it arrived. Comment frames count as
 * traffic for the idle gap only when `countComments` is set. */
async function readMessages(response: Response, startedAt: number): Promise<{ at: number; message: { method?: string; id?: number; result?: unknown } }[]> {
  const messages: { at: number; message: { method?: string; id?: number; result?: unknown } }[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n\n")) >= 0) {
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (data) messages.push({ at: performance.now() - startedAt, message: JSON.parse(data) });
    }
  }
  return messages;
}

describe("AgentToolMcpServer long tool calls", () => {
  const openServers: AgentToolMcpServer[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(openServers.splice(0).map(async (server) => server.close()));
  });

  async function setup(dispatch: (args: unknown, context: AgentToolCallContext) => unknown) {
    const catalog = buildCatalog(dispatch);
    const server = new AgentToolMcpServer({
      resolveCallContext: (context) => context.threadId
        ? { backend: context.backend, threadId: context.threadId, turnId: "turn-1" } : undefined,
      resolveCatalogs: () => [catalog],
      progressIntervalMs: PROGRESS_INTERVAL_MS,
    });
    openServers.push(server);
    const registration = await server.registerClient({ backend: "claude", threadId: "thread-1" });
    return { registration };
  }

  // Model: a client that gives up when the headers are late, or when the
  // stream goes quiet, never gives up on a call that is still working, however
  // long the tool waits. The result it gets is the tool's own (oracle: the
  // value the tool returned).
  it("answers headers at once and reports progress until a call of any length finishes", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 600, max: 1_500 }), async (durationMs) => {
      const release = deferred();
      const { registration } = await setup(async () => {
        await release.promise;
        return agentToolSuccess({ waitedMs: durationMs });
      });
      const timer = setTimeout(release.resolve, durationMs);
      try {
        const startedAt = performance.now();
        const response = await callRequest(registration);
        const headersAt = performance.now() - startedAt;
        expect(headersAt, "headers arrived before the client's deadline").toBeLessThan(HEADER_DEADLINE_MS);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const messages = await readMessages(response, startedAt);
        const result = messages.at(-1)!;
        expect(result.message).toMatchObject({ id: 7, result: { structuredContent: { waitedMs: durationMs } } });
        expect(result.at).toBeGreaterThanOrEqual(durationMs - 5);
        let previous = headersAt;
        for (const item of messages) {
          expect(item.at - previous, "no silent stretch reached the idle limit").toBeLessThan(IDLE_LIMIT_MS);
          previous = item.at;
        }
        const progress = messages.filter((item) => item.message.method === "notifications/progress");
        expect(progress.length).toBeGreaterThan(0);
        expect(progress.every((item) => (item.message as { params?: { progressToken?: string } }).params?.progressToken === "call-7")).toBe(true);
      } finally {
        clearTimeout(timer);
        release.resolve();
      }
    }), { numRuns: 6 });
  }, 30_000);

  // A call that already raised a card or started work finishes as it did
  // before, even when the client stops waiting for it.
  it("lets a call finish after its client disconnects", async () => {
    const release = deferred();
    let signal: AbortSignal | undefined;
    let abortedBeforeFinishing: boolean | undefined;
    const { registration } = await setup(async (_args, context) => {
      signal = context.signal;
      await release.promise;
      abortedBeforeFinishing = context.signal?.aborted;
      return agentToolSuccess({ status: "done" });
    });
    const sent = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "send");
    const progressSent = () => sent.mock.calls
      .filter(([message]) => (message as { method?: string }).method === "notifications/progress").length;
    const client = new AbortController();
    const response = await callRequest(registration, client.signal);
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, PROGRESS_INTERVAL_MS * 2));
    expect(progressSent()).toBeGreaterThan(0);
    client.abort();
    await new Promise((resolve) => setTimeout(resolve, PROGRESS_INTERVAL_MS * 2));
    expect(signal?.aborted).toBe(false);
    // A client that stopped reading gets no more progress.
    const afterDisconnect = progressSent();
    await new Promise((resolve) => setTimeout(resolve, PROGRESS_INTERVAL_MS * 4));
    expect(progressSent()).toBe(afterDisconnect);
    release.resolve();
    await expect.poll(() => abortedBeforeFinishing).toBe(false);
  });

  it("keeps requests other than tools/call a single JSON response", async () => {
    const { registration } = await setup(() => agentToolSuccess({}));
    const response = await fetch(registration.server.url, {
      method: "POST",
      headers: {
        ...Object.fromEntries(registration.server.headers.map((header) => [header.name, header.value])),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ id: 1, result: { tools: [{ name: "wait_for_operator" }] } });
  });
});
