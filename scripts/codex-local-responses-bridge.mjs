#!/usr/bin/env node
// Compatibility launcher for local Responses servers with flat function tools
// and chat templates requiring exactly one leading system message.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function loopbackUpstream(upstream) {
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)
    || target.username || target.password || target.search || target.hash) {
    throw new Error("Upstream must be an unauthenticated loopback HTTP URL");
  }
  return target;
}

async function readMetadata(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (!response.ok) throw new Error(`Local model metadata ${url.pathname}: HTTP ${response.status}`);
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Local model metadata exceeds 1 MiB");
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export async function discoverModelCatalog(upstream, template) {
  const target = loopbackUpstream(upstream);
  const base = target.href.replace(/\/$/, "");
  if (!target.pathname.replace(/\/$/, "").endsWith("/v1")) {
    throw new Error("Local model discovery requires a /v1 upstream");
  }
  if (!Array.isArray(template?.models) || template.models.length !== 1
    || typeof template.models[0]?.slug !== "string" || !template.models[0].slug) {
    throw new Error("Local model discovery requires a single-model catalog template");
  }
  const [models, props] = await Promise.all([
    readMetadata(new URL(`${base}/models`)),
    readMetadata(new URL(`${base.slice(0, -3)}/props`)),
  ]);
  const model = template.models[0];
  const advertised = Array.isArray(models?.data)
    && models.data.some((entry) => entry?.id === model.slug);
  if (!advertised || ![props?.model_alias, props?.model_path].includes(model.slug)) {
    throw new Error("Local model metadata does not match the catalog model");
  }
  if (typeof props?.modalities?.vision !== "boolean") {
    throw new Error("Local model metadata does not declare a vision capability");
  }
  return {
    ...template,
    models: [{ ...model, input_modalities: props.modalities.vision ? ["text", "image"] : ["text"] }],
  };
}

function flatName(namespace, name) {
  if (!namespace) return name;
  const digest = createHash("sha256").update(JSON.stringify([namespace, name])).digest("hex");
  return `ns_${digest.slice(0, 24)}_${name.slice(0, 36)}`;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((part) => !["input_text", "text"].includes(part.type))) {
    throw new Error("Local model system instructions must contain only text");
  }
  return content.map((part) => part.text).join("\n");
}

export function translateRequest(request) {
  const names = new Map();
  const tools = [];
  const addFunction = (tool, namespace) => {
    if (tool.type !== "function") {
      throw new Error(`Local Responses bridge does not support tool type ${tool.type}`);
    }
    const name = flatName(namespace, tool.name);
    if (names.has(name)) throw new Error(`Duplicate local tool name: ${name}`);
    names.set(name, { name: tool.name, ...(namespace ? { namespace } : {}) });
    tools.push({ ...tool, name });
  };
  for (const tool of request.tools ?? []) {
    if (tool.type === "namespace") {
      for (const nested of tool.tools) addFunction(nested, tool.name);
    } else {
      addFunction(tool);
    }
  }
  const instructions = request.instructions ? [request.instructions] : [];
  const input = [];
  for (const item of typeof request.input === "string"
    ? [{ role: "user", content: request.input }]
    : request.input ?? []) {
    if (["system", "developer"].includes(item.role)) {
      instructions.push(textContent(item.content));
    } else if (item.type === "function_call") {
      const { namespace, ...call } = item;
      input.push({ ...call, name: flatName(namespace, item.name) });
    } else {
      input.push(item);
    }
  }
  const body = { ...request, tools, input: [
    ...(instructions.length ? [{ role: "system", content: instructions.join("\n\n") }] : []),
    ...input,
  ] };
  delete body.instructions;
  if (body.tool_choice?.type === "function") {
    const { namespace, ...choice } = body.tool_choice;
    body.tool_choice = { ...choice, name: flatName(namespace, choice.name) };
  }
  return { body, names };
}

export function translateResponse(value, names) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => translateResponse(item, names));
  // Only protocol output items carry tool identities; never rewrite tool arguments.
  if (value.type === "function_call" && names.has(value.name)) {
    return { ...value, ...names.get(value.name) };
  }
  const result = { ...value };
  for (const key of ["item", "response", "output"]) {
    if (key in result) result[key] = translateResponse(result[key], names);
  }
  return result;
}

export async function startBridge(upstream) {
  const target = loopbackUpstream(upstream);
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new Error("Request exceeds 16 MiB");
        chunks.push(chunk);
      }
      const { body, names } = translateRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const response = await fetch(`${target.href.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const contentType = response.headers.get("content-type") ?? "application/json";
      res.writeHead(response.status, { "Content-Type": contentType, "Cache-Control": "no-cache" });
      if (!contentType.includes("text/event-stream")) {
        const text = await response.text();
        try { res.end(JSON.stringify(translateResponse(JSON.parse(text), names))); }
        catch { res.end(text); }
        return;
      }
      const decoder = new TextDecoder();
      let pending = "";
      const writeLine = async (line) => {
        if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
          line = `data: ${JSON.stringify(translateResponse(JSON.parse(line.slice(5)), names))}`;
        }
        if (!res.write(`${line}\n`)) await once(res, "drain", { signal: abort.signal });
      };
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n")) >= 0) {
          await writeLine(pending.slice(0, boundary));
          pending = pending.slice(boundary + 1);
        }
      }
      pending += decoder.decode();
      if (pending) await writeLine(pending);
      res.end();
    } catch (error) {
      if (abort.signal.aborted) return;
      if (res.headersSent) res.destroy(error);
      else res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
        error: { message: error.message, type: "local_responses_bridge_error" },
      }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function main(args) {
  const separator = args.indexOf("--");
  const options = args.slice(0, separator);
  const value = (flag) => options[options.indexOf(flag) + 1];
  if (separator < 0 || !["--codex", "--upstream", "--provider"].every((flag) => options.includes(flag))) {
    throw new Error("Usage: codex-local-responses-bridge.mjs --codex PATH --upstream http://127.0.0.1:PORT/v1 --provider NAME [--model-catalog TEMPLATE] -- [Codex arguments]");
  }
  const provider = value("--provider");
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) throw new Error("Invalid provider name");
  const codexArgs = args.slice(separator + 1);
  const versionOnly = codexArgs.includes("--version") || codexArgs.includes("-V");
  let server;
  let catalogDirectory;
  let child;
  const forward = (signal) => child?.kill(signal);
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  try {
    const overrides = [];
    if (!versionOnly) {
      if (options.includes("--model-catalog")) {
        const template = JSON.parse(await readFile(value("--model-catalog"), "utf8"));
        const catalog = await discoverModelCatalog(value("--upstream"), template);
        catalogDirectory = await mkdtemp(path.join(tmpdir(), "pwragent-local-models-"));
        const catalogPath = path.join(catalogDirectory, "models.json");
        await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
        overrides.push("-c", `model_catalog_json=${JSON.stringify(catalogPath)}`);
      }
      server = await startBridge(value("--upstream"));
      overrides.push("-c", `model_providers.${provider}.base_url="http://127.0.0.1:${server.address().port}/v1"`);
    }
    child = spawn(value("--codex"), [...codexArgs, ...overrides], { stdio: "inherit" });
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const [code, signal] = await once(child, "exit");
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    server?.closeAllConnections();
    server?.close();
    if (catalogDirectory) await rm(catalogDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
