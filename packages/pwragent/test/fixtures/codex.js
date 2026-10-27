#!/usr/bin/env node
// A protocol fixture, not a model/provider. All state is test-owned.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
const records = path.join(directory, "fixture-threads.json");
let threads;
try { threads = JSON.parse(readFileSync(records, "utf8")); } catch { threads = {}; }
const persist = () => writeFileSync(records, JSON.stringify(threads));
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
  if (!method) continue;
  const reply = (result) => send({ id, result });
  if (method === "initialize") {
    assert.equal(initialized, false);
    assert.equal(params.capabilities.experimentalApi, false);
    initialized = true;
    reply({ userAgent: "fixture-codex/0.159.2" });
  } else if (method === "initialized") {
    assert.ok(initialized);
    acknowledged = true;
  } else {
    assert.ok(acknowledged);
    if (method === "model/list") {
      reply({ data: [{ id: "fixture-model", displayName: "Fixture model", isDefault: true, supportedReasoningEfforts: [] }] });
    } else if (method === "thread/start" || method === "thread/resume") {
      assert.equal(params.approvalPolicy, "never");
      assert.ok(["read-only", "workspace-write"].includes(params.sandbox));
      assert.equal(params.cwd, process.cwd());
      const threadId = params.threadId || `thread-${Date.now()}-${++sequence}`;
      if (method === "thread/resume") {
        assert.ok(threads[threadId]);
        if (!threads[threadId].turns.length) {
          send({ id, error: { code: -32600, message: `no rollout found for thread id ${threadId}` } });
          continue;
        }
      }
      threads[threadId] ||= { id: threadId, turns: [] };
      persist();
      reply({ thread: threads[threadId] });
    } else if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandboxPolicy.networkAccess, false);
      assert.equal(params.cwd, process.cwd());
      const prompt = params.input[0].text;
      active = { id: `turn-${++sequence}`, threadId: params.threadId };
      const initial = { turn: { id: active.id, status: "inProgress", items: [], error: null } };
      if (prompt === "early") { complete("completed"); reply(initial); continue; }
      reply(initial);
      if (prompt === "crash") { setTimeout(() => process.exit(7), 30); continue; }
      if (prompt === "descendant") {
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(()=>{},1000)", path.join(directory, "descendant.ready")], { stdio: "ignore" });
        writeFileSync(path.join(directory, "descendant.pid"), String(child.pid));
      }
      if (prompt === "approval" || prompt === "question") {
        send({ id: "server-request", method: prompt === "approval" ? "item/commandExecution/requestApproval" : "item/tool/requestUserInput",
          params: { threadId: params.threadId, turnId: active.id } });
      }
      active.timer = setTimeout(() => {
        writeFileSync(path.join(process.cwd(), "fixture-result.txt"), prompt);
        complete(prompt === "fail" ? "failed" : "completed");
      }, ["slow", "descendant", "approval", "question"].includes(prompt) ? 30000 : 100);
    } else if (method === "turn/steer") {
      assert.equal(params.expectedTurnId, active.id);
      reply({ turnId: active.id });
    } else if (method === "turn/interrupt") {
      assert.equal(params.threadId, active.threadId);
      assert.equal(params.turnId, active.id);
      complete("interrupted");
      reply({});
    } else if (method === "thread/read") {
      assert.equal(params.includeTurns, true);
      reply({ thread: threads[params.threadId] });
    } else {
      send({ id, error: { code: -32601, message: "Fixture method not found" } });
    }
  }
}
