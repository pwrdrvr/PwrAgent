import assert from "node:assert/strict";
import { once } from "node:events";
import fc from "fast-check";
import { test } from "vitest";
import { startPortableCodeModeTransport, translateCodeModeRequest } from "../apps/desktop/src/main/codex-app-server/portable-code-mode-transport.mjs";

const exec = { type: "custom", name: "exec", description: "Run existing Codex Code Mode", format: { type: "grammar", syntax: "lark", definition: "SOURCE" } };
const spec = { type: "namespace", name: "functions", tools: [exec] };
const call = (name, args, call_id = "selected") => ({ type: "function_call", id: "fc_1", name, call_id, arguments: args });

// Rule: code and call identity survive ordinary JSON transport byte-for-byte.
test("arbitrary code and namespaced call identities round-trip without evaluation", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (code, callId) => {
    const request = { input: [{ type: "additional_tools", role: "developer", tools: [spec] },
      { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: callId, input: code }] };
    const { body, translateResponse } = translateCodeModeRequest(request);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, "function");
    assert.equal(JSON.parse(body.input[0].arguments).code, code);
    const original = translateResponse(call(body.tools[0].name, JSON.stringify({ code }), callId));
    assert.equal(original.input, code);
    assert.equal(original.call_id, callId);
    assert.equal(original.namespace, "functions");
    assert.equal(original.name, "exec");
    assert.equal(original.type, "custom_tool_call");
    assert.equal(body.input.some(x => x.type === "additional_tools"), false);
  }));
});

// Rule: each canonical (namespace, name) has a stable distinct upstream identity.
test("inventory permutations preserve identities and never merge distinct namespaces", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.tuple(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/), fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/)), {
    minLength: 2, maxLength: 25, size: "max", selector: JSON.stringify,
  }), entries => {
    const specs = entries.map(([namespace, name]) => ({ type: "namespace", name: namespace,
      tools: [{ type: "function", name, parameters: { type: "object" } }] }));
    const first = translateCodeModeRequest({ tools: specs });
    const second = translateCodeModeRequest({ tools: [...specs].reverse() });
    assert.deepEqual(first.body.tools.map(x => x.name).sort(), second.body.tools.map(x => x.name).sort());
    assert.equal(new Set(first.body.tools.map(x => x.name)).size, entries.length);
    first.body.tools.forEach((tool, i) => {
      const result = first.translateResponse(call(tool.name, "{}"));
      assert.equal(result.namespace, entries[i][0]);
      assert.equal(result.name, entries[i][1]);
    });
  }));
});

test("duplicate snapshots select the latest schema and preserve image results", () => {
  const output = [{ type: "input_image", image_url: "data:image/png;base64,fixture" }, { type: "input_text", text: "fixture" }];
  const { body } = translateCodeModeRequest({ input: [
    { type: "additional_tools", tools: [spec] }, { type: "additional_tools", tools: [spec] },
    { type: "custom_tool_call_output", call_id: "a", output },
  ] });
  assert.equal(body.tools.length, 1);
  assert.deepEqual(body.input, [{ type: "function_call_output", call_id: "a", output }]);
  const old = { type: "function", name: "wait", parameters: { revision: 1 } };
  const latest = { ...old, parameters: { revision: 2 } };
  const snapshots = translateCodeModeRequest({ input: [
    { type: "additional_tools", tools: [old] }, { type: "additional_tools", tools: [latest] },
  ] });
  assert.deepEqual(snapshots.body.tools[0].parameters, latest.parameters);
});

