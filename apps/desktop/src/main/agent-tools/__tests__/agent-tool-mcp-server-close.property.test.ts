import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { AgentToolRouter } from "../agent-tool-router";
import { AgentToolMcpServer, type AgentToolMcpRegistration } from "../agent-tool-mcp-server";
import { agentToolSuccess } from "../agent-tool-definition";
import type { ResolvedAgentToolCatalog } from "../agent-tool-catalog-registry";

// A keep-alive client holds its socket open after a response for as long as
// the server's Keep-Alive hint allows: undici, which backs fetch and the MCP
// SDK client, waits about 3 seconds. A server that leaves that socket to the
// client therefore closes 3 seconds late. CLOSE_BOUND_MS sits well below that
// wait and well above a loaded worker's scheduling delay.
const CLOSE_BOUND_MS = 1_500;

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function buildCatalog(dispatch: () => Promise<unknown>): ResolvedAgentToolCatalog {
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

function callRequest(registration: AgentToolMcpRegistration, id: number, signal: AbortSignal): Promise<Response> {
  return fetch(registration.server.url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(registration.server.headers.map((header) => [header.name, header.value])),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "wait_for_operator", arguments: {} } }),
    signal,
  });
}

describe("AgentToolMcpServer close", () => {
  const openServers: AgentToolMcpServer[] = [];
  afterEach(async () => {
    await Promise.all(openServers.splice(0).map(async (server) => server.close()));
  });

  // Model: shutdown never cuts a call short, and once every admitted call has
  // answered, nothing the server owns keeps it open. The interleavings are
  // when close starts relative to each call finishing, and a client that, like
  // the MCP SDK's, reads each answer to its end and then aborts. Oracle: close
  // settles within CLOSE_BOUND_MS of the last answer reaching its client.
  it("settles once every in-flight call has answered, whenever shutdown began", async ({ signal }) => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 3 }), fc.nat({ max: 3 }), fc.nat({ max: 20 }),
      async (calls, closeAfter, gapMs) => {
        signal.throwIfAborted();
        const releases = Array.from({ length: calls }, deferred);
        let started = 0;
        const server = new AgentToolMcpServer({
          resolveCallContext: (context) => context.threadId
            ? { backend: context.backend, threadId: context.threadId, turnId: "turn-1" } : undefined,
          resolveCatalogs: () => [buildCatalog(async () => {
            await releases[started++]!.promise;
            return agentToolSuccess({ status: "done" });
          })],
        });
        openServers.push(server);
        const registration = await server.registerClient({ backend: "claude", threadId: "thread-1" });
        const client = new AbortController();
        const responses = await Promise.all(releases.map((_, index) => callRequest(registration, index + 1, client.signal)));
        const answers = responses.map(async (response) => {
          const body = await response.text();
          return { body, at: performance.now() };
        });
        let closing: Promise<number> | undefined;
        const startClose = () => {
          closing = server.close().then(() => performance.now());
        };
        // Close starts after `closeAfter` calls have finished: before all of
        // them (in flight) or after (idle).
        for (const [index, release] of releases.entries()) {
          if (index === closeAfter) startClose();
          release.resolve();
          await new Promise((resolve) => setTimeout(resolve, gapMs));
        }
        if (!closing) startClose();
        const answered = await Promise.all(answers);
        client.abort();
        // A call is never cut short: each client got its tool's result.
        for (const [index, answer] of answered.entries()) {
          expect(answer.body).toContain(`"id":${index + 1}`);
          expect(answer.body).toContain("done");
        }
        const lastAnswerAt = Math.max(...answered.map((answer) => answer.at));
        const closedAt = await closing!;
        expect(closedAt - lastAnswerAt, "close waited on a connection after its last answer").toBeLessThan(CLOSE_BOUND_MS);
      },
    ), { numRuns: 12 });
  }, 60_000);
});
