import { randomUUID } from "node:crypto";
import { object } from "./research-harness-records";

/** Ordinary Chat Completions functions. No discovery, deferred fields or native tool-search items. */
export const HARNESS_RESEARCH_FUNCTIONS = [
  { type: "function", function: { name: "research_read", description: "Read the current research board in this run.",
    parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "research_update", description: "Post a finding or submit a candidate under your assigned approach. Reviews remain with PwrAgent.",
    parameters: { type: "object", required: ["action", "text", "paths"], additionalProperties: false,
      properties: { action: { type: "string", enum: ["finding", "submit"] }, text: { type: "string", maxLength: 4000 },
        kind: { type: "string", enum: ["lemma", "partial", "counterexample", "dead_end", "file", "note"] },
        paths: { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } } } } } },
] as const;

export type ResearchModelTransport = (request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
/** Probe a complete ordinary function-call/result round trip before any research dispatch. */
export async function probeResearchModel(complete: ResearchModelTransport, model: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const nonce = randomUUID();
  const tool = { type: "function", function: { name: "research_compatibility_probe", description: "Echo the supplied nonce.",
    parameters: { type: "object", properties: { nonce: { type: "string", enum: [nonce] } }, required: ["nonce"], additionalProperties: false } } };
  const initial = { model, messages: [{ role: "user", content: `Call research_compatibility_probe with nonce ${nonce}. This is a compatibility probe, not research.` }],
    tools: [tool], tool_choice: { type: "function", function: { name: tool.function.name } }, stream: false };
  const response = object(await complete(initial, signal));
  const message = responseMessage(response);
  signal.throwIfAborted();
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) throw new Error("Endpoint did not return an ordinary function call");
  const call = object(calls[0]), fn = object(call.function);
  if (typeof call.id !== "string" || call.type !== "function" || fn.name !== tool.function.name || typeof fn.arguments !== "string"
    || object(JSON.parse(fn.arguments)).nonce !== nonce) throw new Error("Endpoint returned an incompatible function call");
  const followup = await complete({ model, stream: false, tools: [tool], tool_choice: "none", messages: [...initial.messages,
    { role: "assistant", content: null, tool_calls: calls }, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ nonce }) },
    { role: "user", content: "Reply with exactly the nonce from the tool result." }] }, signal);
  if (responseMessage(object(followup)).content !== nonce) throw new Error("Endpoint did not consume the ordinary tool result");
}

/** Every research call supplies the same small eager surface and the selected model. */
export function researchModelRequest(model: string, messages: unknown): Record<string, unknown> {
  if (!Array.isArray(messages) || !messages.length || messages.length > 100 || JSON.stringify(messages).length > 128_000) throw new Error("Invalid research model messages");
  const normalized = messages.map((message) => {
    const m = object(message);
    if (!["system", "user", "assistant", "tool"].includes(String(m.role))) throw new Error("Unsupported research message role");
    if (m.content !== null && typeof m.content !== "string") throw new Error("Research messages must contain text");
    if (m.role === "tool" && typeof m.tool_call_id !== "string") throw new Error("Tool results require their call identity");
    let calls: unknown[] | undefined;
    if (m.tool_calls !== undefined) {
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length > 8) throw new Error("Invalid research function calls");
      calls = m.tool_calls.map((entry) => {
        const call = object(entry), fn = object(call.function);
        if (typeof call.id !== "string" || call.type !== "function" || !HARNESS_RESEARCH_FUNCTIONS.some((tool) => tool.function.name === fn.name) || typeof fn.arguments !== "string") throw new Error("Unsupported research function call");
        return { id: call.id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
      });
    }
    return { role: m.role, content: m.content, ...(m.role === "tool" ? { tool_call_id: m.tool_call_id } : {}), ...(calls ? { tool_calls: calls } : {}) };
  });
  return { model, messages: normalized, tools: HARNESS_RESEARCH_FUNCTIONS, stream: false };
}
function responseMessage(response: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(response.choices) || !response.choices.length) throw new Error("Endpoint returned no model response");
  return object(object(response.choices[0]).message);
}
