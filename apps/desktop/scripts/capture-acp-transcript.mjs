// Drive an ACP agent over stdio the way PwrAgent's AcpAgentClient does — same
// initialize params, same session/new, one session/prompt — and record every
// frame in both directions. Writes the whole JSON-RPC log to stdout on exit.
//
// This exists so a claim about what an agent puts on the wire can be answered
// with a capture instead of a guess. The committed `acp-transcripts` fixtures
// are parity captures that contain no completed turn, so they cannot answer
// questions about usage, stop reasons, or anything else that only appears at
// the end of a turn.
//
//   node apps/desktop/scripts/capture-acp-transcript.mjs \
//     --cmd ~/.kimi-code/bin/kimi --args acp \
//     --cwd /tmp/scratch \
//     --prompt "tell me your favorite breakfast cereal" > capture.json
//
// Permission requests are DENIED by default, so a capture cannot make an agent
// act on the machine by accident. Pass `--allow-tools` when tool traffic is
// what you are trying to capture, and point `--cwd` somewhere disposable when
// you do.
//
// Output is raw protocol. It is rewritten for the operator's home directory
// and the capture cwd, but read it before committing it as a fixture — an
// agent can echo anything it read into a transcript.
import { spawn } from "node:child_process";
import os from "node:os";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const COMMAND = flag("cmd");
if (!COMMAND) {
  process.stderr.write("--cmd <agent binary> is required\n");
  process.exit(2);
}
const ARGS = (flag("args") ?? "").split(",").filter(Boolean);
const CWD = flag("cwd", os.tmpdir());
const PROMPT = flag("prompt", "tell me your favorite breakfast cereal");
const QUIET_MS = Number(flag("quiet-ms", "6000"));
const HARD_TIMEOUT_MS = Number(flag("timeout-ms", "180000"));
const ALLOW_TOOLS = process.argv.includes("--allow-tools");

const child = spawn(COMMAND, ARGS, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

const log = [];
let nextId = 1;
const pending = new Map();
let lastActivityAt = Date.now();
let promptCompleted = false;

function send(method, params) {
  const id = nextId++;
  const frame = { jsonrpc: "2.0", id, method, params };
  log.push({ dir: "out", frame });
  child.stdin.write(`${JSON.stringify(frame)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

let buffer = "";
child.stdout.on("data", (chunk) => {
  lastActivityAt = Date.now();
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      log.push({ dir: "in", unparsed: line });
      continue;
    }
    log.push({ dir: "in", frame });
    // Route on `method`, not on `id`. JSON-RPC numbers each direction
    // independently, so an agent counting its own requests from 1 collides
    // with ours as a matter of course — and matching a request against
    // `pending` resolves our in-flight call with `undefined` and drops the
    // real response when it arrives. A frame carrying `method` is a request;
    // one without is a response.
    if (frame.method) {
      respondToAgentRequest(frame);
      continue;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(JSON.stringify(frame.error)));
      else entry.resolve(frame.result);
    }
  }
});

function respondToAgentRequest(frame) {
  if (frame.id === undefined) {
    return; // A notification. Recorded above; nothing to answer.
  }
  if (frame.method === "session/request_permission" && !ALLOW_TOOLS) {
    const response = {
      jsonrpc: "2.0",
      id: frame.id,
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    };
    log.push({ dir: "out", frame: response, note: "denied (no --allow-tools)" });
    child.stdin.write(`${JSON.stringify(response)}\n`);
    return;
  }
  if (frame.method === "session/request_permission") {
    const response = {
      jsonrpc: "2.0",
      id: frame.id,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    };
    log.push({ dir: "out", frame: response });
    child.stdin.write(`${JSON.stringify(response)}\n`);
    return;
  }
  // Anything else is a method this harness does not implement. Answering `{}`
  // would be a malformed result for most of them, so refuse explicitly and
  // let the capture show the agent's reaction.
  const response = {
    jsonrpc: "2.0",
    id: frame.id,
    error: { code: -32601, message: `capture harness does not implement ${frame.method}` },
  };
  log.push({ dir: "out", frame: response });
  child.stdin.write(`${JSON.stringify(response)}\n`);
}

const stderr = [];
child.stderr.on("data", (chunk) => {
  stderr.push(chunk.toString("utf8"));
});

// Without these, an agent that fails to launch or dies mid-capture leaves the
// top-level await unsettled, and Node exits 13 with no output at all — no
// status, no stderr, nothing to debug from. The hard timeout cannot cover it
// because it is unref'd.
child.on("error", (error) => {
  finish("spawn-failed", error instanceof Error ? error.message : String(error));
});
child.on("exit", (code, signal) => {
  // An agent that exits once it has answered has given us the whole capture —
  // no more frames can arrive down a closed pipe, so stop draining and call it
  // done. Exiting before the prompt resolved is a real failure.
  if (promptCompleted) {
    finish("ok");
    return;
  }
  finish("agent-exited", `agent exited before answering (code ${code}, signal ${signal})`);
});

// Rewrite the two paths every capture on a developer machine carries. This is
// a convenience, not a guarantee: an agent can put anything it read into a
// transcript, so a capture still needs reading before it becomes a fixture.
function redact(value) {
  return JSON.parse(
    JSON.stringify(value)
      .split(CWD).join("/workspaces/scratch")
      .split(os.homedir()).join("/home/operator"),
  );
}

let finished = false;
function finish(status, detail) {
  if (finished) {
    return;
  }
  finished = true;
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  process.stdout.write(
    `${JSON.stringify(
      redact({ status, detail, stderr: stderr.join(""), log }),
      null,
      1,
    )}\n`,
  );
  // Exit code carries the outcome so a scripted caller does not have to parse
  // `status` to notice the run never completed.
  process.exit(status === "ok" ? 0 : 1);
}

setTimeout(() => finish("hard-timeout"), HARD_TIMEOUT_MS).unref();

try {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "pwragent", title: "PwrAgent", version: "0.0.0" },
  });
  const session = await send("session/new", { cwd: CWD, mcpServers: [] });
  const sessionId = session?.sessionId ?? session?.session_id;
  await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });
  promptCompleted = true;
  // Drain trailing notifications until the stream goes quiet.
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() - lastActivityAt > QUIET_MS) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });
  finish("ok");
} catch (error) {
  finish("error", error instanceof Error ? error.message : String(error));
}
