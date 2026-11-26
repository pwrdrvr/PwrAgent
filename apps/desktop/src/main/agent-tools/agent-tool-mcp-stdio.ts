import type { AcpMcpServerConfig } from "../acp/acp-client";
import type { AgentToolHttpMcpServerConfig } from "./agent-tool-mcp-server";

// The child only forwards MCP frames. Its owner-bound credential selects the
// restricted stdio catalog through the same authorization path as HTTP.
const bridge = String.raw`
const readline = require("node:readline");
const { PWRAGENT_STDIO_MCP_URL: url, PWRAGENT_STDIO_MCP_AUTH: authorization } = process.env;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
(async () => {
  let sessionId;
  let protocolVersion;
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization, "content-type": "application/json", accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
        },
        body: line,
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 202) continue;
      if (!response.ok) throw new Error("PwrAgent endpoint refused request");
      const payload = await response.json();
      if (request?.method === "initialize") {
        sessionId = response.headers.get("mcp-session-id");
        protocolVersion = payload.result?.protocolVersion;
      }
      process.stdout.write(JSON.stringify(payload) + "\n");
    } catch {
      if (request && Object.hasOwn(request, "id")) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "PwrAgent tools are unavailable over stdio." },
        }) + "\n");
      }
    }
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
