import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These libraries belong to configured-only providers or first-use features.
// Their code must be absent from the static emitted startup closure, even if
// a bundler would defer their initializer inside a giant startup file.
const optionalInput = /messaging\/providers\/|node_modules\/(?:discord\.js|grammy|@slack\/(?:socket-mode|web-api)|@larksuiteoapi\/node-sdk|@line\/bot-sdk|@mattermost\/client|@anthropic-ai\/claude-agent-sdk|@modelcontextprotocol\/sdk|@agentclientprotocol\/sdk|@napi-rs\/canvas|pdfjs-dist|sigstore|zod|ajv)\//;

/** Assert the daemon's own load trace at readiness, before feature requests. */
export function assertPortableStartupLoads(directory, urls) {
  const root = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(path.join(root, "chunks.json"), "utf8"));
  assert.ok(urls.includes(pathToFileURL(path.join(root, "index.js")).href), "Trace must observe the real owner entry");
  for (const url of urls) {
    assert.ok(!optionalInput.test(url.replaceAll("\\", "/")), `Daemon startup loaded optional package: ${url}`);
    if (!url.startsWith("file:")) continue;
    const file = fileURLToPath(url);
    if (path.dirname(file) !== root) continue;
    for (const input of manifest.chunks[path.basename(file)]?.inputs ?? []) {
      assert.ok(!optionalInput.test(input), `Daemon startup parsed optional code: ${input}`);
    }
  }
}

/** Run in a fresh process so both CJS and ESM module caches start empty. */
export async function checkPortableRuntime(directory) {
  const root = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(path.join(root, "chunks.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entries.index, "index.js", "The public owner entry must be the emitted ESM module");
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).type, "module");
  const closure = new Set();
  function visit(file) {
    if (closure.has(file)) return;
    assert.equal(path.basename(file), file, `Chunk escapes the runtime: ${file}`);
    const chunk = manifest.chunks[file];
    assert.ok(chunk, `Missing chunk: ${file}`);
    closure.add(file);
    for (const input of chunk.inputs) assert.ok(!optionalInput.test(input), `Optional code in startup: ${input} (${file})`);
    for (const imported of chunk.imports) visit(imported);
  }
  visit(manifest.entries.index);
  const optional = Object.entries(manifest.chunks).filter(([, chunk]) => chunk.entryPoint && optionalInput.test(chunk.entryPoint));
  for (const provider of ["discord", "telegram", "mattermost", "slack", "feishu", "line"]) {
    assert.ok(optional.some(([, chunk]) => chunk.entryPoint.includes(`messaging/providers/${provider}/`)), `Missing lazy provider: ${provider}`);
  }
  for (const sdk of ["claude-agent-sdk", "sigstore", "@modelcontextprotocol/sdk"]) {
    assert.ok(optional.some(([, chunk]) => chunk.entryPoint.includes(sdk)), `Missing lazy SDK: ${sdk}`);
  }
  const loaded = new Set();
  const hook = registerHooks({
    load(url, context, nextLoad) {
      loaded.add(url);
      const result = nextLoad(url, context);
      if (url.startsWith("file:") && path.dirname(fileURLToPath(url)) === root) {
        assert.equal(result.format, "module", `Portable runtime loaded a CommonJS wrapper: ${url}`);
      }
      return result;
    },
  });
  try {
    const require = createRequire(path.join(root, "index.js"));
    const owner = await import(pathToFileURL(path.join(root, manifest.entries.index)).href);
    assert.equal(typeof owner.startHeadlessHost, "function");
    assert.equal(typeof owner.shutdownHeadlessHost, "function");
    for (const file of closure) assert.ok(loaded.has(pathToFileURL(path.join(root, file)).href), `Startup probe missed ${file}`);
    for (const [file] of optional) assert.ok(!loaded.has(pathToFileURL(path.join(root, file)).href), `Startup loaded optional chunk: ${file}`);
    for (const url of loaded) assert.ok(!optionalInput.test(url.replaceAll("\\", "/")), `Startup loaded optional package: ${url}`);
    for (const [file] of optional) {
      const url = pathToFileURL(path.join(root, file)).href;
      const feature = await import(url);
      assert.ok(Object.keys(feature).length > 0, `First use returned no exports: ${file}`);
      const provider = manifest.chunks[file].entryPoint.match(/messaging\/providers\/([^/]+)\//)?.[1];
      if (provider) {
        const adapter = `create${provider[0].toUpperCase()}${provider.slice(1)}Adapter`;
        assert.equal(typeof feature[adapter], "function", `First use did not expose ${adapter}`);
      }
      assert.ok(loaded.has(url), `First use did not load ${file}`);
    }
    // Native and ESM-only external dependencies resolve from the installed
    // chunk, rather than the build machine. Exercise them after the lazy check.
    const canvas = require("@napi-rs/canvas").createCanvas(1, 1);
    assert.ok(canvas.toBuffer("image/png").length > 0);
    const pdf = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
    assert.equal(typeof pdf.getDocument, "function");
    assert.ok(readFileSync(require.resolve("pdfjs-dist/wasm/openjpeg.wasm")).length > 0);
    return { startupChunks: closure.size, optionalChunks: optional.length };
  } finally {
    hook.deregister();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkPortableRuntime(path.resolve(process.argv[2]))));
}
