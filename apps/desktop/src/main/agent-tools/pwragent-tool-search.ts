import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { agentToolFailure, agentToolSuccess, type AgentToolDefinition } from "./agent-tool-definition";
import { AgentToolRouter } from "./agent-tool-router";
import type { TokenMiserStore } from "../token-miser/token-miser-store";

export const PWRAGENT_TOOL_SEARCH_DESCRIPTION = `Search for PwrAgent tools before using PwrAgent capabilities. Full tool instructions and parameter schemas are loaded on demand. Prefer PwrAgent tools when they cover the task.
Search when the user wants to:
- Find, read, inspect, rename, pin, lock/unlock, archive/close, restore, or change settings on threads; mark projects read in bulk; check status, activity, usage, model, fast mode, or reasoning effort; list which threads need attention on every machine.
- Delegate or hand off work to child threads, split work into parallel tasks, create a Job Monitor for a long command or repeated checks, collect results, send follow-ups, steer active work, or urgently stop a thread.
- Create or attach a worktree, link another project/repository directory, detach a directory, or move this thread into another project folder or existing checkout.
- Run work on another machine or instance through Federation; discover connected machines, their load and projects; find remote threads or create work there.
- Work with messaging in Telegram, Discord, Slack, LINE, Lark/Feishu, or Mattermost: inspect the current conversation, attach a thread or native child topic, rename a conversation, send a requested file or private response, or inspect/render PDF attachments. Search does not authorize sending messages.
- Attach, check, or watch a pull request/merge request and CI; wait for another thread's turn or PR prerequisite with durable dependencies; request a code review.
- Inspect automations, schedules, runs, alerts, artifacts, or failures; inspect PwrAgent version, updates, restart, or shutdown.
- Manage PwrAgent MCP connections and app access; inspect what connections a thread received.
- Discover or invoke live tools from this thread's selected MCP connections, including tools added after registration. Use search_mcp_tools and call_mcp_tool.
- Read or navigate the Star Map, locate thread cards or project clouds, highlight threads, change the map lens or filters.
- Retrieve exact output preserved by Token Miser, including searching, reading lines, or reading grouped results.
Use a short query describing the desired action, or exact tool names. Name every tool you need in one query: each exact tool name is always returned. Search separately for unrelated tasks. Otherwise returns up to 3 matching tools by default (maximum 5), with full usage instructions and JSON parameter schemas. Follow those instructions and existing permission requirements. Search itself performs no action.
In Code Mode: text(await tools.pwragent__tool_search({query: "handoff child thread"})). Emit the returned string directly so schemas stay intact. Then call the returned codeModeName on tools with arguments matching inputSchema. Deferred tools remain callable. Prefer a bulk tool when available; otherwise batch repeated calls in one cell and print compact aggregate results. If no tools match, retry with a more specific action; do not invent a tool name.`;

// Small domain vocabulary supplies words users use that need not appear in a
// tool's literal name. Ranking otherwise follows the live catalog, not a copy.
const SEARCH_ALIASES: Record<string, string> = {
  handoff_task: "delegate delegation child subagent split parallel tasks worktree",
  create_monitor_delegation: "job monitor polling long running command parallel tasks collect results",
  manage_thread_dependencies: "wait waiting prerequisite dependency dependencies dag notify notification continue after turn completion CI PR",
  mutate_thread: "close closing archive restore rename pin lock unlock park freeze model fast priority mode settings",
  rename_current_thread: "rename name title this thread conversation self",
  mark_project_read: "bulk batch clear dismiss unread read project folder directory repository all",
  attach_thread_directory: "link repository project folder worktree",
  move_thread_workspace: "move project folder checkout worktree",
  list_federation_instances: "federation machines computers hosts load capacity",
  list_instance_projects: "federation remote machine projects folders",
  create_instance_thread: "federation run work another remote machine computer",
  list_attention_threads: "attention needs waiting unread running review queue summarize overview",
  get_current_messaging_surface: "telegram discord slack line lark feishu mattermost messaging conversation",
  attach_thread_here: "telegram discord slack line lark feishu mattermost messaging attach topic",
  rename_current_messaging_conversation: "telegram discord slack line lark feishu mattermost rename topic",
  send_private_response: "telegram discord slack line lark feishu mattermost message private reply dm",
  send_messaging_file: "telegram discord slack line lark feishu mattermost send attachment file",
};

const STOP_WORDS = new Set(["a", "an", "and", "can", "for", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "please", "the", "to", "use", "want", "with"]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !STOP_WORDS.has(word));
}

function exactToolNames(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9_.]+/g) ?? [])
    .map((token) => token.replace(/^tools\./, "").replace(/^pwragent(?:__|\.)/, ""));
}

