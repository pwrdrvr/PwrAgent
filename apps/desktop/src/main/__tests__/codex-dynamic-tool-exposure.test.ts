import { describe, expect, it, vi } from "vitest";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { FLAT_PWRAGENT_CORE_TOOLS, flattenPwrAgentDynamicTools, usesFlatPwrAgentTools } from "../codex-app-server/dynamic-tool-exposure";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { withPwrAgentToolDiscovery } from "../agent-tools/pwragent-tool-search";
import { AgentToolRouter, readAgentDynamicToolCall } from "../agent-tools/agent-tool-router";
import { agentToolSuccess } from "../agent-tools/agent-tool-definition";

describe("flat PwrAgent dynamic tools", () => {
  const catalog: DynamicToolSpec[] = [{
    type: "namespace",
    name: "pwragent",
    description: "PwrAgent",
    tools: resolveAgentToolCatalogs({}).flatMap((entry) => entry.dynamicTools.flatMap((spec) => spec.type === "namespace" ? spec.tools : [])),
  }];

  it.each([true, false])("sends only eager core functions with discovery=%s", (discovery) => {
    const original = withPwrAgentToolDiscovery(catalog, discovery);
    const before = JSON.stringify(original);
    const tools = flattenPwrAgentDynamicTools(original);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...FLAT_PWRAGENT_CORE_TOOLS].map((name) => `pwragent__${name}`).sort());
    expect(tools.every((tool) => tool.type === "function" && tool.deferLoading === false)).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
    // Per-turn schema cost, measured in characters rather than tokenizer tokens.
    expect(JSON.stringify(tools).length).toBeLessThan(40_000);
    for (const tool of tools) {
      const source = catalog[0];
      if (source.type !== "namespace" || tool.type !== "function") throw new Error("Expected function");
      const definition = source.tools.find((entry) => `pwragent__${entry.name}` === tool.name);
      expect(tool.inputSchema).toEqual(definition?.inputSchema);
      expect(tool.description).toBe(definition?.description);
    }
  });

  it("leaves helper and legacy contracts intact and rejects flat-name collisions", () => {
    const helper: DynamicToolSpec = { type: "function", name: "fixture", description: "Fixture", inputSchema: {}, deferLoading: true };
    const legacy: DynamicToolSpec = { type: "namespace", name: "pwragent_task_monitors", description: "Legacy", tools: [] };
    expect(flattenPwrAgentDynamicTools([helper, legacy])).toEqual([helper, legacy]);
    expect(() => flattenPwrAgentDynamicTools([...catalog, { ...helper, name: "pwragent__get_forge_status" }]))
      .toThrow("Duplicate flat dynamic tool");
    expect(usesFlatPwrAgentTools("custom-local")).toBe(true);
    expect(usesFlatPwrAgentTools("openai")).toBe(false);
    expect(usesFlatPwrAgentTools(undefined)).toBe(false);
  });

  it.each(["get_forge_status", "create_pull_request"])("routes flat %s through the existing handler", async (name) => {
    const dispatch = vi.fn(() => agentToolSuccess({ status: "operator-policy" }));
    const router = new AgentToolRouter([{
      namespace: "pwragent", name, description: "Fixture", inputSchema: {}, dispatch,
    }]);
    const params = { namespace: null, tool: `pwragent__${name}`, threadId: "thread", turnId: "turn", callId: "call", arguments: { title: "Fixture" } };
    const call = readAgentDynamicToolCall({ method: "item/tool/call", params });
    expect(call).toMatchObject({ namespace: "pwragent", tool: name });
    if (!call) throw new Error("Expected routed call");
    expect(router.acceptsDynamicToolCall(call)).toBe(true);
    expect(await router.handleDynamicToolCall({ backend: "codex", call })).toMatchObject({ success: true });
    expect(dispatch).toHaveBeenCalledWith(params.arguments, expect.objectContaining({ threadId: "thread", turnId: "turn", callId: "call" }));
    expect(readAgentDynamicToolCall({ method: "item/tool/call", params: { ...params, namespace: "other" } })?.tool)
      .toBe(`pwragent__${name}`);
  });
});
