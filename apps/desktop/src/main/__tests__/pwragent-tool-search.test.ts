import { describe, expect, it } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import {
  buildPwrAgentToolSearchDefinition,
  MESSAGING_EAGER_TOOLS,
  PWRAGENT_TOOL_SEARCH_DESCRIPTION,
  searchPwrAgentTools,
  VOICE_MANAGER_EAGER_TOOLS,
  withPwrAgentToolDiscovery,
} from "../agent-tools/pwragent-tool-search";
import { VOICE_MANAGER_AGENT_INSTRUCTIONS } from "../native-voice/voice-manager-thread";
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

  it("keeps a thread's eager set loaded and defers the rest", () => {
    const names = catalog.flatMap((spec) => spec.type === "namespace" ? spec.tools.map((tool) => tool.name) : []);
    for (const eager of [VOICE_MANAGER_EAGER_TOOLS, MESSAGING_EAGER_TOOLS]) {
      // A renamed or removed tool would otherwise silently fall back to search.
      expect(names).toEqual(expect.arrayContaining([...eager]));
      const tools = withPwrAgentToolDiscovery(catalog, true, eager)
        .flatMap((spec) => spec.type === "namespace" ? spec.tools : []);
      expect(tools.filter((tool) => !tool.deferLoading).map((tool) => tool.name).sort())
        .toEqual(["tool_search", ...eager].sort());
      expect(tools).toHaveLength(names.length + 1);
      // Each eager schema is sent on every turn. Character budget, not tokens.
      const eagerCharacters = tools.filter((tool) => eager.has(tool.name))
        .reduce((total, tool) => total + JSON.stringify(tool).length, 0);
      expect(eagerCharacters).toBeLessThan(20_000);
    }
  });

  it("loads every catalog tool the Voice manager's instructions name", () => {
    const names = catalog.flatMap((spec) => spec.type === "namespace" ? spec.tools.map((tool) => tool.name) : []);
    const lines = VOICE_MANAGER_AGENT_INSTRUCTIONS.split("\n");
    const mentions = (name: string, line: string) => new RegExp(`\\b${name}\\b`).test(line);
    // A tool named only in a "Never use X" line is forbidden, not used.
    const forbidden = names.filter((name) => lines.some((line) => /\bnever use\b/i.test(line) && mentions(name, line)));
    const used = names.filter((name) => !forbidden.includes(name)
      && lines.some((line) => mentions(name, line)));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !VOICE_MANAGER_EAGER_TOOLS.has(name))).toEqual([]);
    expect(forbidden.filter((name) => VOICE_MANAGER_EAGER_TOOLS.has(name))).toEqual([]);
    // Every eager tool earns its per-turn cost by being one the instructions use.
    expect([...VOICE_MANAGER_EAGER_TOOLS].filter((name) => !used.includes(name))).toEqual([]);
  });

  it("returns every exact tool name in a query regardless of limit", () => {
    // The 2026-10-01 Voice manager turn: four names, limit 2, two returned.
    const query = "read_operator_focus list_federation_instances list_instance_projects create_instance_thread";
    expect(searchPwrAgentTools(catalog, query, 2).map((tool) => tool.name)).toEqual([
      "read_operator_focus",
      "list_federation_instances",
      "list_instance_projects",
      "create_instance_thread",
    ]);
    // Prefixed and comma-separated names count; the limit still caps ranked fill.
    expect(searchPwrAgentTools(catalog, "tools.pwragent__steer_thread, pwragent.stop_thread", 1).map((tool) => tool.name))
      .toEqual(["steer_thread", "stop_thread"]);
    const mixed = searchPwrAgentTools(catalog, "read_thread watch pull request", 3).map((tool) => tool.name);
    expect(mixed[0]).toBe("read_thread");
    expect(mixed).toContain("watch_thread_pull_request");
    expect(mixed).toHaveLength(3);
  });

  it.each([
    ["handoff child thread", "handoff_task"],
    ["split parallel tasks", "handoff_task"],
    ["close thread", "mutate_thread"],
    ["mark project read", "mark_project_read"],
    ["clear all unread items in repository", "mark_project_read"],
    ["bulk dismiss unread folder", "mark_project_read"],
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
