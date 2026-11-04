// Discovery only: the async input never yields a user prompt, so no model turn
// is requested. Run with --modern to advertise the reference skills extension.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";

const modern = process.argv.includes("--modern");
const methods = [];
const uri = "skill://waiting-on-work/SKILL.md";
const text = "---\nname: waiting-on-work\ndescription: Waiting workflow probe.\n---\n\nUse PwrAgent waits and end the turn.\n";
const capabilities = { tools: {}, resources: {}, prompts: {}, extensions: { "io.modelcontextprotocol/skills": {} } };
const skill = {
  uri, frontmatter: { name: "waiting-on-work", description: "Waiting workflow probe." },
  resources: [{ uri, size: Buffer.byteLength(text), digest: `sha256:${createHash("sha256").update(text).digest("hex")}` }],
};
const serverInfo = { name: "pwragent-skill-probe", version: "1" };
const instructions = `Read ${uri} when waiting for CI or a long job.`;
const results = {
  initialize: { protocolVersion: "2025-03-26", serverInfo, capabilities, instructions },
  "tools/list": { tools: [{ name: "probe_tool", description: "Discovery probe only.", inputSchema: { type: "object", properties: {} } }] },
  "resources/list": { resources: [{ uri, name: "waiting-on-work", mimeType: "text/markdown", description: "Waiting workflow probe." }] },
  "resources/templates/list": { resourceTemplates: [] },
  "prompts/list": { prompts: [{ name: "waiting-on-work", description: "Waiting workflow probe." }] },
  "skills/list": { skills: [skill] },
  "skills/get": { skill },
  "resources/read": { contents: [{ uri, mimeType: "text/markdown", text }] },
  "prompts/get": { messages: [{ role: "user", content: { type: "text", text } }] },
  ...(modern ? {
    "server/discover": {
      supportedVersions: ["2026-07-28", "2025-03-26"], capabilities,
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo }, instructions,
    },
  } : {}),
};
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405);
    response.end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const message = JSON.parse(raw);
  methods.push(message.method);
  if (!("id" in message)) {
    response.writeHead(202);
    response.end();
    return;
  }
  const result = results[message.method];
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    jsonrpc: "2.0", id: message.id,
    ...(result ? {
      result: modern ? { ...result, resultType: "complete", cacheScope: "public", ttlMs: 300_000 } : result,
    } : { error: { code: -32601, message: "Not implemented by discovery probe." } }),
  }));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const controller = new AbortController();
let releaseInput;
const inputGate = new Promise((resolve) => { releaseInput = resolve; });
async function* input() { await inputGate; }
const session = query({
  prompt: input(),
  options: {
    abortController: controller,
    cwd: tmpdir(),
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    mcpServers: { probe: { type: "http", url: `http://127.0.0.1:${server.address().port}` } },
  },
});
const timeout = setTimeout(() => controller.abort(), 30_000);
try {
  const commands = await session.supportedCommands();
  const statuses = await session.mcpServerStatus();
  console.log(JSON.stringify({
    modern,
    commands: commands.filter((command) => command.name.includes("waiting-on-work")),
    status: statuses.filter((status) => status.name === "probe").map(({ name, status }) => ({ name, status })),
    methods,
  }));
} finally {
  clearTimeout(timeout);
  controller.abort();
  releaseInput();
  session.close();
  server.closeAllConnections();
  server.close();
}
