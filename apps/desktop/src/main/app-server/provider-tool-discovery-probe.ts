import { randomUUID } from "node:crypto";

/** Three bounded requests; the only callable fixture returns an in-memory marker. */
export async function verifyProviderToolDiscovery(
  model: string,
  request: (body: Record<string, unknown>) => Promise<unknown>,
  effort?: string,
): Promise<void> {
  const search = {
    type: "tool_search", execution: "client", description: "Discover the read-only pwragent_probe.read_marker fixture.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false },
  };
  const body = {
    model, store: false, stream: false, max_output_tokens: 256,
    ...(effort ? { reasoning: { effort } } : {}),
    instructions: "Verify tool discovery. Search for read_marker, invoke the selected tool, then return only its exact output. Do not invent the output.",
    tools: [search],
  };
  const input: unknown[] = [{ role: "user", content: "Find and call the read-only marker tool, then return its value." }];
  const first = output(await request({ ...body, input }));
  const call = first.find((item) => item.type === "tool_search_call");
  if (!call || call.execution !== "client" || typeof call.call_id !== "string"
    || !record(call.arguments) || typeof record(call.arguments)?.query !== "string") {
    throw new Error("The model did not request client tool discovery.");
  }
  input.push(...first, {
    type: "tool_search_output", id: `tso_${randomUUID().replaceAll("-", "")}`, call_id: call.call_id, execution: "client", status: "completed",
    tools: [{ type: "namespace", name: "pwragent_probe", description: "Read-only compatibility fixture", tools: [{
      type: "function", name: "read_marker", description: "Return a unique marker. Takes no arguments.", strict: false, defer_loading: true,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    }] }],
  });
  const second = output(await request({ ...body, input }));
  const invocation = second.find((item) => item.type === "function_call");
  if (!invocation || invocation.namespace !== "pwragent_probe" || invocation.name !== "read_marker"
    || typeof invocation.call_id !== "string" || typeof invocation.arguments !== "string") {
    throw new Error("The provider did not make the discovered schema callable.");
  }
  const args: unknown = JSON.parse(invocation.arguments);
  if (!record(args) || Object.keys(record(args)!).length) throw new Error("The selected fixture received invalid arguments.");
  const marker = `PWRAGENT_DISCOVERY_${randomUUID()}`;
  input.push(...second, { type: "function_call_output", call_id: invocation.call_id, output: marker });
  const final = output(await request({ ...body, input, tool_choice: "none" }));
  const text = final.flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((part: unknown) => record(part)).filter((part) => part?.type === "output_text")
    .map((part) => part?.text).join("").trim();
  if (text !== marker) throw new Error("The model did not return the selected tool's exact marker.");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function output(response: unknown): Record<string, unknown>[] {
  const value = record(response);
  if (value?.status !== "completed" || !Array.isArray(value.output)) throw new Error("The discovery response did not complete.");
  return value.output.flatMap((item: unknown) => record(item) ? [record(item)!] : []);
}
