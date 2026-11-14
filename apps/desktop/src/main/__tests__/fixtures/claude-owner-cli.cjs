// Test-owned Claude CLI wire fixture. No model, network or provider storage.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");

if (process.argv.includes("--version")) {
  process.stdout.write("999.0.0 (Claude Code)\n");
} else if (process.argv.includes("auth")) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\n");
} else {
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  const requests = path.join(__dirname, "claude-requests.jsonl");
  const sessionArg = process.argv.indexOf("--session-id");
  const resumeArg = process.argv.indexOf("--resume");
  const sessionId = sessionArg >= 0 ? process.argv[sessionArg + 1]
    : resumeArg >= 0 ? process.argv[resumeArg + 1] : randomUUID();
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: { commands: [], agents: [], models: [{ value: "fable", displayName: "Fixture Fable", description: "Fixture" }],
          account: {}, mcpServers: [], output_style: "default", available_output_styles: ["default"] },
        pending_permission_requests: [] } });
    } else if (message.type === "user") {
      fs.appendFileSync(requests, line + "\n");
      const index = fs.readFileSync(requests, "utf8").trim().split("\n").length;
      send({ type: "system", subtype: "init", session_id: sessionId, uuid: randomUUID(),
        tools: [], mcp_servers: [], slash_commands: [], model: "fable" });
      // Tests release work over a socket they own, never a sleep and never a
      // filesystem watch, which can miss a file written as it arms. See
      // helpers/claude-owner-cli-releases.ts.
      const port = Number(fs.readFileSync(path.join(__dirname, "claude-release-port"), "utf8"));
      const socket = net.connect(port, "127.0.0.1", () => { socket.write(`${index}\n`); });
      socket.once("data", () => {
        const text = `Claude fixture completed ${index}.`;
        send({ type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
          message: { id: `answer-${index}`, role: "assistant", content: [{ type: "text", text }] } });
        send({ type: "result", subtype: "success", session_id: sessionId, uuid: randomUUID(),
          is_error: false, result: text, num_turns: 1, duration_ms: 1, duration_api_ms: 1,
          total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
          user_message_uuids: [message.uuid] });
      });
    }
  });
}
