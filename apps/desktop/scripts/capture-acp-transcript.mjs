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
// Pick a prompt that needs no tools unless tool traffic is the point: the
// harness auto-approves permission requests so a tool call cannot wedge the
// run, which is convenient but means it will happily let an agent act.
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

const child = spawn(COMMAND, ARGS, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

const log = [];
let nextId = 1;
const pending = new Map();
let lastActivityAt = Date.now();

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
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(JSON.stringify(frame.error)));
      else entry.resolve(frame.result);
    }
    // Answer agent->client requests permissively so a tool call cannot wedge
    // the capture. This prompt should not trigger any.
    if (frame.id !== undefined && frame.method) {
      const response = {
        jsonrpc: "2.0",
        id: frame.id,
        result: frame.method === "session/request_permission"
          ? { outcome: { outcome: "selected", optionId: "allow" } }
          : {},
      };
      log.push({ dir: "out", frame: response });
      child.stdin.write(`${JSON.stringify(response)}\n`);
    }
  }
});

const stderr = [];
child.stderr.on("data", (chunk) => {
  stderr.push(chunk.toString("utf8"));
});

function finish(status, detail) {
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  process.stdout.write(
    `${JSON.stringify({ status, detail, stderr: stderr.join(""), log }, null, 1)}\n`,
  );
  process.exit(0);
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
