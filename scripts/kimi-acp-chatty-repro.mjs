#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_FIRST_PROMPT = "does this build?";
const DEFAULT_SECOND_PROMPT =
  "can you reduce big bundle sizes? make sure each messaging library is in a chunk so it doesn't get pulled in unless used";
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const PREVIEW_LIMIT = 180;

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}
const cwd = args.cwd ?? process.cwd();
const firstPrompt = args.first ?? DEFAULT_FIRST_PROMPT;
const secondPrompt = args.second ?? DEFAULT_SECOND_PROMPT;
const kimiCommand = args.kimiCommand ?? args["kimi-command"] ?? "kimi";
const timeoutMs = Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
const idleTimeoutMs = Number(
  args.idleTimeoutMs ?? args["idle-timeout-ms"] ?? DEFAULT_IDLE_TIMEOUT_MS,
);
const enableYolo = Boolean(args.yolo);

let nextId = 1;
let child;
let closed = false;
let lastMessageAt = 0;
let totalInbound = 0;
let loggedSecondTurn = false;
let previousText = "";
let secondTurnStartedAt = 0;
let lastLoggedEventSummary = "";
const pending = new Map();
const counts = new Map();

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
  cleanup();
});

async function main() {
  const kimiArgs = enableYolo ? ["--yolo", "acp"] : ["acp"];
  console.log("Starting kimi acp");
  console.log(`cwd: ${cwd}`);
  console.log(`command: ${kimiCommand} ${kimiArgs.join(" ")}`);
  console.log(`yolo: ${enableYolo ? "enabled via top-level --yolo" : "disabled"}`);
  console.log(`idle timeout: ${idleTimeoutMs}ms`);
  console.log(`first prompt: ${firstPrompt}`);
  console.log(`second prompt: ${secondPrompt}`);

  child = spawn(kimiCommand, kimiArgs, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.on("close", (code, signal) => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`kimi acp exited code=${code} signal=${signal}`));
    }
    pending.clear();
  });
  child.on("error", (error) => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[kimi stderr] ${chunk.toString("utf8")}`);
  });

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    handleLine(line);
  });

  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      auth: { terminal: false },
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: "kimi-acp-chatty-repro",
      title: "Kimi ACP Chatty Repro",
      version: "0.0.0",
    },
  });

  const session = await request("session/new", {
    cwd,
    mcpServers: [],
  });
  const sessionId = session?.sessionId ?? session?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`session/new did not return a session id: ${JSON.stringify(session)}`);
  }
  console.log(`sessionId: ${sessionId}`);

  console.log("Running first prompt and waiting for completion...");
  await request("session/prompt", {
    sessionId,
    prompt: textPrompt(firstPrompt),
  }, timeoutMs);
  console.log("First prompt completed.");

  console.log("Running second prompt; logging inbound ACP traffic...");
  loggedSecondTurn = true;
  previousText = "";
  secondTurnStartedAt = Date.now();
  try {
    await withSecondTurnIdleTimeout(
      request("session/prompt", {
        sessionId,
        prompt: textPrompt(secondPrompt),
      }, timeoutMs),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printSummary();
    cleanup();
    process.exitCode = 2;
    return;
  }

  console.log("Second prompt completed.");
  printSummary();
  await delay(50);
  cleanup();
}

function request(method, params, requestTimeoutMs = timeoutMs) {
  if (closed || !child?.stdin) {
    return Promise.reject(new Error("kimi acp is not running"));
  }

  const id = `rpc-${nextId++}`;
  const envelope = {
    jsonrpc: "2.0",
    id,
    method,
    params: params ?? {},
  };

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`json-rpc timeout: ${method}`));
    }, requestTimeoutMs);
    pending.set(id, { method, resolve, reject, timer });
  });

  child.stdin.write(`${JSON.stringify(envelope)}\n`);
  return promise;
}

function handleLine(line) {
  let envelope;
  try {
    envelope = JSON.parse(line);
  } catch {
    console.log(`non-json stdout: ${truncate(line)}`);
    return;
  }

  if (envelope.id != null && (Object.hasOwn(envelope, "result") || Object.hasOwn(envelope, "error"))) {
    const key = String(envelope.id);
    const requestState = pending.get(key);
    if (!requestState) {
      return;
    }
    pending.delete(key);
    clearTimeout(requestState.timer);
    if (envelope.error) {
      requestState.reject(new Error(`${requestState.method}: ${JSON.stringify(envelope.error)}`));
      return;
    }
    requestState.resolve(envelope.result);
    return;
  }

  if (envelope.id != null && envelope.method) {
    if (loggedSecondTurn) {
      console.log(
        [
          `n=${totalInbound + 1}`,
          "direction=inbound-request",
          `method=${envelope.method}`,
          `id=${envelope.id}`,
          `params=${JSON.stringify(truncate(JSON.stringify(envelope.params ?? {})))}`,
        ].join(" "),
      );
    }
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: envelope.id,
      result: {},
    })}\n`);
  }

  totalInbound += 1;
  const now = Date.now();
  const gapMs = lastMessageAt === 0 ? 0 : now - lastMessageAt;
  lastMessageAt = now;

  const method = envelope.method ?? "unknown";
  const update = asRecord(envelope.params?.update);
  const updateKind =
    stringValue(update?.sessionUpdate) ??
    stringValue(update?.session_update) ??
    stringValue(update?.kind) ??
    stringValue(update?.type) ??
    method;
  counts.set(updateKind, (counts.get(updateKind) ?? 0) + 1);

  if (!loggedSecondTurn) {
    return;
  }

  const text = extractText(envelope);
  const overlap = text ? retransmittedPrefixPercent(previousText, text) : undefined;
  if (text) {
    previousText = text;
  }

  const elapsedMs = now - secondTurnStartedAt;
  const fields = [
    `n=${totalInbound}`,
    `elapsedMs=${elapsedMs}`,
    `gapMs=${gapMs}`,
    `method=${method}`,
    `kind=${updateKind}`,
    update?.messageId || update?.message_id
      ? `messageId=${shortId(String(update.messageId ?? update.message_id))}`
      : undefined,
    update?.itemId || update?.item_id
      ? `itemId=${shortId(String(update.itemId ?? update.item_id))}`
      : undefined,
    update?.status ? `status=${update.status}` : undefined,
    update?.title ? `title=${JSON.stringify(truncate(String(update.title), 80))}` : undefined,
    update?.toolCallId ? `toolCallId=${shortId(String(update.toolCallId))}` : undefined,
    update?.tool_call_id ? `toolCallId=${shortId(String(update.tool_call_id))}` : undefined,
    text ? `textChars=${text.length}` : undefined,
    overlap === undefined ? undefined : `overlapPrevPct=${overlap.toFixed(1)}`,
    text ? `text=${JSON.stringify(truncate(text))}` : undefined,
  ].filter(Boolean);

  lastLoggedEventSummary = fields.join(" ");
  console.log(lastLoggedEventSummary);
}

