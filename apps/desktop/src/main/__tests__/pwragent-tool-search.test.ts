import { describe, expect, it } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildPwrAgentToolSearchDefinition, PWRAGENT_TOOL_SEARCH_DESCRIPTION, searchPwrAgentTools, withPwrAgentToolDiscovery } from "../agent-tools/pwragent-tool-search";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";

const catalog: DynamicToolSpec[] = [{
  type: "namespace",
  name: "pwragent",
  description: "PwrAgent",
  tools: resolveAgentToolCatalogs({}).flatMap((entry) => entry.dynamicTools.flatMap((spec) => spec.type === "namespace" ? spec.tools : [])),
}];

describe("PwrAgent tool discovery", () => {
  it("leaves the default catalog untouched and keeps only search eager when enabled", () => {
    const before = JSON.stringify(catalog);
    expect(withPwrAgentToolDiscovery(catalog, false)).toBe(catalog);
    const discovered = withPwrAgentToolDiscovery(catalog, true);
    const tools = discovered.flatMap((spec) => spec.type === "namespace" ? spec.tools : []);
    expect(tools.filter((tool) => !tool.deferLoading).map((tool) => tool.name)).toEqual(["tool_search"]);
    expect(tools.slice(1)).toEqual(catalog.flatMap((spec) => spec.type === "namespace" ? spec.tools.map((tool) => ({ ...tool, deferLoading: true })) : []));
    expect(JSON.stringify(catalog)).toBe(before);
    // Character budget, not a tokenizer measurement. Keep the only eager
    // definition within the requested approximately 1,000-token ceiling.
    expect(PWRAGENT_TOOL_SEARCH_DESCRIPTION.length).toBeLessThan(4_000);
    expect(JSON.stringify(tools[0]).length).toBeLessThan(4_000);
    expect(new AgentToolRouter([buildPwrAgentToolSearchDefinition(catalog)]).buildMcpTools()).toEqual([]);
  });

  it.each([
    ["handoff child thread", "handoff_task"],
    ["split parallel tasks", "handoff_task"],
    ["close thread", "mutate_thread"],
    ["job monitor", "create_monitor_delegation"],
    ["run another machine", "create_instance_thread"],
    ["move project folder", "move_thread_workspace"],
    ["telegram attach topic", "attach_thread_here"],
    ["feishu send file", "send_messaging_file"],
    ["read star map", "read_star_map_view"],
    ["watch pull request", "watch_thread_pull_request"],
    ["manage mcp connections", "manage_mcp_connections"],
  ])("finds %s in its bounded results", (query, name) => {
    const results = searchPwrAgentTools(catalog, query);
    expect(results.map((tool) => tool.name)).toContain(name);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("returns exact schemas and usage instructions for exact tool names", () => {
    for (const spec of catalog) {
      if (spec.type !== "namespace") continue;
      for (const original of spec.tools) {
        expect(searchPwrAgentTools(catalog, `tools.pwragent__${original.name}`, 1)).toEqual([{
          namespace: "pwragent", name: original.name,
          codeModeName: `pwragent__${original.name}`,
          description: original.description, inputSchema: original.inputSchema,
        }]);
      }
    }
    expect(searchPwrAgentTools(catalog, "quuxnonexistent")).toEqual([]);
    expect(searchPwrAgentTools(catalog, "thread", 100).length).toBeLessThanOrEqual(5);
  });

  it("validates arguments and returns a directly printable JSON string without actions", async () => {
    const definition = buildPwrAgentToolSearchDefinition(catalog);
    const context = { backend: "codex" as const, threadId: "thread-1", transport: "codex_dynamic_tool" as const };
    for (const args of [{}, { query: " " }, { query: "x".repeat(501) }, { query: "thread", limit: 6 }, { query: "thread", limit: 1.5 }]) {
      expect(await definition.dispatch(args, context)).toMatchObject({ ok: false, code: "invalid_arguments" });
    }
    const result = await definition.dispatch({ query: "handoff_task", limit: 1 }, context);
    expect(result.ok).toBe(true);
    expect(result.contentItems).toEqual([{ type: "inputText", text: JSON.stringify({ tools: searchPwrAgentTools(catalog, "handoff_task", 1) }) }]);
  });
});
