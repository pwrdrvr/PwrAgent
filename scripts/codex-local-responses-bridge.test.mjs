import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { onTestFinished, test } from "vitest";
import { startBridge, translateRequest, translateResponse } from "./codex-local-responses-bridge.mjs";

const tool = { type: "function", name: "read", parameters: { type: "object" } };
const request = {
  model: "local-model",
  instructions: "Base instructions",
  input: [
    { role: "developer", content: [{ type: "input_text", text: "Developer instructions" }] },
    { role: "user", content: "Hello" },
    { role: "developer", content: "Later instructions" },
    { type: "function_call", namespace: "files", name: "read", arguments: "{}", call_id: "call-1" },
    { type: "function_call_output", call_id: "call-1", output: "done" },
  ],
  tools: [tool, { type: "namespace", name: "files", tools: [tool] }],
};

test("merges ordered instructions and round-trips namespaced tool history", () => {
  const { body, names } = translateRequest(request);
  assert.equal(body.instructions, undefined);
  assert.equal(body.input[0].role, "system");
  assert.equal(body.input[0].content, "Base instructions\n\nDeveloper instructions\n\nLater instructions");
  assert.equal(body.input[1].content, "Hello");
  assert.equal(body.tools[0].name, "read");
  assert.notEqual(body.tools[1].name, "read");
  assert.equal(body.input[2].name, body.tools[1].name);
  assert.equal(body.input[2].namespace, undefined);
  assert.deepEqual(body.input[3], request.input[4]);
  const item = { type: "function_call", name: body.tools[1].name, call_id: "call-2", arguments: '{"name":"read"}' };
  const restored = translateResponse({ type: "response.output_item.done", item }, names).item;
  assert.equal(restored.name, "read");
  assert.equal(restored.namespace, "files");
  assert.equal(restored.arguments, item.arguments);
  assert.deepEqual(translateResponse({ response: { output: [item] } }, names).response.output[0], restored);
  assert.equal(translateRequest(request).body.tools[1].name, body.tools[1].name);
});

test("fails explicitly for unsupported tools instead of silently discarding them", () => {
  assert.throws(() => translateRequest({ tools: [{ type: "custom", name: "patch" }] }), /does not support tool type custom/);
  assert.throws(() => translateRequest({ tools: [tool, tool] }), /Duplicate/);
});

test("requires a loopback upstream without credentials", async () => {
  await assert.rejects(startBridge("http://example.com/v1"), /loopback/);
  await assert.rejects(startBridge("http://user:secret@127.0.0.1/v1"), /loopback/);
});

test("streams fragmented SSE and restores tool namespaces", async () => {
  let received;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.url, "/v1/responses");
    const item = { type: "function_call", name: received.tools[1].name, arguments: "{}", call_id: "c1" };
    const sse = `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: [DONE]\n\n`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let i = 0; i < sse.length; i += 7) res.write(sse.slice(i, i + 7));
    res.end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  onTestFinished(() => { upstream.closeAllConnections(); upstream.close(); });
  const bridge = await startBridge(`http://127.0.0.1:${upstream.address().port}/v1`);
  onTestFinished(() => { bridge.closeAllConnections(); bridge.close(); });
  const response = await fetch(`http://127.0.0.1:${bridge.address().port}/v1/responses`, {
    method: "POST", body: JSON.stringify({ ...request, stream: true }),
  });
  assert.equal(response.status, 200);
  const sse = await response.text();
  const data = JSON.parse(sse.split("\n").find((line) => line.startsWith("data: {")).slice(6));
  assert.equal(data.item.name, "read");
  assert.equal(data.item.namespace, "files");
  assert.match(sse, /data: \[DONE\]/);
  assert.equal(received.input[0].role, "system");
});
