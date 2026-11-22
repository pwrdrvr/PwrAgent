import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { agentToolFailure, agentToolSuccess, type AgentToolDefinition } from "./agent-tool-definition";
import { AgentToolRouter } from "./agent-tool-router";
import type { TokenMiserStore } from "../token-miser/token-miser-store";

export const PWRAGENT_TOOL_SEARCH_DESCRIPTION = `Search for PwrAgent tools before using PwrAgent capabilities. Full tool instructions and parameter schemas are loaded on demand. Prefer PwrAgent tools when they cover the task.
Search when the user wants to:
- Find, read, inspect, open/mount/navigate to threads in the graphical UI, rename, pin, lock/unlock, archive/close, restore, or change settings on threads; mark projects read in bulk; clean up old threads and worktrees; check status, activity, usage, model, fast mode, or reasoning effort; list which threads need attention on every machine.
- Delegate or hand off work to child threads, split work into parallel tasks, create a Job Monitor for a long command or repeated checks, collect results, send follow-ups, steer active work, or urgently stop a thread.
- Create or attach a worktree, link another project/repository directory, detach a directory, or move this thread into another project folder or existing checkout.
- Run work on another machine or instance through Federation; discover connected machines, their load and projects; find remote threads or create work there.
- Work with messaging in Telegram, Discord, Slack, LINE, Lark/Feishu, or Mattermost: inspect the current conversation, attach a thread or native child topic, rename a conversation, send a requested file or private response, list/export received original files for saving, or inspect/render PDF attachments. Search does not authorize sending messages.
- Read or change the messaging profile's Working Updates default.
- Open, edit, read back, comment on, review, approve or merge GitHub pull requests and GitLab merge requests, with screenshot or video attachments; read PR/MR diffs, changed files, reviews and inline review threads; reply to or resolve review comments; search, open, edit or comment on GitHub and GitLab issues.
- Read forge cache, PR/MR status, GitHub Actions runs and GitLab pipelines, logs and artifacts; rerun failed jobs; attach or watch PRs; hold merges; wait durably for standalone CI, local watcher markers, thread turns, or PR prerequisites; request or record code reviews, list unresolved findings, and settle them as addressed, declined, or deferred. Prefer these tools to GitHub connectors and gh/glab.
- Inspect automations, schedules, runs, alerts, artifacts, or failures; inspect PwrAgent version, updates, restart, or shutdown.
- Manage PwrAgent MCP connections and app access; inspect what connections a thread received.
- Discover or invoke live tools from this thread's selected MCP connections, including tools added after registration. Use search_mcp_tools and call_mcp_tool.
- Read or navigate the Star Map, locate thread cards or project clouds, highlight threads, change the map lens or filters.
- Retrieve exact output preserved by Token Miser, including searching, reading lines, or reading grouped results.
Use a short action query, or exact tool names. Each exact tool name is always returned. Search separately for unrelated tasks. Otherwise returns up to 3 matching tools (maximum 5), within an 8,000-character budget; a single larger definition stays complete. No match means the catalog lacks a matching capability. Follow returned instructions and permissions. Search performs no action.
In Code Mode: text(await tools.pwragent__tool_search({query: "handoff child thread"})). Emit the returned string directly so schemas stay intact. Then call the returned codeModeName on tools with arguments matching inputSchema. Deferred tools remain callable. Prefer a bulk tool when available; otherwise batch repeated calls in one cell and print compact aggregate results. Respect noMatchReason; do not invent tool names.`;

