import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";

// Keep local-model prefill bounded. Search cannot load unregistered functions
// on these providers; advertise the core contracts directly instead.
export const FLAT_PWRAGENT_CORE_TOOLS: ReadonlySet<string> = new Set([
  "get_forge_status",
  "create_pull_request",
  "get_pull_request",
  "update_pull_request",
  "search_threads",
  "read_thread",
  "get_thread_status",
  "rename_current_thread",
  "attach_thread_pull_request",
  "watch_thread_pull_request",
  "add_todo",
  "search_mcp_tools",
  "call_mcp_tool",
]);

/** Adapt only the unified parent catalog; saved legacy/helper tools stay intact. */
export function flattenPwrAgentDynamicTools(tools: DynamicToolSpec[]): DynamicToolSpec[] {
  const names = new Set(tools.filter((tool) => tool.type === "function").map((tool) => tool.name));
  return tools.flatMap((spec): DynamicToolSpec[] => {
    if (spec.type !== "namespace" || spec.name !== PWRAGENT_TOOL_NAMESPACE) return [spec];
    return spec.tools
      .filter((tool) => tool.name !== "tool_search" && FLAT_PWRAGENT_CORE_TOOLS.has(tool.name))
      .map((tool) => {
        const name = `${PWRAGENT_TOOL_NAMESPACE}__${tool.name}`;
        if (names.has(name)) throw new Error(`Duplicate flat dynamic tool: ${name}`);
        names.add(name);
        return { ...tool, name, deferLoading: false };
      });
  });
}

export function usesFlatPwrAgentTools(provider: string | undefined): boolean {
  return Boolean(provider && provider !== "openai");
}
