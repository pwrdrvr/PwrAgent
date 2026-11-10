// Test-owned CLI protocol peer. The installed SDK routes its registered hooks;
// no model, network, Claude session files or operator state are used.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");

if (process.argv.includes("--version")) {
  process.stdout.write("999.0.0 (Claude Code)\n");
} else if (process.argv.includes("auth")) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\n");
} else {
  const send = message => process.stdout.write(JSON.stringify(message) + "\n");
  const sessionArg = process.argv.indexOf("--session-id");
  const sessionId = sessionArg >= 0 ? process.argv[sessionArg + 1] : randomUUID();
  const pending = new Map();
  let hooks = {};
  let processed = 0;
  let draining = false;
  let started = false;
  const log = (name, value) => fs.appendFileSync(path.join(__dirname, name), JSON.stringify(value) + "\n");
  const callback = async input => {
    const outputs = [];
    for (const matcher of hooks.UserPromptSubmit ?? []) {
      for (const callbackId of matcher.hookCallbackIds) {
        const requestId = randomUUID();
        const response = new Promise(resolve => pending.set(requestId, resolve));
        send({ type: "control_request", request_id: requestId, request: {
          subtype: "hook_callback", callback_id: callbackId,
          input: { hook_event_name: "UserPromptSubmit", session_id: sessionId,
            transcript_path: "", cwd: __dirname, ...input },
        } });
        outputs.push(await response);
      }
    }
    return outputs;
  };
  const init = () => send({ type: "system", subtype: "init", session_id: sessionId, uuid: randomUUID(),
    tools: [], mcp_servers: [], slash_commands: [], model: "fable" });
  const result = uuid => {
    send({ type: "system", subtype: "session_state_changed", state: "idle" });
    send({ type: "result", subtype: "success", session_id: sessionId, uuid: randomUUID(), is_error: false,
      result: "Fixture boundary", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, ...(uuid ? { user_message_uuids: [uuid] } : {}) });
  };
  const drain = async () => {
    if (draining || !started) return;
    draining = true;
    try {
      while (true) {
        const file = path.join(__dirname, `wake-request-${processed}.json`);
        if (!fs.existsSync(file)) break;
        const wake = JSON.parse(fs.readFileSync(file, "utf8"));
        if (wake.source === "system") send({ type: "system", subtype: "task_notification", task_id: "finished-task",
          status: "completed", output_file: "", summary: "Invented background task completed" });
        const outputs = await callback(wake);
        log("hook-results.jsonl", { wake, outputs });
        processed += 1;
        if (outputs.some(output => output.decision === "block")) { init(); result(); }
      }
    } finally { draining = false; }
  };
  const watcher = fs.watch(__dirname, () => { void drain(); });
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", line => {
    const message = JSON.parse(line);
    if (message.type === "control_response") {
      const resolve = pending.get(message.response.request_id);
      pending.delete(message.response.request_id);
      resolve?.(message.response.response ?? {});
    } else if (message.type === "control_request") {
      if (message.request.subtype === "initialize") hooks = message.request.hooks ?? {};
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: { commands: [], agents: [], models: [], account: {}, mcpServers: [],
          output_style: "default", available_output_styles: ["default"] }, pending_permission_requests: [] } });
      if (message.request.subtype === "interrupt") result();
    } else if (message.type === "user") {
      log("native-inputs.jsonl", message);
      init();
      // Background work keeps this process available after its foreground turn.
      send({ type: "system", subtype: "background_tasks_changed", tasks: [
        { task_id: "remaining-task", task_type: "local_bash", description: "Invented background work" },
      ] });
      result(message.uuid);
      started = true;
      void drain();
    }
  });
  input.on("close", () => { watcher.close(); });
}