export function searchPwrAgentTools(catalog: DynamicToolSpec[], query: string, limit = 3) {
  const terms = [...new Set(words(query))];
  const tools = catalog.flatMap((spec) =>
    spec.type === "namespace" && spec.name === PWRAGENT_TOOL_NAMESPACE
      ? spec.tools.filter((tool) => tool.name !== "tool_search")
      : []
  );
  // A named tool is a request, not a ranking hint. The 2026-10-01 Voice
  // manager turn asked for four names with limit 2, got two, then spent six
  // more searches recovering the rest. The limit caps only ranked matches.
  const named = [...new Set(exactToolNames(query))]
    .flatMap((name) => tools.filter((tool) => tool.name === name));
  const ranked = tools.filter((tool) => !named.includes(tool)).map((tool) => {
    const name = new Set(words(tool.name));
    const aliases = new Set(words(SEARCH_ALIASES[tool.name] ?? ""));
    const description = new Set(words(tool.description));
    const score = terms.reduce((total, term) =>
      total + (name.has(term) ? 8 : aliases.has(term) ? 6 : description.has(term) ? 1 : 0), 0);
    return { tool, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map(({ tool }) => tool);
  const bounded = Math.min(5, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 3));
  return [...named, ...ranked].slice(0, Math.max(bounded, named.length))
    .map((tool) => ({
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: tool.name,
      codeModeName: `${PWRAGENT_TOOL_NAMESPACE}__${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}

export function buildPwrAgentToolSearchDefinition(
  catalog: DynamicToolSpec[],
  store?: TokenMiserStore,
): AgentToolDefinition {
  return {
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: "tool_search",
    description: PWRAGENT_TOOL_SEARCH_DESCRIPTION,
    deferLoading: false,
    advertiseMcp: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 5 },
      },
    },
    dispatch: async (args, context) => {
      if (
        typeof args.query !== "string" || !args.query.trim() || args.query.length > 500
        || (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 5))
      ) {
        return agentToolFailure({ code: "invalid_arguments", message: "Provide a nonempty query of at most 500 characters and an optional integer limit from 1 to 5." });
      }
      const result = { tools: searchPwrAgentTools(catalog, args.query, args.limit as number | undefined) };
      const visibleText = JSON.stringify(result);
      const delivery = store && context.turnId
        ? await store.prepareToolDefinitionDelivery({ threadId: context.threadId, turnId: context.turnId, visibleText })
        : undefined;
      return agentToolSuccess(result, {
        contentItems: [{ type: "inputText", text: delivery?.text ?? visibleText }],
      });
    },
  };
}

/**
 * Tools a thread with a known working set loads eagerly when discovery is on.
 * Deferring them cost the Voice manager seven searches, about two minutes,
 * before its first useful call on 2026-10-01. Everything else stays behind
 * tool_search, so keep these short: each one is sent on every turn.
 */
export const VOICE_MANAGER_EAGER_TOOLS: ReadonlySet<string> = new Set([
  // Matches the tools VOICE_MANAGER_AGENT_INSTRUCTIONS names; a test holds them together.
  "read_operator_focus",
  "search_threads",
  "send_message_to_thread",
  "steer_thread",
  "stop_thread",
  "list_attention_threads",
  "mark_project_read",
  "list_federation_instances",
  "list_instance_projects",
  "create_instance_thread",
  "get_thread_status",
  "read_thread",
]);

/** Messaging surface tools plus the most-called PwrAgent tools in the default profile's logs. */
export const MESSAGING_EAGER_TOOLS: ReadonlySet<string> = new Set([
  "get_current_messaging_surface",
  "attach_thread_here",
  "handoff_task",
  "read_thread",
  "get_thread_status",
  "check_thread_pull_request_status",
  "attach_thread_pull_request",
  "watch_thread_pull_request",
]);

/** Only parent Codex catalogs opt in; MCP and restricted helper catalogs stay unchanged. */
export function withPwrAgentToolDiscovery(
  catalog: DynamicToolSpec[],
  enabled: boolean,
  eagerTools: ReadonlySet<string> = new Set(),
): DynamicToolSpec[] {
  if (!enabled) return catalog;
  const bootstrap = new AgentToolRouter([buildPwrAgentToolSearchDefinition([])]).buildDynamicToolSpecs()[0];
  return catalog.map((spec) => {
    if (spec.type !== "namespace" || spec.name !== PWRAGENT_TOOL_NAMESPACE || bootstrap.type !== "namespace") return spec;
    return {
      ...spec,
      tools: [
        ...bootstrap.tools,
        ...spec.tools.filter((tool) => tool.name !== "tool_search")
          .map((tool) => ({ ...tool, deferLoading: !eagerTools.has(tool.name) })),
      ],
    };
  });
}