test("invalid JSON and wrong code shapes return recoverable Codex execution feedback", () => {
  fc.assert(fc.property(fc.jsonValue(), value => {
    fc.pre(!value || typeof value.code !== "string" || Object.keys(value).length !== 1);
    const { body, translateResponse } = translateCodeModeRequest({ tools: [spec] });
    const result = translateResponse(call(body.tools[0].name, JSON.stringify(value)));
    assert.match(result.input, /^throw new Error\("Invalid exec arguments:/);
    assert.equal(result.call_id, "selected");
  }));
  const { body, translateResponse } = translateCodeModeRequest({ tools: [spec] });
  assert.match(translateResponse(call(body.tools[0].name, '{"code":')).input, /Retry the call/);
});

test("streaming JSON fragments are held until the complete original code can be recovered", () => {
  fc.assert(fc.property(fc.string(), code => {
    const { body, translateEvent } = translateCodeModeRequest({ tools: [spec] });
    const item = call(body.tools[0].name, JSON.stringify({ code }));
    const added = translateEvent({ type: "response.output_item.added", output_index: 7, item: { ...item, arguments: "" } });
    assert.equal(added.item.type, "custom_tool_call");
    assert.equal(added.item.input, "");
    for (const delta of item.arguments) assert.equal(translateEvent({ type: "response.function_call_arguments.delta", output_index: 7, delta }), null);
    const done = translateEvent({ type: "response.output_item.done", output_index: 7, item });
    assert.equal(done.item.input, code);
    assert.equal(done.output_index, 7);
  }));
});

test("rejects native search, deferred schemas and implicit remote history", () => {
  assert.throws(() => translateCodeModeRequest({ tools: [{ type: "tool_search" }] }), /does not support/);
  assert.throws(() => translateCodeModeRequest({ input: [{ type: "tool_search_output" }] }), /nested search/);
  assert.throws(() => translateCodeModeRequest({ tools: [{ type: "function", name: "hidden", defer_loading: true }] }), /nested discovery/);
  assert.throws(() => translateCodeModeRequest({ previous_response_id: "resp_old" }), /explicit Responses history/);
  assert.throws(() => translateCodeModeRequest({ input: [{ type: "item_reference", id: "old" }] }), /explicit Responses history/);
});

test("each transport request sends once, preserves Responses instructions, and hides upstream errors", async () => {
  let sends = 0;
  const server = await startPortableCodeModeTransport({ send: async body => {
    sends++;
    assert.equal(body.instructions, "Keep Responses instructions");
    return new Response("private upstream diagnostic", { status: 503 });
  } });
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: "POST", body: JSON.stringify({ instructions: "Keep Responses instructions", tools: [spec] }),
    });
    assert.equal(result.status, 503);
    assert.equal(sends, 1);
    assert.ok(!(await result.text()).includes("private upstream diagnostic"));
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});

test("buffered Responses clients receive the complete original custom call", async () => {
  const server = await startPortableCodeModeTransport({ send: async body => new Response(JSON.stringify({
    id: "resp_1", status: "completed", output: [call(body.tools[0].name, JSON.stringify({ code: 'text("雪\\n☃");' }))],
  }), { headers: { "Content-Type": "application/json" } }) });
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: "POST", body: JSON.stringify({ stream: false, tools: [spec] }),
    });
    assert.equal(result.status, 200);
    const value = await result.json();
    assert.equal(value.output[0].input, 'text("雪\\n☃");');
    assert.equal(value.output[0].namespace, "functions");
    assert.equal(value.output[0].call_id, "selected");
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});

test("SSE decoding tolerates UTF-8 and CRLF split across arbitrary byte chunks", async () => {
  const code = 'text("雪\\n☃");';
  const server = await startPortableCodeModeTransport({ send: async body => {
    const item = call(body.tools[0].name, JSON.stringify({ code }));
    const wire = Buffer.from([
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item },
    ].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: "POST", body: JSON.stringify({ stream: true, tools: [spec] }),
    });
    const events = (await result.text()).trim().split("\n\n").map(frame => JSON.parse(frame.slice(6)));
    assert.equal(events.at(-1).item.input, code);
    assert.equal(events.at(-1).item.call_id, "selected");
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});

test("client cancellation reaches the owning request signal without a retry", async () => {
  let sent;
  let canceled;
  const started = new Promise(resolve => { sent = resolve; });
  const stopped = new Promise(resolve => { canceled = resolve; });
  let sends = 0;
  const server = await startPortableCodeModeTransport({ send: async (_body, signal) => {
    sends++; sent();
    await new Promise((_, reject) => signal.addEventListener("abort", () => { canceled(); reject(new Error("canceled")); }, { once: true }));
  } });
  const controller = new AbortController();
  try {
    const pending = fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: "POST", body: JSON.stringify({ tools: [spec] }), signal: controller.signal,
    });
    await started; controller.abort();
    await assert.rejects(pending);
    await stopped;
    assert.equal(sends, 1);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});
