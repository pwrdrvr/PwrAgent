#!/usr/bin/env node
// Compatibility launcher for local Responses servers with flat function tools
// and chat templates requiring exactly one leading system message.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

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
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)
    || target.username || target.password || target.search || target.hash) {
    throw new Error("Upstream must be an unauthenticated loopback HTTP URL");
  }
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
    throw new Error("Usage: codex-local-responses-bridge.mjs --codex PATH --upstream http://127.0.0.1:PORT/v1 --provider NAME -- [Codex arguments]");
  }
  const provider = value("--provider");
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) throw new Error("Invalid provider name");
  const codexArgs = args.slice(separator + 1);
  const versionOnly = codexArgs.includes("--version") || codexArgs.includes("-V");
  const server = versionOnly ? undefined : await startBridge(value("--upstream"));
  const child = spawn(value("--codex"), [
    ...codexArgs,
    ...(server ? ["-c", `model_providers.${provider}.base_url="http://127.0.0.1:${server.address().port}/v1"`] : []),
  ], { stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const [code, signal] = await once(child, "exit");
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    server?.closeAllConnections();
    server?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
