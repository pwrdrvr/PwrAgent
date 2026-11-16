#!/usr/bin/env node
// Synthetic provider oracle, not a live-provider compatibility claim.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readJsonRpcLines } from "../apps/desktop/scripts/json-rpc-lines.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startPortableCodeModeTransport } from "../apps/desktop/src/main/codex-app-server/portable-code-mode-transport.mjs";

const budgets = JSON.parse(await readFile(new URL("./fixtures/portable-discovery-budgets.json", import.meta.url), "utf8"));

export async function probePortableDiscovery({ binary, count = 100, streaming = true, malformed = false, mode = "portable", captureOnly = false }) {
  assert.ok(["portable", "direct", "unadapted"].includes(mode));
  assert.ok(Number.isInteger(count) && count >= 100 && count <= 1000);
  const home = await mkdtemp(path.join(tmpdir(), "pwragent-portable-probe-"));
  const marker = `PORTABLE_${randomUUID()}`;
  const invocationsPath = path.join(home, "invocations.jsonl");
  const fixture = path.join(home, "mcp.cjs");
  const requests = [];
  const diagnostics = [];
  let child;
  let server;
  let timeout;
  let stderr = "";
  let calls = 0;
  let searchResultBytes = 0;
  const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? "");
  const inventory = (request) => [...request.tools ?? [], ...(request.input ?? []).filter(x => x.type === "additional_tools").flatMap(x => x.tools)];
  const response = (output) => ({ id: `resp_${randomUUID()}`, object: "response", status: "completed", output });
  const message = (text) => ({ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
  const oracle = async (request) => {
    requests.push(request);
    const functions = request.tools ?? [];
    assert.ok(functions.every(tool => tool.type === "function"));
    assert.ok(!JSON.stringify(request).includes('"type":"tool_search'));
    const exec = functions.find(tool => tool.parameters?.properties?.code);
    assert.ok(exec, "ordinary JSON exec contract must be usable");
    const outputs = request.input.filter(item => item.type === "function_call_output");
    const text = JSON.stringify(outputs.at(-1)?.output ?? "");
    let source;
    if (malformed && calls === 0) source = null;
    else if (!outputs.length || (malformed && calls === 1)) {
      if (outputs.length) assert.match(text, /Invalid exec arguments/);
      source = 'text(await tools.tool_search({query: "fixture_73", limit: 5}));';
    } else if (!text.includes(marker)) {
      // Discover the callable from Codex output; never advertise or call it ourselves.
      assert.match(text, /mcp__portable__fixture_73/);
      const callable = text.match(/mcp__portable__fixture_73/)[0];
      searchResultBytes = jsonBytes(outputs.at(-1).output);
      assert.ok(searchResultBytes <= budgets.maxSearchResultBytes);
      source = `text(await tools.${callable}({value: "oracle"}));`;
    } else return response([message(marker)]);
    calls++;
    return response([{ type: "function_call", id: `fc_${randomUUID()}`, call_id: `call_${calls}`, name: exec.name,
      arguments: source === null ? '{"code":' : JSON.stringify({ code: source }), status: "completed" }]);
  };
  try {
    await writeFile(fixture, `const fs=require("node:fs"); const rl=require("node:readline").createInterface({input:process.stdin}); rl.on("line",line=>{const r=JSON.parse(line); if(!("id" in r))return; let result={}; if(r.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"portable",version:"1"}}; if(r.method==="tools/list")result={tools:Array.from({length:process.argv[2]==="inherited"?1:${count}},(_,i)=>({name:process.argv[2]==="inherited"?"disabled_fixture":"fixture_"+i,description:"Read-only synthetic service "+i+" "+"description ".repeat(20),inputSchema:{type:"object",properties:{value:{type:"string",description:"parameter ".repeat(20)}},required:["value"],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}))}; if(r.method==="tools/call"){fs.appendFileSync(${JSON.stringify(invocationsPath)},JSON.stringify(r.params)+"\\n");result={content:[{type:"text",text:${JSON.stringify(marker)}}]};} console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result}));});`);
    server = await startPortableCodeModeTransport({
      onDiagnostic: event => diagnostics.push(event),
      send: async request => {
        const value = mode === "portable" && !captureOnly ? await oracle(request) : (requests.push(request), response([message("CAPTURED")]));
        if (!streaming) return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
        const events = [{ type: "response.created", response: { ...value, status: "in_progress", output: [] } }];
        for (const [output_index, item] of value.output.entries()) {
          events.push({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : {}) } });
          if (item.type === "function_call") {
            // Split JSON escapes, Unicode and code at arbitrary transport boundaries.
            for (const delta of item.arguments) events.push({ type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta });
            events.push({ type: "response.function_call_arguments.done", output_index, item_id: item.id, arguments: item.arguments });
          }
          events.push({ type: "response.output_item.done", output_index, item });
        }
        events.push({ type: "response.completed", response: value });
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const model = {
      slug: "portable-fixture", display_name: "Portable fixture", description: "Synthetic oracle",
      default_reasoning_level: null, supported_reasoning_levels: [], shell_type: "shell_command", visibility: "list",
      supported_in_api: true, priority: 0, additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
      base_instructions: "Use the available tools.", supports_reasoning_summaries: false, supports_reasoning_summary_parameter: false,
      default_reasoning_summary: "none", support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
      truncation_policy: { mode: "tokens", limit: 10000 }, context_window: 65536, experimental_supported_tools: [], input_modalities: ["text"],
      // This is the adapter-facing contract, never raw provider metadata.
      supports_search_tool: mode === "portable", tool_mode: mode === "direct" ? "direct" : "code_mode_only",
    };
    await writeFile(path.join(home, "models.json"), JSON.stringify({ models: [model] }));
    await writeFile(path.join(home, "config.toml"), `model="portable-fixture"\nweb_search="disabled"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, "models.json"))}\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.inherited]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(fixture)},"inherited"]\n`);
    const features = { code_mode: mode !== "direct", code_mode_only: mode !== "direct", code_mode_tool_search: true };
    const overrides = ["features.apps=false", "features.goals=false", "features.multi_agent=false", "mcp_servers.inherited.enabled=false"];
    child = spawn(binary, ["app-server", ...overrides.flatMap(value => ["-c", value])], {
      cwd: home, env: { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    let id = 0;
    const pending = new Map();
    let complete;
    let fail;
    const done = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    // Initialization/RPC failure may precede awaiting the turn-completed promise.
    void done.catch(() => {});
    const failRequests = error => {
      fail(error);
      for (const [, reject] of pending.values()) reject(error);
      pending.clear();
    };
    child.on("error", failRequests);
    child.on("exit", code => failRequests(new Error(`Codex exited ${code}`)));
    const notifications = [];
    readJsonRpcLines(child.stdout, line => {
      const value = JSON.parse(line);
      if (value.id && pending.has(value.id)) {
        const [resolve, reject] = pending.get(value.id); pending.delete(value.id);
        value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result);
      } else {
        notifications.push(value);
        if (value.method === "turn/completed") complete(value.params);
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      pending.set(++id, [resolve, reject]); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    timeout = setTimeout(() => { failRequests(new Error("Codex probe timeout")); child.kill(); }, 30_000);
    await rpc("initialize", { clientInfo: { name: "portable-probe", version: "1" }, capabilities: { experimentalApi: true } });
    const start = { model: "portable-fixture", cwd: home, approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      config: { features, mcp_servers: { portable: { command: process.execPath, args: [fixture] } } } };
    const thread = await rpc("thread/start", start);
    const mcp = await rpc("mcpServerStatus/list", { threadId: thread.thread.id });
    await rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Discover fixture_73, invoke it once, and return its exact marker." }] });
    const finished = await done;
    assert.equal(finished.turn.status, "completed", JSON.stringify(finished));
    let invocations = [];
    try { invocations = (await readFile(invocationsPath, "utf8")).trim().split("\n").map(JSON.parse); } catch { /* Capture-only controls do not invoke tools. */ }
    if (mode === "portable" && !captureOnly) {
      assert.equal(invocations.length, 1, "selected fixture executes exactly once");
      assert.equal(invocations[0].name, "fixture_73");
      const final = notifications.filter(x => x.method === "item/completed").map(x => x.params.item).findLast(x => x.type === "agentMessage");
      assert.equal(final?.text, marker, "exact marker must reach the final agent message");
    }
    if (mode === "portable") {
      const first = requests[0];
      const exec = first.tools.find(tool => tool.parameters?.properties?.code);
      assert.ok(jsonBytes(exec) <= budgets.maxExecDefinitionBytes);
      assert.ok(first.tools.length <= budgets.maxInitialPortableTools);
      assert.ok(!first.tools.some(tool => tool.description?.startsWith("Read-only synthetic service")));
      assert.ok(!JSON.stringify(first).includes("Read-only synthetic service"), "no catalog hidden in instructions/history");
      assert.equal((JSON.stringify(first).match(/fixture_\d+/g) ?? []).length, 1, "only the task prompt names a fixture initially");
    }
    return {
      mode, count, streaming, malformed, binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
      adapterSha256: createHash("sha256").update(await readFile(new URL("../apps/desktop/src/main/codex-app-server/portable-code-mode-transport.mjs", import.meta.url))).digest("hex"),
      nativeProviderSearch: false, adapterDiscovery: mode === "portable", fullSequence: mode === "portable" && !captureOnly, invocationCount: invocations.length,
      modelMetadata: model, searchResultBytes,
      processOverrides: overrides, threadStart: { ...start, cwd: "[temporary home]", config: { features, mcp_servers: { portable: "[task-owned read-only fixture]" } } },
      inheritedMcpEnabled: JSON.stringify(mcp).includes("disabled_fixture"),
      requests: requests.map(request => {
        const tools = inventory(request).flatMap(tool => tool.tools ?? [tool]);
        const execBytes = jsonBytes(tools.find(tool => tool.parameters?.properties?.code));
        return { execBytes, coreToolBytes: jsonBytes(tools) - execBytes, totalBytes: jsonBytes(request), toolsBytes: jsonBytes(tools),
          thirdPartyDefinitionBytes: tools.filter(tool => tool.description?.startsWith("Read-only synthetic service")).reduce((sum, tool) => sum + jsonBytes(tool), 0),
          inputBytes: jsonBytes(request.input), instructionsBytes: jsonBytes(request.instructions), toolCount: tools.length,
          fixtureMentions: (JSON.stringify(request).match(/fixture_\d+/g) ?? []).length };
      }),
      diagnostics,
    };
  } catch (error) { throw new Error(`${error.message}\n${stderr}`); }
  finally {
    clearTimeout(timeout);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}

export async function probePortableMatrix(binary) {
  const records = [];
  for (const count of budgets.inventories) {
    records.push(await probePortableDiscovery({ binary, count, mode: "direct", captureOnly: true }));
    for (const streaming of [false, true]) records.push(await probePortableDiscovery({ binary, count, streaming }));
  }
  records.push(await probePortableDiscovery({ binary, mode: "unadapted", captureOnly: true }));
  for (const streaming of [false, true]) records.push(await probePortableDiscovery({ binary, streaming, malformed: true }));
  const portable = records.filter(record => record.mode === "portable");
  assert.equal(new Set(portable.map(record => record.requests[0].execBytes)).size, 1, "discovery bootstrap must not scale with inventory");
  assert.equal(new Set(portable.map(record => record.requests[0].toolsBytes)).size, 1);
  assert.equal(new Set(records.map(record => record.requests[0].inputBytes)).size, 1, "core instructions and initial history must remain identical in size");
  const direct = records.find(record => record.count === 1000 && record.mode === "direct");
  const large = portable.find(record => record.count === 1000);
  assert.ok(large.requests[0].toolsBytes / direct.requests[0].toolsBytes <= budgets.maxLargeFixtureToolBytesRatio);
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--matrix") {
    if (!process.argv[3]) throw new Error("--matrix requires a Codex executable");
    console.log(JSON.stringify(await probePortableMatrix(process.argv[3]), null, 2));
  } else {
    const [binary, count, transport = "streaming", mode = "portable", malformed] = process.argv.slice(2);
    if (!binary) throw new Error("Usage: probe-codex-portable-discovery.mjs CODEX [100..1000] [streaming|buffered] [portable|direct|unadapted] [malformed]");
    console.log(JSON.stringify(await probePortableDiscovery({ binary, count: count ? Number(count) : 100, streaming: transport === "streaming", mode, malformed: malformed === "malformed", captureOnly: malformed === "capture" }), null, 2));
  }
}
