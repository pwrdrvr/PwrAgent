import type { AcpMcpServerConfig } from "../acp/acp-client";
import type { AgentToolHttpMcpServerConfig } from "./agent-tool-mcp-server";

// The child only forwards MCP frames. Its owner-bound credential grants
// memory calls through the same authorization path as the HTTP transport.
const bridge = String.raw`
const readline = require("node:readline");
const { PWRAGENT_MEMORY_MCP_URL: url, PWRAGENT_MEMORY_MCP_AUTH: authorization } = process.env;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
(async () => {
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: line,
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 202) continue;
      if (!response.ok) throw new Error("Memory endpoint refused request");
      const payload = await response.json();
      process.stdout.write(JSON.stringify(payload) + "\n");
    } catch {
      if (request && Object.hasOwn(request, "id")) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "PwrAgent Agent memory is unavailable." },
        }) + "\n");
      }
    }
  }
})().catch(() => { process.exitCode = 1; });
`;

export function buildAgentMemoryStdioServer(server: AgentToolHttpMcpServerConfig) {
  const authorization = server.headers.find(({ name }) => name.toLowerCase() === "authorization")?.value;
  if (!authorization) throw new Error("The Agent memory MCP registration has no credential.");
  return {
    name: server.name,
    command: process.execPath,
    args: ["-e", bridge],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      PWRAGENT_MEMORY_MCP_URL: server.url,
      PWRAGENT_MEMORY_MCP_AUTH: authorization,
    },
  } satisfies AcpMcpServerConfig;
}
