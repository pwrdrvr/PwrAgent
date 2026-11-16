// Experimental Responses transport. Codex owns discovery, execution and policy.
// This module only changes the representation of its existing Code Mode tool.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

const MAX_BYTES = 16 * 1024 * 1024;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const invalidCode = 'throw new Error("Invalid exec arguments: expected a JSON object with exactly one string field, code. Retry the call.");';

function identity(namespace, name) {
  return `codex_${createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0, 48)}`;
}

function decodeCode(argumentsValue) {
  try {
    const value = JSON.parse(argumentsValue);
    if (value && typeof value.code === "string" && Object.keys(value).length === 1) return value.code;
  } catch { /* Return executable error feedback through Codex's own executor. */ }
  return invalidCode;
}

/** Per-request identities; no catalog, credential or thread cache. */
export function translateCodeModeRequest(request) {
  const items = typeof request.input === "string" ? [{ role: "user", content: request.input }] : request.input ?? [];
  const names = new Map();
  const tools = new Map();
  const register = (spec, namespace) => {
    if (spec.type === "namespace") {
      for (const tool of spec.tools) register(tool, spec.name);
      return;
    }
    const name = identity(namespace, spec.name);
    const custom = spec.type === "custom" && spec.name === "exec"
      && spec.format?.type === "grammar" && spec.format?.syntax === "lark";
    if (spec.type !== "function" && !custom) {
      throw new Error(`Portable Code Mode does not support tool type ${spec.type}`);
    }
    const { defer_loading: deferred, ...definition } = spec;
    if (deferred) throw new Error("Portable Code Mode requires Codex-owned nested discovery");
    names.set(name, { name: spec.name, ...(namespace ? { namespace } : {}), custom });
    tools.set(name, custom ? {
      type: "function", name,
      description: `${spec.description}\nSend the JavaScript source unchanged in the code field.`,
      parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
    } : { ...definition, name });
  };
  for (const tool of request.tools ?? []) register(tool);
  const input = [];
  for (const item of items) {
    if (item.type === "additional_tools") {
      for (const tool of item.tools ?? []) register(tool);
    } else if (item.type === "custom_tool_call") {
      input.push({ type: "function_call", id: item.id, call_id: item.call_id,
        name: identity(item.namespace, item.name), arguments: JSON.stringify({ code: item.input }) });
    } else if (item.type === "custom_tool_call_output") {
      // Preserve text, images, and other Responses content without stringifying.
      input.push({ ...item, type: "function_call_output" });
    } else if (item.type === "function_call") {
      const { namespace, ...call } = item;
      input.push({ ...call, name: identity(namespace, item.name) });
    } else if (item.type === "item_reference") {
      throw new Error("Portable Code Mode requires explicit Responses history");
    } else if (["tool_search_call", "tool_search_output"].includes(item.type)) {
      throw new Error("Portable Code Mode requires nested search, not native search history");
    } else {
      input.push(item);
    }
  }
  const body = { ...request, tools: [...tools.values()], input };
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const choice = body.tool_choice;
    if (!["function", "custom"].includes(choice.type)) throw new Error("Unsupported portable tool choice");
    body.tool_choice = { type: "function", name: identity(choice.namespace, choice.name) };
  }
  // The upstream cannot resolve Codex's unmodified native history by reference.
  if (body.previous_response_id) throw new Error("Portable Code Mode requires explicit Responses history");
  const customIndexes = new Set();
  const translate = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(translate);
    if (value.type === "function_call" && names.has(value.name)) {
      const { custom, ...original } = names.get(value.name);
      if (!custom) return { ...value, ...original };
      const { arguments: args, ...call } = value;
      return { ...call, ...original, type: "custom_tool_call", input: decodeCode(args || "{}") };
    }
    const result = { ...value };
    for (const key of ["item", "response", "output"]) if (key in result) result[key] = translate(result[key]);
    return result;
  };
  const translateEvent = (event) => {
    if (event.type === "response.output_item.added" && names.get(event.item?.name)?.custom) {
      customIndexes.add(event.output_index);
      return { ...event, item: { ...translate(event.item), input: "" } };
    }
    // JSON string escaping cannot be decoded safely a fragment at a time.
    // Codex receives the complete source in output_item.done before dispatch.
    if (customIndexes.has(event.output_index) && event.type.startsWith("response.function_call_arguments.")) return null;
    return translate(event);
  };
  return { body, translateResponse: translate, translateEvent };
}

async function readBounded(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Portable response exceeds 16 MiB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Opt-in only. The owner supplies an authenticated upstream request closure. */
export async function startPortableCodeModeTransport({ send, onDiagnostic }) {
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const diagnose = (value) => { try { onDiagnostic?.(value); } catch { /* Diagnostics cannot change delivery. */ } };
    let phase = "request_parse";
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
      const raw = await readBounded(req);
      const request = JSON.parse(raw);
      phase = "request_translation";
      const { body, translateResponse, translateEvent } = translateCodeModeRequest(request);
      diagnose({ stage: "request", inputBytes: Buffer.byteLength(raw), outputBytes: bytes(body), toolBytes: bytes(body.tools), toolCount: body.tools.length });
      // Exactly one send. No retries of possibly accepted invocations.
      phase = "upstream_request";
      const response = await send(body, abort.signal);
      if (!response.ok) {
        diagnose({ stage: "upstream_error", status: response.status });
        await response.body?.cancel();
        res.writeHead(response.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: `Portable upstream HTTP ${response.status}` } }));
        return;
      }
      const streaming = response.headers.get("content-type")?.includes("text/event-stream");
      phase = "response_translation";
      res.writeHead(200, { "Content-Type": request.stream ? "text/event-stream" : "application/json", "Cache-Control": "no-cache" });
      const emit = async (event) => {
        if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, "drain", { signal: abort.signal });
      };
      if (!streaming) {
        const value = translateResponse(JSON.parse(await readBounded(response.body)));
        if (request.stream) {
          await emit({ type: "response.created", response: { ...value, status: "in_progress", output: [] } });
          for (const [output_index, item] of (value.output ?? []).entries()) {
            await emit({ type: "response.output_item.added", output_index, item });
            await emit({ type: "response.output_item.done", output_index, item });
          }
          await emit({ type: "response.completed", response: value });
        } else res.write(JSON.stringify(value));
      } else {
        if (!request.stream) throw new Error("Buffered client requires a buffered upstream response");
        let pending = "";
        const decoder = new TextDecoder();
        const processFrame = async (frame) => {
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") return;
          const event = translateEvent(JSON.parse(data));
          if (event) await emit(event);
        };
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          pending = pending.replace(/\r\n/g, "\n");
          if (Buffer.byteLength(pending) > MAX_BYTES) throw new Error("Portable SSE frame exceeds 16 MiB");
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            await processFrame(pending.slice(0, boundary));
            pending = pending.slice(boundary + 2);
          }
        }
        pending += decoder.decode();
        if (pending.trim()) await processFrame(pending);
      }
      res.end();
      diagnose({ stage: "completed" });
    } catch {
      diagnose({ stage: "transport_error", phase, canceled: abort.signal.aborted });
      if (abort.signal.aborted) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Portable Code Mode translation failed" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
