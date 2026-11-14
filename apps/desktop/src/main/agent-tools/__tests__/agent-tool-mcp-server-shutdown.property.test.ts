import fc from "fast-check";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { AgentToolMcpServer, type AgentToolMcpRegistration } from "../agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tool-router";
import { agentToolSuccess } from "../agent-tool-definition";

// A keep-alive client holds its socket open after a response for as long as
// the server's Keep-Alive hint allows: undici, which backs fetch and the MCP
// SDK client, waits about 3 seconds. A server that leaves that socket to the
// client therefore closes 3 seconds late. CLOSE_BOUND_MS sits well below that
// wait and well above a loaded worker's scheduling delay.
const CLOSE_BOUND_MS = 1_500;

function fixtureHeaders(registration: AgentToolMcpRegistration, accept: string): Record<string, string> {
  return {
    ...Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])),
    "Content-Type": "application/json",
    Accept: accept,
  };
}

describe("AgentToolMcpServer shutdown ownership", () => {
  // Oracle: the real TCP peers must close without the client volunteering to
  // disconnect. A connection with no complete HTTP request owns no tool work.
  it("releases every accepted connection that has not submitted a request", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
      async (partialRequests) => {
        const server = new AgentToolMcpServer({
          resolveCatalogs: () => [],
          resolveCallContext: () => undefined,
        });
        const sockets: Socket[] = [];
        let closing: Promise<void> | undefined;
        try {
          const registration = await server.registerClient({ backend: "acp:kimi", threadId: "fixture" });
          const url = new URL(registration.server.url);
          let peersClosed = 0;
          for (const partial of partialRequests) {
            const socket = connect({ host: url.hostname, port: Number(url.port) });
            sockets.push(socket);
            socket.on("error", () => undefined);
            socket.on("close", () => { peersClosed += 1; });
            await once(socket, "connect");
            if (partial) socket.write("POST /mcp HTTP/1.1\r\n");
          }
          let serverClosed = false;
          closing = server.close().then(() => { serverClosed = true; });
          await expect.poll(() => ({ serverClosed, peersClosed })).toEqual({
            serverClosed: true,
            peersClosed: sockets.length,
          });
        } finally {
          for (const socket of sockets) socket.destroy();
          await (closing ?? server.close());
        }
      },
    ), { numRuns: 10, endOnFailure: true });
  });

  // Model: shutdown never cuts an admitted call short, and once every call
  // has answered, nothing the server owns keeps it open. The interleavings are
  // when close starts relative to each call finishing, with a client that,
  // like the MCP SDK's, reads each answer to its end and then aborts. Oracle:
  // each client gets its tool's result, and close settles within
  // CLOSE_BOUND_MS of the last answer.
  it("drains admitted calls and settles once they have answered, whenever shutdown began", async ({ signal }) => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 3 }), fc.nat({ max: 3 }), fc.nat({ max: 20 }),
      async (calls, closeAfter, gapMs) => {
        signal.throwIfAborted();
        const releases = Array.from({ length: calls }, () => Promise.withResolvers<void>());
        let dispatched = 0;
        const router = new AgentToolRouter([{
          namespace: "pwragent",
          name: "wait_for_fixture",
          description: "Wait for the fixture to release admitted work.",
          inputSchema: { type: "object" },
          dispatch: async () => {
            await releases[dispatched++]!.promise;
            return agentToolSuccess({ drained: true });
          },
        }]);
        const server = new AgentToolMcpServer({
          resolveCatalogs: () => [{ id: "app_management", router }],
          resolveCallContext: (context) => ({ ...context, threadId: "fixture", turnId: "turn-1" }),
        });
        const client = new AbortController();
        let closing: Promise<number> | undefined;
        const startClose = () => {
          closing = server.close().then(() => performance.now());
        };
        try {
          const registration = await server.registerClient({ backend: "acp:kimi", threadId: "fixture" });
          const responses = await Promise.all(releases.map((_, index) => fetch(registration.server.url, {
            method: "POST",
            headers: fixtureHeaders(registration, "application/json, text/event-stream"),
            body: JSON.stringify({
              jsonrpc: "2.0", id: index + 1, method: "tools/call",
              params: { name: "wait_for_fixture", arguments: {} },
            }),
            signal: client.signal,
          })));
          const answers = responses.map(async (response) => ({ body: await response.text(), at: performance.now() }));
          // Close starts after `closeAfter` calls have finished: while calls
          // are in flight, or once all of them have answered.
          for (const [index, release] of releases.entries()) {
            if (index === closeAfter) startClose();
            release.resolve();
            await new Promise((resolve) => setTimeout(resolve, gapMs));
          }
          if (!closing) startClose();
          const answered = await Promise.all(answers);
          client.abort();
          for (const [index, answer] of answered.entries()) {
            expect(answer.body).toContain(`"id":${index + 1}`);
            expect(answer.body).toContain('"structuredContent":{"drained":true}');
          }
          const lastAnswerAt = Math.max(...answered.map((answer) => answer.at));
          expect((await closing!) - lastAnswerAt, "close waited on a connection after its last answer").toBeLessThan(CLOSE_BOUND_MS);
        } finally {
          for (const release of releases) release.resolve();
          await (closing ?? server.close());
        }
      },
    ), { numRuns: 12 });
  }, 60_000);

  // A client's standalone SSE stream (the GET it opens to hear from the
  // server) carries no call. Shutdown ends it rather than waiting for the
  // client to hang up, which a client that outlives the app never does.
  it("ends a client's standalone event stream instead of waiting for the client", async () => {
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => [],
      resolveCallContext: () => undefined,
    });
    const client = new AbortController();
    let closing: Promise<void> | undefined;
    try {
      const registration = await server.registerClient({ backend: "acp:kimi", threadId: "fixture" });
      const stream = await fetch(registration.server.url, {
        method: "GET",
        headers: fixtureHeaders(registration, "text/event-stream"),
        signal: client.signal,
      });
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const ended = stream.text().then(() => true, () => true);
      const startedAt = performance.now();
      let closedAt: number | undefined;
      closing = server.close().then(() => { closedAt = performance.now(); });
      expect(await ended).toBe(true);
      await expect.poll(() => closedAt, { timeout: CLOSE_BOUND_MS * 2 }).toBeDefined();
      expect(closedAt! - startedAt).toBeLessThan(CLOSE_BOUND_MS);
    } finally {
      client.abort();
      await (closing ?? server.close());
    }
  });
});
