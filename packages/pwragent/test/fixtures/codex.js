#!/usr/bin/env node
// A protocol fixture, not a model/provider. All state is test-owned.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

assert.deepEqual(process.argv.slice(2), ["app-server", "--listen", "stdio://"]);
const directory = process.env.PWRAGENT_TEST_DATA;
assert.ok(directory);
const log = (value) => appendFileSync(path.join(directory, "calls.jsonl"), JSON.stringify(value) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let initialized = false;
let acknowledged = false;
let active;
let sequence = 0;
const helpers = new Set();
const helperControl = () => {
  try { return JSON.parse(readFileSync(path.join(directory, "helper-title.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return undefined; }
};
const records = path.join(directory, "fixture-threads.json");
let threads;
try { threads = JSON.parse(readFileSync(records, "utf8")); } catch { threads = {}; }
const persist = () => {
  // Daemon shutdown may kill this fixture during a native-name update. Keep
  // the preceding complete provider snapshot until its replacement is ready.
  const temporary = `${records}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(threads));
  renameSync(temporary, records);
};
const complete = (status) => {
  if (!active) return;
  clearTimeout(active.timer);
  const turn = { id: active.id, status, items: [{ type: "agentMessage", text: "Fixture result" }],
    error: status === "failed" ? { message: "Fixture failure" } : null };
  threads[active.threadId].turns.push(turn);
  persist();
  send({ method: "turn/completed", params: { threadId: active.threadId, turn } });
  active = null;
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  log(message);
  const { method, id, params } = message;
  if (!method) {
    if (String(id).startsWith("fixture-tool-")) {
      appendFileSync(path.join(directory, "tool-results.jsonl"), JSON.stringify(message.result) + "\n");
      complete("completed");
    }
    continue;
  }
  const reply = (result) => send({ id, result });
  if (method === "initialize") {
    assert.equal(initialized, false);
    assert.equal(params.capabilities.experimentalApi, true);
    initialized = true;
    reply({ userAgent: "fixture-codex/0.159.2", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" });
  } else if (method === "initialized") {
    assert.ok(initialized);
    acknowledged = true;
  } else {
    assert.ok(acknowledged);
    const stalled = helperControl()?.stalledMethod;
    if (method === stalled
      && (method !== "thread/start" || params.ephemeral === true)
      && (method !== "turn/start" || helpers.has(params.threadId))
      && (method !== "thread/name/set" || params.name === "Helper generated title")) continue;
    if (method === "config/read" && helperControl()) {
      reply({ config: { mcp_servers: {} } });
    } else if (method === "account/read") {
      reply({ account: null, requiresOpenaiAuth: false });
    } else if (method === "mcpServerStatus/list" && helpers.has(params.threadId)) {
      reply({ data: [], nextCursor: null });
    } else if (method === "thread/unsubscribe" && helpers.has(params.threadId)) {
      helpers.delete(params.threadId);
      reply({});
    } else if (method === "thread/start" && params.ephemeral === true && helperControl()) {
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandbox, "read-only");
      assert.equal(params.config.project_doc_max_bytes, 0);
      assert.equal(params.config.features.hooks, false);
      assert.deepEqual(params.config.notify, []);
      assert.equal(params.dynamicTools, undefined);
      const threadId = `helper-${++sequence}`;
      helpers.add(threadId);
      reply({ thread: { id: threadId, cwd: params.cwd, ephemeral: true, turns: [] }, instructionSources: [] });
    } else if (method === "turn/start" && helpers.has(params.threadId)) {
      assert.ok(params.outputSchema);
      reply({ turn: { id: `helper-turn-${++sequence}`, status: "completed", items: [
        { type: "agentMessage", text: JSON.stringify({ title: helperControl().title }) },
      ] } });
    } else if (method === "model/list") {
      reply({ data: [{ id: "fixture-model", displayName: "Fixture model", isDefault: true, hidden: false,
        supportedReasoningEfforts: [], defaultReasoningEffort: "medium", inputModalities: ["text"], additionalSpeedTiers: [], serviceTiers: [] }], nextCursor: null });
    } else if (method === "thread/start" || method === "thread/resume") {
      if (params.approvalPolicy !== undefined) assert.equal(params.approvalPolicy, "never");
      if (params.sandbox !== undefined) assert.ok(["read-only", "workspace-write"].includes(params.sandbox));
      if (params.cwd !== undefined) assert.ok(params.cwd === process.cwd() || params.cwd.startsWith(process.cwd() + path.sep));
      const threadId = params.threadId || `thread-${Date.now()}-${++sequence}`;
      if (method === "thread/resume") {
        assert.ok(threads[threadId]);
        if (!threads[threadId].turns.length && active?.threadId !== threadId) {
          send({ id, error: { code: -32600, message: `no rollout found for thread id ${threadId}` } });
          continue;
        }
      }
      threads[threadId] ||= { id: threadId, cwd: params.cwd, turns: [] };
      persist();
      reply({ thread: threads[threadId] });
    } else if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandboxPolicy.networkAccess, false);
      assert.ok(params.cwd === process.cwd() || params.cwd.startsWith(process.cwd() + path.sep));
      const prompt = params.input[0].text;
      // Codex reports the first user message as the thread's preview.
      if (threads[params.threadId] && threads[params.threadId].preview === undefined) {
        threads[params.threadId].preview = prompt;
        persist();
      }
      active = { id: `turn-${++sequence}`, threadId: params.threadId };
      const initial = { turn: { id: active.id, status: "inProgress", items: [], error: null } };
      if (prompt.startsWith("tool ")) {
        reply(initial);
        const tool = JSON.parse(prompt.slice(5));
        send({ id: `fixture-tool-${active.id}`, method: "item/tool/call", params: { threadId: params.threadId, turnId: active.id,
          callId: `call-${active.id}`, namespace: "pwragent", tool: tool.operation, arguments: tool.args || {} } });
        continue;
      }
      if (prompt === "returned") {
        const turn = { id: active.id, status: "completed", items: [{ type: "agentMessage", text: "Returned result" }] };
        threads[active.threadId].turns.push(turn);
        persist();
        active = null;
        reply({ turn });
        continue;
      }
      if (prompt === "early") { complete("completed"); reply(initial); continue; }
      reply(initial);
      if (prompt === "crash") {
        process.once("SIGUSR1", () => process.exit(7));
        send({ method: "turn/started", params: { threadId: active.threadId, turn: initial.turn } });
        writeFileSync(path.join(directory, "crash.ready"), active.id);
        continue;
      }
      if (prompt === "descendant") {
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(()=>{},1000)", path.join(directory, "descendant.ready")], { stdio: "ignore" });
        writeFileSync(path.join(directory, "descendant.pid"), String(child.pid));
      }
      if (prompt === "approval" || prompt === "question") {
        send({ id: "server-request", method: prompt === "approval" ? "item/commandExecution/requestApproval" : "item/tool/requestUserInput",
          params: { threadId: params.threadId, turnId: active.id } });
      }
      active.timer = setTimeout(() => {
        writeFileSync(path.join(params.cwd, "fixture-result.txt"), prompt);
        complete(prompt === "fail" ? "failed" : "completed");
      }, ["slow", "descendant", "approval", "question"].includes(prompt) ? 30000 : 100);
    } else if (method === "turn/steer") {
      assert.equal(params.expectedTurnId, active.id);
      if (params.input?.[0]?.text === "hold-steer-ack") {
        const turnId = active.id;
        const watcher = watch(directory, (_event, file) => {
          if (file !== "steer.release") return;
          watcher.close();
          reply({ turnId });
        });
        writeFileSync(path.join(directory, "steer.ready"), turnId);
        continue;
      }
      reply({ turnId: active.id });
    } else if (method === "turn/interrupt") {
      assert.equal(params.threadId, active.threadId);
      assert.equal(params.turnId, active.id);
      complete("interrupted");
      reply({});
    } else if (method === "thread/read") {
      reply({ thread: { ...threads[params.threadId], path: `/fixture-provider/${params.threadId}` } });
    } else if (method === "thread/list") {
      // Other owners/tests can retire native records between complete walks.
      // This file belongs to the fixture; no provider storage is inspected.
      try { threads = JSON.parse(readFileSync(records, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      let control;
      try { control = JSON.parse(readFileSync(path.join(directory, "discovery-control.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      reply(control?.repeatArchived === (params.archived === true)
        ? { data: [], nextCursor: "fixture-repeated-cursor" }
        : { data: Object.values(threads).filter(thread => Boolean(thread.archived) === (params.archived === true)), nextCursor: null });
    } else if (method === "thread/turns/list") {
      reply({ data: threads[params.threadId].turns.slice().reverse().map((turn) => ({ ...turn, itemsView: "full" })), nextCursor: null });
    } else if (method === "thread/name/set") {
      threads[params.threadId].name = params.name;
      persist();
      reply({});
      send({ method: "thread/name/updated", params: { threadId: params.threadId, threadName: params.name } });
    } else if (method === "fs/readFile") {
      const thread = threads[path.basename(params.path)];
      assert.ok(thread);
      reply({ dataBase64: Buffer.from(JSON.stringify(thread)).toString("base64") });
    } else if (method === "thread/fork") {
      const imported = JSON.parse(readFileSync(params.path, "utf8"));
      const threadId = `imported-${++sequence}-${Date.now()}`;
      threads[threadId] = { ...imported, id: threadId, cwd: params.cwd };
      persist();
      reply({ thread: threads[threadId] });
    } else if (method === "thread/archive") {
      threads[params.threadId].archived = true;
      persist();
      reply({});
    } else if (method === "thread/unarchive") {
      threads[params.threadId].archived = false;
      persist();
      reply({ thread: threads[params.threadId] });
    } else {
      send({ id, error: { code: -32601, message: "Fixture method not found" } });
    }
  }
}
