import { createServer, type Server } from "node:http";
import { once } from "node:events";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, summarizeRequest, type LocalRequestDiagnostic } from "../codex-app-server/local-responses-bridge.mjs";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("local Responses request diagnostics", () => {
  it("observes the exact forwarded bytes and rejection without retaining private content", async () => {
    const received: string[] = [];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
        error: { message: "PRIVATE_UPSTREAM_ERROR", n_prompt_tokens: 179567, n_ctx: 65536 },
      }));
    });
    servers.push(upstream);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address() as { port: number };
    const events: LocalRequestDiagnostic[] = [];
    const bridge = await startBridge(`http://127.0.0.1:${address.port}/v1`, "PRIVATE_API_KEY", {
      onDiagnostic: (event) => events.push(event),
    });
    servers.push(bridge);
    const port = (bridge.address() as { port: number }).port;
    const request = JSON.stringify({
      model: "/private/model/path", instructions: "PRIVATE_INSTRUCTIONS 🪴",
      input: [{ role: "user", content: [{ type: "input_text", text: "PRIVATE_PROMPT" }] }],
      tools: [{ type: "namespace", name: "pwragent", tools: [{
        type: "function", name: "inspect", description: "PRIVATE_DESCRIPTION",
        parameters: { type: "object", properties: { PRIVATE_SCHEMA: { type: "string" } } },
      }] }],
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { "Content-Type": "application/json", session_id: "01a1ddcd-e0dc-7993-90b9-88d17838d78f" }, body: request,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("PRIVATE_UPSTREAM_ERROR");
    const sent = events.find((event) => event.kind === "request");
    expect(sent).toBeDefined();
    if (!sent) throw new Error("Missing request diagnostics");
    expect(sent.threadId).toBe("01a1ddcd-e0dc-7993-90b9-88d17838d78f");
    expect(sent.incoming.wireBytes).toBe(Buffer.byteLength(request));
    expect(sent.outgoing.wireBytes).toBe(Buffer.byteLength(received[0]));
    expect(sent.incoming.toolCount).toBe(1);
    expect(sent.incoming.largestTools[0].name).toBe("pwragent.inspect");
    expect(events.find((event) => event.kind === "response")).toMatchObject({
      requestId: sent.requestId, status: 400, promptTokens: 179567, contextTokens: 65536,
    });
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|\/private\/model/);
  });

  it("forwards a successful response even when the diagnostic observer throws", async () => {
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) { /* Drain the request before replying. */ }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ output: [] }));
    });
    servers.push(upstream);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const bridge = await startBridge(`http://127.0.0.1:${upstreamPort}/v1`, undefined, {
      onDiagnostic: () => { throw new Error("The observer is unavailable"); },
    });
    servers.push(bridge);
    const port = (bridge.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: JSON.stringify({ input: "Hello" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: [] });
  });

  it("accounts for every serialized byte without changing any generated request", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.string(), (extra, text) => {
      const request = {
        instructions: text,
        input: [{ role: "user", content: [{ type: "input_text", text }] }],
        tools: [{ type: "function", name: "inspect", description: text, parameters: extra }],
        privateUnknownField: extra,
      };
      const serialized = JSON.stringify(request);
      const summary = summarizeRequest(request, Buffer.byteLength(serialized));
      expect(summary.wireBytes).toBe(Buffer.byteLength(serialized));
      expect(summary.jsonBytes).toBe(Buffer.byteLength(serialized));
      expect(Object.values(summary.fieldBytes).reduce((sum, bytes) => sum + bytes, summary.envelopeBytes))
        .toBe(summary.jsonBytes);
      expect(summary.largestTools[0].schemaBytes).toBe(Buffer.byteLength(JSON.stringify(extra)));
      expect(JSON.stringify(request)).toBe(serialized);
      expect(summary.fieldBytes).not.toHaveProperty("privateUnknownField");
    }));
  });

  it("bounds metadata regardless of catalog and history size, including hostile labels", () => {
    fc.assert(fc.property(fc.integer({ min: 11, max: 300 }), fc.string({ minLength: 100, maxLength: 300, size: "max" }), (count, secret) => {
      const summary = summarizeRequest({
        input: Array.from({ length: count }, () => ({ role: secret, type: secret, content: secret })),
        tools: Array.from({ length: count }, (_, index) => ({ type: "function", name: secret, description: "x".repeat(index), parameters: {} })),
      });
      expect(summary.toolCount).toBe(count);
      expect(summary.inputCount).toBe(count);
      expect(summary.largestTools).toHaveLength(10);
      expect(summary.largestInput).toHaveLength(10);
      expect(JSON.stringify(summary).length).toBeLessThan(10_000);
      expect(JSON.stringify(summary)).not.toContain(secret);
    }), { numRuns: 30 });
  });
});
