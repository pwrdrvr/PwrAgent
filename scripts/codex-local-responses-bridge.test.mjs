import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { onTestFinished, test } from "vitest";
import { discoverModelCatalog, startBridge, translateRequest, translateResponse } from "./codex-local-responses-bridge.mjs";

const execFileAsync = promisify(execFile);
const bridgePath = fileURLToPath(new URL("./codex-local-responses-bridge.mjs", import.meta.url));
const catalogTemplate = {
  models: [{ slug: "bonsai", display_name: "Bonsai", input_modalities: ["text"], supported_reasoning_levels: [], apply_patch_tool_type: null }],
};

async function metadataServer(options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (options.redirect) {
      res.writeHead(302, { Location: options.redirect }).end();
      return;
    }
    res.writeHead(options.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/models"
      ? options.models ?? { data: [{ id: "bonsai" }] }
      : options.props ?? { model_alias: "bonsai", modalities: { vision: true } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  return { upstream: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test("discovers vision while preserving catalog instructions and tool settings", async () => {
  const { upstream } = await metadataServer();
  const result = await discoverModelCatalog(upstream, catalogTemplate);
  assert.deepEqual(result.models[0], { ...catalogTemplate.models[0], input_modalities: ["text", "image"] });
  assert.deepEqual(catalogTemplate.models[0].input_modalities, ["text"]);
});

test("removes stale image support when the loaded server is text-only", async () => {
  const { upstream } = await metadataServer({ props: { model_alias: "bonsai", modalities: { vision: false } } });
  const result = await discoverModelCatalog(upstream, { models: [{ ...catalogTemplate.models[0], input_modalities: ["text", "image"] }] });
  assert.deepEqual(result.models[0].input_modalities, ["text"]);
});

test.each([
  { options: { props: { model_alias: "other", modalities: { vision: true } } }, error: /does not match/ },
  { options: { models: { data: [{ id: "other" }] } }, error: /does not match/ },
  { options: { models: { data: {} } }, error: /does not match/ },
  { options: { props: { model_alias: "bonsai", modalities: { audio: true } } }, error: /vision capability/ },
  { options: { status: 503 }, error: /HTTP 503/ },
])("rejects missing or mismatched discovery metadata: $options", async ({ options, error }) => {
  const { upstream } = await metadataServer(options);
  await assert.rejects(discoverModelCatalog(upstream, catalogTemplate), error);
});

test("discovery rejects remote upstreams and does not follow metadata redirects", async () => {
  await assert.rejects(discoverModelCatalog("http://example.com/v1", catalogTemplate), /loopback/);
  const destination = await metadataServer();
  const source = await metadataServer({ redirect: `${destination.upstream}/models` });
  await assert.rejects(discoverModelCatalog(source.upstream, catalogTemplate), /fetch failed/);
  assert.deepEqual(destination.requests, []);
});

test("launcher supplies a private discovered catalog and removes it after Codex exits", async () => {
  const { upstream } = await metadataServer();
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-catalog-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const template = path.join(root, "template.json");
  const child = path.join(root, "fixture.cjs");
  await writeFile(template, JSON.stringify(catalogTemplate));
  await writeFile(child, `
    const fs = require("node:fs");
    const arg = process.argv.find((value) => value.startsWith("model_catalog_json="));
    const path = JSON.parse(arg.slice("model_catalog_json=".length));
    console.log(JSON.stringify({ path, catalog: JSON.parse(fs.readFileSync(path, "utf8")) }));
  `);
  const { stdout } = await execFileAsync(process.execPath, [
    bridgePath, "--codex", process.execPath, "--upstream", upstream, "--provider", "local",
    "--model-catalog", template, "--", child,
  ]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.catalog.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(JSON.parse(await readFile(template, "utf8")), catalogTemplate);
  await assert.rejects(stat(path.dirname(result.path)), { code: "ENOENT" });
});

test("version probes work without contacting the model or reading the catalog", async () => {
  const { upstream, requests } = await metadataServer({ status: 503 });
  const { stdout } = await execFileAsync(process.execPath, [
    bridgePath, "--codex", process.execPath, "--upstream", upstream, "--provider", "local",
    "--model-catalog", "missing-template.json", "--", "--version",
  ]);
  assert.equal(stdout.trim(), process.version);
  assert.deepEqual(requests, []);
});

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

test("preserves image inputs and their text prompt", () => {
  const message = { role: "user", content: [
    { type: "input_text", text: "Describe this image" },
    { type: "input_image", image_url: "data:image/png;base64,fixture", detail: "auto" },
  ] };
  assert.deepEqual(translateRequest({ input: [message] }).body.input, [message]);
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