// Small domain vocabulary supplies words users use that need not appear in a
// tool's literal name. Ranking otherwise follows the live catalog, not a copy.
const SEARCH_ALIASES: Record<string, string> = {
  search_threads: "find list model models filter criteria",
  get_forge_status: "forge cache cached github gitlab pr mr pull merge request status checks freshness",
  list_ci_runs: "github actions gitlab ci pipelines workflow runs branch head",
  get_ci_run: "github actions gitlab ci failure pipeline jobs summary",
  get_ci_job: "github actions gitlab ci job failed steps",
  rerun_failed_ci_jobs: "github actions gitlab ci retry rerun re-run restart failed jobs workflow run pipeline",
  read_ci_job_log: "github actions gitlab ci failure pipeline logs trace failed job earlier paging large output",
  get_commit_checks: "github gitlab commit checks check runs status contexts external ci failures",
  list_ci_artifacts: "github actions gitlab ci pipeline workflow artifacts metadata expiry sizes reports",
  download_ci_artifact: "github actions ci pipeline workflow artifact artifacts download zip archive report playwright trace screenshot video",
  get_pull_request: "github gitlab mr merge request pr pull request read back fetch view body description details head sha mergeable",
  list_pull_requests: "github gitlab mr merge request pr pull requests list open branch",
  list_pull_request_files: "github gitlab mr merge request pr pull request changed files filenames list",
  get_pull_request_diff: "github gitlab mr merge request pr pull request diff patch changes",
  list_pull_request_reviews: "github gitlab mr merge request pr pull request reviews approved changes requested",
  list_pull_request_review_threads: "github gitlab mr merge request pr pull request review comments threads inline unresolved feedback",
  get_issue: "github gitlab issue read fetch view",
  list_issue_comments: "github gitlab issue pr pull request conversation comments",
  search_issues: "github gitlab search issues pull requests prs find",
  create_pull_request: "github gitlab mr merge request pr open create new pull request draft attach screenshot image video",
  update_pull_request: "github gitlab mr merge request pr edit update pull request title body description ready draft close reopen labels reviewers attach screenshot",
  add_issue_comment: "github gitlab pr pull request issue comment post reply attach screenshot",
  reply_to_review_comment: "github gitlab mr merge request pr pull request review comment reply respond feedback",
  submit_pull_request_review: "github gitlab mr merge request pr pull request review approve request changes inline comments",
  resolve_review_thread: "github gitlab mr merge request pr pull request review thread resolve unresolve conversation",
  create_issue: "github gitlab issue open create new file bug",
  update_issue: "github gitlab issue edit update close reopen labels",
  merge_pull_request: "github gitlab mr merge request pr pull request merge squash rebase land",
  handoff_task: "delegate delegation child subagent split parallel tasks worktree",
  create_monitor_delegation: "job monitor polling long running command parallel tasks collect results",
  watch_thread_pull_request: "wake notify stop cancel list watches watching",
  manage_thread_dependencies: "wait waiting prerequisite dependency dependencies dag notify notification continue after turn completion compaction compact recovery instruction reread subscription hook CI PR remind reminder operator todo mark done blocked hold merge do not merge until finishes follow up checklist peer local_file watch existing watcher marker terminal file",
  agent_memory: "memory index notes progress lessons already reported past attempts durable",
  schedule_follow_up: "schedule later remind reminder wake timer time delay follow up check back again in minutes hours tomorrow sleep wait until cron loop one-shot survive restart cancel list",
  mutate_thread: "close closing archive restore rename pin lock unlock park freeze model fast priority mode settings",
  rename_current_thread: "rename name title this thread conversation self",
  mark_project_read: "bulk batch clear dismiss unread read project folder directory repository all",
  // A single-thread archive stays with mutate_thread; these cover bulk cleanup.
  scan_thread_maintenance: "find clean cleanup old stale idle inactive unused worktrees checkouts disk space free maintenance bulk hibernate",
  apply_thread_maintenance: "run apply selected bulk archiving cleanup remove worktrees checkouts maintenance hibernate hibernation",
  open_thread_maintenance: "open show dialog window review cleanup maintenance",
  attach_thread_directory: "link repository project folder worktree",
  move_thread_workspace: "move project folder checkout worktree",
  register_thread_worktree: "register authorize adopt ownership external existing outside checkout worktree maintenance snapshot cleanup revoke unregister",
  list_federation_instances: "federation machines computers hosts load capacity",
  list_instance_projects: "federation remote machine projects folders",
  create_instance_thread: "federation run work another remote machine computer",
  list_attention_threads: "attention needs waiting unread running review queue summarize overview",
  get_current_messaging_surface: "telegram discord slack line lark feishu mattermost messaging conversation",
  get_messaging_working_updates_default: "read show current profile settings working updates default bound threads",
  set_messaging_working_updates_default: "change set save profile settings working updates default none mute bound threads",
  attach_thread_here: "telegram discord slack line lark feishu mattermost messaging attach topic",
  rename_current_messaging_conversation: "telegram discord slack line lark feishu mattermost rename topic",
  send_private_response: "telegram discord slack line lark feishu mattermost message private reply dm",
  send_messaging_file: "telegram discord slack line lark feishu mattermost send attachment file",
  list_messaging_attachments: "telegram discord slack line lark feishu mattermost received original attachment file pdf list save copy download",
  export_messaging_attachment: "telegram discord slack line lark feishu mattermost received original attachment file pdf save copy download export bytes folder",
  // Registered OpenAI Decisions. People ask for "a decision model", "a
  // classifier" or "a rubric", in the singular, rather than for the tool names.
  decisions_register: "decision decisions decide model prompt rubric classifier classify judge evaluate evaluator grade score predicate choice create define save reusable jev typesafe clef local",
  decisions_list: "decision decisions registered existing available show prompts models",
  decisions_invoke: "decision decisions decide run evaluate classify classifier judge grade score answer test new input jev typesafe clef",
  decisions_update: "decision decisions edit change revise rubric prompt version",
  decisions_delete: "decision decisions remove retire",
  decisions_batch_results: "decision decisions batch results answers read page progress status background failed skipped",
  decisions_batch_cancel: "decision decisions batch cancel stop abort background",
};

