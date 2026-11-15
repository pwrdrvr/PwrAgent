import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { translateRequest, translateResponse } from "../codex-app-server/local-responses-bridge.mjs";

const search = {
  type: "tool_search", execution: "client", description: "Find deferred tools",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const identifier = fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/);

// Oracle: the native client and a function-only provider must observe the same
// search arguments, selected schema, tool identity, call IDs, and tool result.
describe("local Responses discovery protocol oracle", () => {
  it("exposes the shrunk a.a tool from an empty-query search result", () => {
    const first = translateRequest({ tools: [search], input: [] });
    const name = (first.body.tools as Array<{ name: string }>)[0].name;
    const call = translateResponse({ type: "function_call", call_id: "s", name, arguments: '{"query":"","limit":1}' }, first.names);
    const next = translateRequest({ tools: [search], input: [call, {
      type: "tool_search_output", call_id: "s", tools: [{ type: "namespace", name: "a", tools: [{ type: "function", name: "a", parameters: {} }] }],
    }] });
    const selected = (next.body.tools as Array<{ name: string }>)[1];
    expect(translateResponse({ type: "function_call", name: selected.name, call_id: "t", arguments: "{}" }, next.names))
      .toEqual({ type: "function_call", name: "a", namespace: "a", call_id: "t", arguments: "{}" });
  });

  it("makes every discovered schema callable and preserves identities across the complete exchange", () => {
    fc.assert(fc.property(identifier, identifier, fc.string(), fc.jsonValue(), (namespace, name, query, value) => {
      const args = { query, limit: 1 };
      const first = translateRequest({ tools: [search], input: [] });
      const functions = first.body.tools as Array<Record<string, any>>;
      expect(functions).toHaveLength(1);
      expect(functions[0]).toMatchObject({ type: "function", parameters: search.parameters });
      const nativeCall = translateResponse({
        type: "function_call", id: "fc_search", call_id: "search-1", name: functions[0].name, arguments: JSON.stringify(args),
      }, first.names) as Record<string, unknown>;
      expect(nativeCall).toEqual({ type: "tool_search_call", id: "fc_search", call_id: "search-1", execution: "client", arguments: args });
      const spec = { type: "function", name, description: "Read-only selected fixture", parameters: { type: "object", properties: {} }, defer_loading: true };
      const result = { type: "tool_search_output", call_id: "search-1", tools: [{ type: "namespace", name: namespace, tools: [spec] }] };
      const request = { tools: [search], input: [nativeCall, result, result] };
      const before = JSON.stringify(request);
      const second = translateRequest(request);
      expect(JSON.stringify(request)).toBe(before);
      const selected = (second.body.tools as Array<Record<string, any>>).filter((tool) => tool.description === spec.description);
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({ type: "function", parameters: spec.parameters });
      expect(selected[0]).not.toHaveProperty("defer_loading");
      const inputs = second.body.input as Array<Record<string, any>>;
      expect(inputs[0]).toMatchObject({ type: "function_call", call_id: "search-1", name: functions[0].name, arguments: JSON.stringify(args) });
      expect(inputs[1]).toMatchObject({ type: "function_call_output", call_id: "search-1" });
      const decoded = JSON.parse(inputs[1].output);
      expect(decoded.tools[0]).toMatchObject({ name: selected[0].name, parameters: spec.parameters });
      const selectedCall = translateResponse({ type: "function_call", call_id: "tool-1", name: selected[0].name, arguments: "{}" }, second.names);
      expect(selectedCall).toEqual({ type: "function_call", call_id: "tool-1", name, namespace, arguments: "{}" });
      const third = translateRequest({ tools: [search], input: [nativeCall, result, selectedCall, { type: "function_call_output", call_id: "tool-1", output: JSON.stringify(value) }] });
      expect((third.body.input as any[]).at(-2)).toMatchObject({ name: selected[0].name, call_id: "tool-1" });
      expect((third.body.input as any[]).at(-1)).toEqual({ type: "function_call_output", call_id: "tool-1", output: JSON.stringify(value) });
    }), { numRuns: 150 });
  });

  it("keeps the PwrAgent bootstrap search distinct from native search in streamed and complete responses", () => {
    const request = translateRequest({ tools: [search, { type: "namespace", name: "pwragent", tools: [{ type: "function", name: "tool_search", parameters: {} }] }], input: [] });
    const tools = request.body.tools as Array<Record<string, any>>;
    const bootstrap = tools.find((tool) => tool.name !== tools[0].name)!;
    const bootstrapCall = { type: "function_call", name: bootstrap.name, arguments: "{}", call_id: "app-1" };
    expect(translateResponse({ type: "response.output_item.done", item: bootstrapCall }, request.names)).toEqual({
      type: "response.output_item.done", item: { ...bootstrapCall, name: "tool_search", namespace: "pwragent" },
    });
    const call = { type: "function_call", name: tools[0].name, arguments: '{"query":"cobalt"}', call_id: "native-1" };
    const expected = { type: "tool_search_call", execution: "client", arguments: { query: "cobalt" }, call_id: "native-1" };
    expect(translateResponse({ type: "response.output_item.done", item: call }, request.names)).toEqual({ type: "response.output_item.done", item: expected });
    expect(translateResponse({ type: "response.completed", response: { output: [call] } }, request.names)).toEqual({ type: "response.completed", response: { output: [expected] } });
    expect(translateResponse({ type: "response.output_item.added", item: { ...call, arguments: "" } }, request.names)).toMatchObject({ item: { type: "tool_search_call", arguments: {} } });
  });

  it("uses the newest discovered schema while preserving directly advertised tools and avoiding search-name collisions", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), fc.string(), (count, description) => {
      const direct = Array.from({ length: count }, (_, index) => ({
        type: "function", name: `pwragent_native_tool_search${index ? `_${index}` : ""}`, parameters: {},
      }));
      const discovered = (description: string) => ({ type: "tool_search_output", call_id: "s", tools: [{
        type: "function", name: "selected", parameters: {}, description, defer_loading: true,
      }] });
      const translated = translateRequest({ tools: [search, ...direct], input: [discovered("old"), discovered(description)] });
      const tools = translated.body.tools as Array<Record<string, any>>;
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      expect(tools.find((tool) => tool.name === "selected")).toMatchObject({ description });
      for (const tool of direct) {
        expect(translateResponse({ type: "function_call", name: tool.name, arguments: "{}" }, translated.names))
          .toEqual({ type: "function_call", name: tool.name, arguments: "{}" });
      }
    }));
    expect(() => translateRequest({ tools: [{ type: "web_search" }] })).toThrow("does not support tool type");
    expect(() => translateRequest({ tools: [{ ...search, execution: "server" }] })).toThrow("does not support tool type");
    expect(() => translateRequest({ tools: [{ type: "function", name: "same" }, { type: "function", name: "same" }] }))
      .toThrow("Duplicate local tool name");
  });
});