function withSecondTurnIdleTimeout(promise) {
  let timer;
  const idlePromise = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (!loggedSecondTurn || secondTurnStartedAt === 0) {
        return;
      }
      const referenceTime = lastMessageAt || secondTurnStartedAt;
      const idleMs = Date.now() - referenceTime;
      if (idleMs < idleTimeoutMs) {
        return;
      }
      clearInterval(timer);
      reject(
        new Error(
          `Idle timeout after ${idleMs}ms without inbound ACP messages. Last event: ${
            lastLoggedEventSummary || "none"
          }`,
        ),
      );
    }, Math.min(1_000, Math.max(100, idleTimeoutMs)));
  });

  return Promise.race([promise, idlePromise]).finally(() => {
    clearInterval(timer);
  });
}

function printSummary() {
  console.log("Inbound message counts:");
  for (const [kind, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${count}`);
  }
  console.log(`  total: ${totalInbound}`);
}

function textPrompt(text) {
  return [{ type: "text", text }];
}

function extractText(envelope) {
  const update = asRecord(envelope.params?.update);
  return extractContentText(update?.content) ?? stringValue(update?.text) ?? "";
}

function extractContentText(content) {
  if (Array.isArray(content)) {
    return content.map((entry) => extractContentText(entry)).filter(Boolean).join("");
  }
  const record = asRecord(content);
  if (!record) {
    return undefined;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  return extractContentText(record.content);
}

function retransmittedPrefixPercent(previous, current) {
  const normalizedPrevious = previous.trimStart();
  const normalizedCurrent = current.trimStart();
  if (
    !normalizedPrevious ||
    !normalizedCurrent ||
    normalizedCurrent.length <= normalizedPrevious.length
  ) {
    return 0;
  }
  if (!normalizedCurrent.startsWith(normalizedPrevious)) {
    return 0;
  }
  return (normalizedPrevious.length / normalizedCurrent.length) * 100;
}

function truncate(value, limit = PREVIEW_LIMIT) {
  if (value.length <= limit) {
    return value;
  }
  const head = Math.ceil((limit - 3) / 2);
  const tail = Math.floor((limit - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function shortId(id) {
  return id.length <= 18 ? id : `${id.slice(0, 8)}...${id.slice(-8)}`;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const assignment = arg.slice(2);
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex !== -1) {
      parsed[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
      continue;
    }
    const key = assignment;
    const next = rawArgs[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
      continue;
    }
    parsed[key] = "1";
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/kimi-acp-chatty-repro.mjs [options]

Starts kimi acp, creates a new ACP session, sends two prompts, then logs inbound
ACP traffic during the second prompt with timing, text length, and immediate
prior-message overlap metrics.

Options:
  --kimi-command <path> ACP executable. Defaults to resolving "kimi" from PATH.
  --cwd <path>          Working directory for the ACP session. Defaults to cwd.
  --first <prompt>      First prompt. Defaults to: ${DEFAULT_FIRST_PROMPT}
  --second <prompt>     Second prompt. Defaults to the bundle-size repro prompt.
  --timeout-ms <ms>     session/prompt timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --idle-timeout-ms <ms> Exit if the second turn receives no ACP messages for
                       this long. Defaults to ${DEFAULT_IDLE_TIMEOUT_MS}.
  --yolo               Launch ACP as kimi --yolo acp.
  --help               Show this help.

Warning: the default prompts allow Kimi to inspect and edit files in --cwd.
Run this in a disposable clone or worktree when collecting repro data.
Use --yolo when you want Kimi to complete tool-heavy prompts without stopping
for approval in Default mode.`);
}

function cleanup() {
  if (child && !child.killed) {
    child.kill();
  }
}