const STOP_WORDS = new Set(["a", "an", "and", "can", "for", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "please", "the", "to", "use", "want", "with"]);
const RANKED_RESULT_CHARACTER_BUDGET = 8_000;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !STOP_WORDS.has(word));
}

function exactToolNames(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9_.]+/g) ?? [])
    .map((token) => token.replace(/^tools\./, "").replace(/^pwragent(?:__|\.)/, ""));
}

function hasAnyWord(terms: ReadonlySet<string>, text: string): boolean {
  return words(text).some((word) => terms.has(word));
}

function preferredWaitTool(query: string): string | undefined {
  const normalized = query.trim().toLowerCase().replace(/^please\s+/, "");
  if (/^job[ -]+monitor(?:\s+for\b|\s*[.!?]?$)/.test(normalized)
    || /^(?:create|start|launch|use)\s+(?:(?:a|the)\s+)?job[ -]+monitor\b/.test(normalized)) {
    return "create_monitor_delegation";
  }
  if (normalized === "ci_run") return "manage_thread_dependencies";
  // Match the requested action, since a status read can mention waiting jobs.
  const waitTarget = normalized.match(/^(?:wait(?:ing)?|watch(?:ing)?|monitor(?:ing)?|notify|notification|wake|poll(?:ing)?)\s+(.+)/)?.[1];
  if (!waitTarget) return undefined;
  if (/\b(?:with|using)\s+(?:(?:a|the)\s+)?job[ -]+monitor\b/.test(waitTarget)) {
    return "create_monitor_delegation";
  }
  if (/(?:^|\b(?:for|of|on)\s+)(?:(?:my|the|this|an?)\s+)?attached\s+(?:pr|mr|pull request|merge request)\b/.test(waitTarget)) {
    return "watch_thread_pull_request";
  }
  const terms = new Set(words(waitTarget));
  if (/\/(?:actions\/runs|-\/pipelines)\/\d+\b/.test(normalized)
    || (/\bgithub actions\b/.test(normalized) && hasAnyWord(terms, "run runs workflow workflows"))
    || (/\bgitlab\b/.test(normalized) && hasAnyWord(terms, "pipeline pipelines"))
    || (terms.has("ci") && hasAnyWord(terms, "standalone release") && hasAnyWord(terms, "run runs"))) {
    return "manage_thread_dependencies";
  }
  return undefined;
}

