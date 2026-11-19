import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { HARNESS_RESEARCH_FUNCTIONS, probeResearchModel, researchModelRequest } from "../research-model-adapter";

describe("ordinary research model adapter", () => {
  it("does not make the second probe call after cancellation, even when the transport ignores abort", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(probeResearchModel(async (request) => {
      calls++;
      const tools = request.tools as Array<{ function: { parameters: { properties: { nonce: { enum: string[] } } } } }>;
      const nonce = tools[0]!.function.parameters.properties.nonce.enum[0]!;
      controller.abort();
      return { choices: [{ message: { tool_calls: [{ id: "probe-call", type: "function", function: { name: "research_compatibility_probe", arguments: JSON.stringify({ nonce }) } }] } }] };
    }, "fixture-model", controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("probes a real function-call/result round trip without catalog discovery or native tool search", async () => {
    const requests: Record<string, unknown>[] = [];
    let nonce = "";
    await probeResearchModel(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        const tools = request.tools as Array<{ function: { parameters: { properties: { nonce: { enum: string[] } } } } }>;
        nonce = tools[0]!.function.parameters.properties.nonce.enum[0]!;
        return { choices: [{ message: { tool_calls: [{ id: "probe-call", type: "function", function: { name: "research_compatibility_probe", arguments: JSON.stringify({ nonce }) } }] } }] };
      }
      expect(request.messages).toContainEqual({ role: "tool", tool_call_id: "probe-call", content: JSON.stringify({ nonce }) });
      return { choices: [{ message: { content: nonce } }] };
    }, "fixture-model", new AbortController().signal);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toMatch(/tool_search|defer_loading|allowed_tools/);
  });

  it("refuses unsupported or malformed function behavior instead of assuming endpoint compatibility", async () => {
    await fc.assert(fc.asyncProperty(fc.oneof(fc.jsonValue(), fc.constant({ choices: [{ message: { content: "No tools supported" } }] })), async (response) => {
      await expect(probeResearchModel(async () => response, "fixture-model", new AbortController().signal)).rejects.toThrow();
    }));
  });

  it("always supplies the bounded eager research surface and owner-selected model", () => {
    fc.assert(fc.property(fc.string(), (message) => {
      const result = researchModelRequest("owner-model", [{ role: "user", content: message }]);
      expect(result).toEqual({ model: "owner-model", messages: [{ role: "user", content: message }], tools: HARNESS_RESEARCH_FUNCTIONS, stream: false });
      expect(HARNESS_RESEARCH_FUNCTIONS.map((tool) => tool.function.name)).toEqual(["research_read", "research_update"]);
      expect(JSON.stringify(result.tools)).not.toMatch(/tool_search|defer_loading|research_assign|research_start/);
    }));
  });
});
