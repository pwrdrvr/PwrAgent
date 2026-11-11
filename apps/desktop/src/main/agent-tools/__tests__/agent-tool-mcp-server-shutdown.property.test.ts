import fc from "fast-check";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { AgentToolMcpServer } from "../agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tool-router";
import { agentToolSuccess } from "../agent-tool-definition";

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

  it("drains an admitted tool response before closing its connection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const router = new AgentToolRouter([{
      namespace: "pwragent",
      name: "wait_for_fixture",
      description: "Wait for the fixture to release admitted work.",
      inputSchema: { type: "object" },
      dispatch: async () => {
        await gate;
        return agentToolSuccess({ drained: true });
      },
    }]);
    const server = new AgentToolMcpServer({
      resolveCatalogs: () => [{ id: "app_management", router }],
      resolveCallContext: (context) => ({ ...context, threadId: "fixture", turnId: "turn-1" }),
    });
    let closing: Promise<void> | undefined;
    try {
      const registration = await server.registerClient({ backend: "acp:kimi", threadId: "fixture" });
      const response = await fetch(registration.server.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "wait_for_fixture", arguments: {} },
        }),
      });
      const result = response.text();
      closing = server.close();
      release();
      expect(await result).toContain('"structuredContent":{"drained":true}');
      await closing;
    } finally {
      release();
      await (closing ?? server.close());
    }
  });
});