function isRuntimeModelDiscoveryQuery(query: string): boolean {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const terms = new Set(words(query));
  // Threads can be the requested objects, with models as their filter. Keep
  // that distinct from model enumeration, including when availability is
  // mentioned in the criterion. A singular "current thread" can still be
  // context for the original request to inspect available runtime models.
  const requestsThreads = /\b(?:list|find|search|show|get|read|inspect|discover|enumerate)\s+(?:(?:all|my|our|the|current|recent|running|archived|coding|agent)\s+)*threads\b/.test(normalized)
    || /\bthreads?\s+(?:by|using|with|running|on|matching|filtered)\b/.test(normalized);
  return !requestsThreads && (
    hasAnyWord(terms, "model models")
    || (hasAnyWord(terms, "provider providers") && hasAnyWord(terms, "agent agents runtime subscription subscriptions"))
  )
    && (
      hasAnyWord(terms, "available availability list supported options enumerate catalog")
      || (hasAnyWord(terms, "models providers") && hasAnyWord(terms, "show inspect read get find discover which"))
    )
    && !hasAnyWord(terms, "change set switch select configure update register create delete remove")
    && !hasAnyWord(terms, "decision decisions classifier classifiers rubric rubrics judge evaluator");
}

function describesRuntimeModelDiscovery(tool: { name: string; description: string }): boolean {
  const name = new Set(words(tool.name));
  // A mention in an example, optional setting, or cross-reference is not a
  // capability. Use the tool's own name and opening purpose statement.
  const purpose = new Set(words(`${tool.name} ${tool.description.split(/[.!?](?:\s|$)/, 1)[0]}`));
  return hasAnyWord(name, "list get read inspect search discover enumerate")
    && hasAnyWord(purpose, "model models provider providers")
    && !hasAnyWord(purpose, "decision decisions");
}

export function searchPwrAgentTools(catalog: DynamicToolSpec[], query: string, limit = 3) {
  const terms = [...new Set(words(query))];
  const runtimeModelDiscovery = isRuntimeModelDiscoveryQuery(query);
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
  const preferred = preferredWaitTool(query);
  const ranked = tools.filter((tool) => !named.includes(tool)
    && (!runtimeModelDiscovery || describesRuntimeModelDiscovery(tool))).map((tool) => {
    const name = new Set(words(tool.name));
    const aliases = new Set(words(SEARCH_ALIASES[tool.name] ?? ""));
    const description = new Set(words(tool.description));
    const score = terms.reduce((total, term) =>
      total + (name.has(term) ? 8 : aliases.has(term) ? 6 : description.has(term) ? 1 : 0), 0);
    return { tool, score, preferred: tool.name === preferred };
  }).filter((match) => match.preferred || match.score > 0)
    .sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map(({ tool }) => tool);
  const bounded = Math.min(5, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 3));
  const definitionFor = (tool: typeof tools[number]) => ({
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: tool.name,
    codeModeName: `${PWRAGENT_TOOL_NAMESPACE}__${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
  // Explicit names are requests, including their complete schemas. Only
  // ranked fill is budgeted, and its first result must remain callable even
  // when that one definition exceeds the budget by itself.
  const result = named.map(definitionFor);
  let characters = JSON.stringify({ tools: result }).length;
  for (const tool of ranked) {
    if (result.length >= Math.max(bounded, named.length)) break;
    const definition = definitionFor(tool);
    const addedCharacters = JSON.stringify(definition).length + (result.length ? 1 : 0);
    if (result.length && characters + addedCharacters > RANKED_RESULT_CHARACTER_BUDGET) break;
    result.push(definition);
    characters += addedCharacters;
  }
  return result;
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
      const tools = searchPwrAgentTools(catalog, args.query, args.limit as number | undefined);
      const result = {
        tools,
        ...(!tools.length ? {
          noMatchReason: isRuntimeModelDiscoveryQuery(args.query)
            ? "No tool in this thread's catalog lists available runtime models or subscription providers. Thread settings and registered decisions do not provide that capability."
            : "No matching tool in this thread's catalog. Try a more specific action or an exact tool name.",
        } : {}),
      };
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
  "open_thread",
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
