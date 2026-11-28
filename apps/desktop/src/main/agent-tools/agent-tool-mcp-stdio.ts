import type { AcpMcpServerConfig } from "../acp/acp-client";
import type { AgentToolHttpMcpServerConfig } from "./agent-tool-mcp-server";

// The child only forwards MCP frames. Its owner-bound credential selects the
// restricted stdio catalog through the same authorization path as HTTP.
const bridge = String.raw`
const readline = require("node:readline");
const http = require("node:http");
const { json } = require("node:stream/consumers");
const { PWRAGENT_STDIO_MCP_URL: url, PWRAGENT_STDIO_MCP_AUTH: authorization } = process.env;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let sessionId;
let protocolVersion;

async function forward(request, line, controller) {
  let replied = false;
  const write = (frame) => {
    if (controller.signal.aborted || replied) return;
    process.stdout.write(JSON.stringify(frame) + "\n");
    if (Object.hasOwn(frame, "id") && frame.id === request.id) replied = true;
  };
  try {
    // Gateway deadlines include approval time and are extended by upstream progress.
    const gatewayCall = request.method === "tools/call"
      && ["search_mcp_tools", "call_mcp_tool", "read_mcp_context"].includes(request.params?.name);
    const response = await new Promise((resolve, reject) => {
      http.request(url, {
        method: "POST",
        headers: {
          authorization, "content-type": "application/json", accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
        },
        signal: gatewayCall ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      }, resolve).on("error", reject).end(line);
    });
    if (response.statusCode === 202) {
      response.resume();
      return;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error("PwrAgent endpoint refused request");
    }
    if (response.headers["content-type"]?.includes("text/event-stream")) {
      let data = [];
      for await (const field of readline.createInterface({ input: response, crlfDelay: Infinity })) {
        if (field.startsWith("data:")) data.push(field.slice(5).replace(/^ /, ""));
        if (field === "" && data.length) {
          const payload = data.join("\n");
          data = [];
          // The SDK can prime a stream with an empty event.
          if (!payload) continue;
          const frame = JSON.parse(payload);
          write(frame);
        }
      }
      if (!replied) throw new Error("PwrAgent stream closed before the result");
      return;
    }
    const payload = await json(response);
    if (request.method === "initialize") {
      sessionId = response.headers["mcp-session-id"];
      protocolVersion = payload.result?.protocolVersion;
    }
    write(payload);
  } catch {
    if (Object.hasOwn(request, "id")) {
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "PwrAgent tools are unavailable over stdio." } });
    }
  } finally {
    if (pending.get(request.id) === controller) pending.delete(request.id);
  }
}

(async () => {
  try {
    for await (const line of input) {
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      if (!request || typeof request !== "object") continue;
      if (request.method === "notifications/cancelled") {
        // Each HTTP POST owns a separate MCP transport. Close the original
        // request so cancellation reaches the operation that is waiting.
        pending.get(request.params?.requestId)?.abort();
        continue;
      }
      const controller = new AbortController();
      if (Object.hasOwn(request, "id")) pending.set(request.id, controller);
      const sent = forward(request, line, controller);
      if (request.method === "initialize") await sent;
    }
  } finally {
    for (const controller of pending.values()) controller.abort();
  }
})().catch(() => { process.exitCode = 1; });
`;

export function buildAgentToolStdioServer(server: AgentToolHttpMcpServerConfig) {
  const authorization = server.headers.find(({ name }) => name.toLowerCase() === "authorization")?.value;
  if (!authorization) throw new Error("The PwrAgent stdio MCP registration has no credential.");
  return {
    name: server.name,
    command: process.execPath,
    args: ["-e", bridge],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      PWRAGENT_STDIO_MCP_URL: server.url,
      PWRAGENT_STDIO_MCP_AUTH: authorization,
    },
  } satisfies AcpMcpServerConfig;
}
