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
import {
  DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
  discoverModelCatalog,
  startBridge,
  translateRequest,
  translateResponse,
} from "./codex-local-responses-bridge.mjs";

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

test("authenticates metadata and response forwarding with the configured credential", async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push([req.url, req.headers.authorization]);
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/responses") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(request.input[0].role, "system");
      res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }));
    } else {
      res.end(JSON.stringify(req.url === "/v1/models"
        ? { data: [{ id: "bonsai" }] }
        : { model_alias: "bonsai", modalities: { vision: false } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  const upstream = `http://127.0.0.1:${server.address().port}/v1`;
  await assert.rejects(discoverModelCatalog(upstream, catalogTemplate), /HTTP 401/);
  const catalog = await discoverModelCatalog(upstream, catalogTemplate, "fixture-key");
  assert.deepEqual(catalog.models[0].input_modalities, ["text"]);
  const bridge = await startBridge(upstream, "fixture-key");
  onTestFinished(() => { bridge.closeAllConnections(); bridge.close(); });
  const response = await fetch(`http://127.0.0.1:${bridge.address().port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: "Bearer unrelated-client-key" },
    body: JSON.stringify({ instructions: "Reply OK", input: [{ role: "developer", content: "Use one system message" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output[0].content[0].text, "OK");
  for (const endpoint of ["/v1/models", "/props", "/v1/responses"]) {
    assert.ok(seen.some(([url, authorization]) => url === endpoint && authorization === "Bearer fixture-key"));
  }
  assert.ok(!seen.some(([, authorization]) => authorization === "Bearer unrelated-client-key"));
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
    const idle = process.argv.filter((value) => value.includes("stream_idle_timeout_ms"));
    console.log(JSON.stringify({ path, idle, catalog: JSON.parse(fs.readFileSync(path, "utf8")) }));
  `);
  const { stdout } = await execFileAsync(process.execPath, [
    bridgePath, "--codex", process.execPath, "--upstream", upstream, "--provider", "local",
    "--model-catalog", template, "--", child,
  ]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.idle, [`model_providers.local.stream_idle_timeout_ms=${DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS}`]);
  assert.deepEqual(result.catalog.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(JSON.parse(await readFile(template, "utf8")), catalogTemplate);
  await assert.rejects(stat(path.dirname(result.path)), { code: "ENOENT" });
});

test("launcher gives Codex and the bridge one configured stream idle timeout", async () => {
  const { upstream } = await metadataServer();
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-idle-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const child = path.join(root, "fixture.cjs");
  await writeFile(child, `
    console.log(JSON.stringify(process.argv.filter((value) => value.includes("stream_idle_timeout_ms"))));
  `);
  const args = (timeout) => [
    bridgePath, "--codex", process.execPath, "--upstream", upstream, "--provider", "local",
    "--stream-idle-timeout-ms", timeout, "--", child,
  ];
  const { stdout } = await execFileAsync(process.execPath, args("1200000"));
  assert.deepEqual(JSON.parse(stdout), ["model_providers.local.stream_idle_timeout_ms=1200000"]);
  await assert.rejects(execFileAsync(process.execPath, args("soon")), (error) => {
    assert.match(error.stderr, /idle timeout/);
    assert.equal(error.stdout, "");
    return true;
  });
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

/** Stays silent for `beforeHeadersMs` before headers and `midStreamMs` after the first event. */
async function silentUpstream({ beforeHeadersMs = 0, midStreamMs = 0 }) {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req);
    await new Promise((resolve) => setTimeout(resolve, beforeHeadersMs));
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.created" })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, midStreamMs));
    if (res.destroyed) return;
    res.end(`data: ${JSON.stringify({ type: "response.completed" })}\n\ndata: [DONE]\n\n`);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  onTestFinished(() => { upstream.closeAllConnections(); upstream.close(); });
  return `http://127.0.0.1:${upstream.address().port}/v1`;
}

async function bridgeFor(upstream, idleTimeoutMs) {
  const bridge = await startBridge(upstream, undefined, { idleTimeoutMs });
  onTestFinished(() => { bridge.closeAllConnections(); bridge.close(); });
  return (body = { input: [], stream: true }) => fetch(`http://127.0.0.1:${bridge.address().port}/v1/responses`, {
    method: "POST", body: JSON.stringify(body),
  });
}

test("waits far longer than undici's 300 s fetch default on a silent upstream, but not forever", () => {
  assert.equal(DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS, 15 * 60_000);
});

test.each([
  { phase: "before headers", gap: { beforeHeadersMs: 400 } },
  { phase: "mid-stream", gap: { midStreamMs: 400 } },
])("streams through a silent prefill shorter than the idle timeout: $phase", async ({ gap }) => {
  const post = await bridgeFor(await silentUpstream(gap), 5_000);
  const response = await post();
  assert.equal(response.status, 200);
  const sse = await response.text();
  assert.match(sse, /response\.created/);
  assert.match(sse, /response\.completed/);
  assert.match(sse, /data: \[DONE\]/);
});

test("answers 504 when the upstream stays silent past the idle timeout before headers", async () => {
  const post = await bridgeFor(await silentUpstream({ beforeHeadersMs: 400 }), 100);
  const response = await post();
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: { message: "Local model sent nothing for 100 ms", type: "local_responses_bridge_error" },
  });
});

test("drops the stream when the upstream goes silent past the idle timeout mid-stream", async () => {
  // The timeout covers the whole socket, so leave room for headers under load.
  const post = await bridgeFor(await silentUpstream({ midStreamMs: 3_000 }), 1_000);
  const response = await post();
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});

test("rejects an unusable idle timeout and does not follow upstream redirects", async () => {
  for (const idleTimeoutMs of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31]) {
    await assert.rejects(startBridge("http://127.0.0.1:9/v1", undefined, { idleTimeoutMs }), /idle timeout/);
  }
  const destination = await metadataServer();
  const source = await metadataServer({ redirect: `${destination.upstream}/responses` });
  const response = await (await bridgeFor(source.upstream, 5_000))({ input: [] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /redirected/);
  assert.deepEqual(destination.requests, []);
});
