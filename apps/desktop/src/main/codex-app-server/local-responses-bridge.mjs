import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";

/**
 * How long the bridge waits on a silent upstream socket. llama-server sends
 * nothing while it processes an uncached prompt, which can take minutes deep
 * into a long context. Codex's own `stream_idle_timeout_ms` should match.
 */
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 15 * 60_000;

class UpstreamIdleTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Local model sent nothing for ${timeoutMs} ms`);
    this.status = 504;
  }
}

/**
 * POST without `fetch`: undici's default dispatcher ends a response after
 * 300 s without headers or body bytes. Node's HTTP client has no response
 * deadline, so the socket idle timer below is the only one.
 */
function postUpstream(url, headers, body, signal, idleTimeoutMs) {
  return new Promise((resolve, reject) => {
    let response;
    const req = httpRequest(url, {
      method: "POST",
      agent: false,
      signal,
      timeout: idleTimeoutMs,
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      response = res;
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(new Error("Local model upstream redirected"));
        return;
      }
      resolve(res);
    });
    req.on("timeout", () => {
      const error = new UpstreamIdleTimeoutError(idleTimeoutMs);
      response?.destroy(error);
      req.destroy(error);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function readText(stream) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function loopbackUpstream(upstream) {
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)
    || target.username || target.password || target.search || target.hash) {
    throw new Error("Upstream must be an unauthenticated loopback HTTP URL");
  }
  return target;
}

async function readMetadata(url, apiKey) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000), redirect: "error",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
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

export async function discoverModelCatalog(upstream, template, apiKey) {
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
    readMetadata(new URL(`${base}/models`), apiKey),
    readMetadata(new URL(`${base.slice(0, -3)}/props`), apiKey),
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

const DIAGNOSTIC_FIELDS = new Set([
  "model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "text", "metadata", "stream", "store", "include", "service_tier",
  "previous_response_id", "max_output_tokens", "prompt_cache_key", "context_management",
  "truncation", "background", "user", "prompt", "safety_identifier", "prompt_cache_retention",
]);
const INPUT_TYPES = new Set(["message", "function_call", "function_call_output", "reasoning", "compaction", "item_reference"]);
const INPUT_ROLES = new Set(["system", "developer", "user", "assistant"]);
const CONTENT_TYPES = new Set(["input_text", "output_text", "text", "input_image", "input_file", "refusal"]);
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? "");
const metadataName = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) ? value : "[redacted]";
const largestTen = (rows) => rows.sort((left, right) => right.bytes - left.bytes).slice(0, 10);

/** Sizes only: never retain prompt text, schemas, arguments, model paths or image URLs. */
export function summarizeRequest(request, wireBytes = jsonBytes(request)) {
  const fieldBytes = {};
  for (const [key, value] of Object.entries(request)) {
    const field = DIAGNOSTIC_FIELDS.has(key) ? key : "other";
    fieldBytes[field] = (fieldBytes[field] ?? 0) + jsonBytes(value);
  }
  const tools = [];
  const namespaces = [];
  let deferredToolCount = 0;
  for (const spec of request.tools ?? []) {
    if (spec.type === "namespace") namespaces.push({
      name: metadataName(spec.name), bytes: jsonBytes(spec),
      descriptionBytes: typeof spec.description === "string" ? Buffer.byteLength(spec.description) : 0,
    });
    for (const tool of spec.type === "namespace" ? spec.tools ?? [] : [spec]) {
      if (tool.defer_loading === true || tool.deferLoading === true) deferredToolCount++;
      const schemaField = ["parameters", "inputSchema", "input_schema", "format"].find((key) => Object.hasOwn(tool, key));
      tools.push({
        name: spec.type === "namespace" ? `${metadataName(spec.name)}.${metadataName(tool.name)}` : metadataName(tool.name),
        bytes: jsonBytes(tool),
        descriptionBytes: typeof tool.description === "string" ? Buffer.byteLength(tool.description) : 0,
        schemaBytes: schemaField === undefined ? 0 : jsonBytes(tool[schemaField]),
      });
    }
  }
  const items = typeof request.input === "string" ? [{ role: "user", content: request.input }] : request.input ?? [];
  const roles = {};
  const contentTypes = {};
  let imageBytes = 0;
  const input = items.map((item, index) => {
    const role = INPUT_ROLES.has(item.role) ? item.role : "other";
    roles[role] = (roles[role] ?? 0) + 1;
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        const type = CONTENT_TYPES.has(part.type) ? part.type : "other";
        contentTypes[type] = (contentTypes[type] ?? 0) + 1;
        if (type === "input_image") imageBytes += jsonBytes(part);
      }
    }
    return {
      index, role, type: INPUT_TYPES.has(item.type) ? item.type : item.role ? "message" : "other",
      bytes: jsonBytes(typeof request.input === "string" ? request.input : item),
    };
  });
  const total = jsonBytes(request);
  return {
    wireBytes, jsonBytes: total,
    envelopeBytes: total - Object.values(fieldBytes).reduce((sum, bytes) => sum + bytes, 0),
    fieldBytes, toolCount: tools.length, deferredToolCount, namespaceCount: namespaces.length,
    inputCount: items.length, roles, contentTypes, imageBytes,
    largestTools: largestTen(tools), largestNamespaces: largestTen(namespaces), largestInput: largestTen(input),
  };
}

function contextTokenCounts(value) {
  const counts = {};
  const error = value?.error ?? value;
  for (const [source, target] of [["n_prompt_tokens", "promptTokens"], ["n_ctx", "contextTokens"]]) {
    if (Number.isSafeInteger(error?.[source]) && error[source] >= 0) counts[target] = error[source];
  }
  return counts;
}

export async function startBridge(upstream, apiKey, { idleTimeoutMs = DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS, onDiagnostic } = {}) {
  const target = loopbackUpstream(upstream);
  // Node truncates a socket timer above 2^31 - 1 ms and warns on every request.
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2 ** 31 - 1) {
    throw new Error("The upstream idle timeout must be a whole number of milliseconds from 1 to 2147483647");
  }
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    const requestId = randomUUID();
    const sessionId = req.headers.session_id;
    const correlation = {
      schemaVersion: 1, requestId,
      ...(typeof sessionId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId) ? { threadId: sessionId } : {}),
    };
    const diagnose = (event) => {
      // Observability must not change model requests or their outcome.
      try { onDiagnostic?.({ ...correlation, ...event }); } catch { /* The request still proceeds if its logger fails. */ }
    };
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
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { body, names } = translateRequest(request);
      const upstreamBody = JSON.stringify(body);
      if (onDiagnostic) diagnose({
        kind: "request",
        incoming: summarizeRequest(request, size),
        outgoing: summarizeRequest(body, Buffer.byteLength(upstreamBody)),
      });
      const response = await postUpstream(
        `${target.href.replace(/\/$/, "")}/responses`,
        { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        upstreamBody,
        abort.signal,
        idleTimeoutMs,
      );
      const contentType = response.headers["content-type"] ?? "application/json";
      res.writeHead(response.statusCode, { "Content-Type": contentType, "Cache-Control": "no-cache" });
      if (!contentType.includes("text/event-stream")) {
        const text = await readText(response);
        let translated = text;
        let counts = {};
        try {
          const value = JSON.parse(text);
          counts = contextTokenCounts(value);
          translated = JSON.stringify(translateResponse(value, names));
        } catch { /* Preserve the upstream response if parsing or translation fails. */ }
        diagnose({ kind: "response", status: response.statusCode, ...counts });
        res.end(translated);
        return;
      }
      diagnose({ kind: "response", status: response.statusCode });
      const decoder = new TextDecoder();
      let pending = "";
      const writeLine = async (line) => {
        if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
          line = `data: ${JSON.stringify(translateResponse(JSON.parse(line.slice(5)), names))}`;
        }
        if (!res.write(`${line}\n`)) await once(res, "drain", { signal: abort.signal });
      };
      for await (const chunk of response) {
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
      diagnose({ kind: "failure", aborted: abort.signal.aborted });
      if (abort.signal.aborted) return;
      if (res.headersSent) res.destroy(error);
      else res.writeHead(error.status ?? 400, { "Content-Type": "application/json" }).end(JSON.stringify({
        error: { message: error.message, type: "local_responses_bridge_error" },
      }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
