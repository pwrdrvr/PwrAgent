import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadTitleAdapterResult } from "@pwragent/owner-core/thread-title-generation-service";
import { claudeTurnUsage } from "./claude-usage";

export type ClaudeExcerptRequest = {
  model?: string;
  reasoningEffort?: string;
  system?: string;
  prompt: string;
  schema: Record<string, unknown>;
  isMatch: (record: Record<string, unknown>) => boolean;
  signal?: AbortSignal;
};

export async function runClaudeExcerptQuery(
  start: typeof query, request: ClaudeExcerptRequest, harness: Options, cwd: string,
): Promise<ThreadTitleAdapterResult> {
  if (!request.model || request.signal?.aborted) return { status: "unavailable", reason: "no_active_helper" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const effort = request.reasoningEffort;
  const options: Options = {
    ...harness, cwd, model: request.model,
    ...(effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max" ? { effort } : {}),
    systemPrompt: request.system, tools: [], strictMcpConfig: true, mcpServers: {}, plugins: [],
    settingSources: ["user"], settings: { disableAllHooks: true, disableSkillShellExecution: true },
    canUseTool: async () => ({ behavior: "deny", message: "This capture summarizer has no tools." }),
    persistSession: false, maxTurns: 1, abortController: controller,
  };
  const session = start({ prompt: request.prompt + "\nReturn only JSON matching " + JSON.stringify(request.schema), options });
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const message of session) {
      if (message.type !== "result") continue;
      const usage = claudeTurnUsage(message.modelUsage);
      const reportedCost = message.total_cost_usd ?? (Object.values(message.modelUsage).some(row => Number.isFinite(row.costUSD))
        ? usage.claudeCostUSD : undefined);
      const inference = {
        model: usage.model || request.model, reasoningEffort: options.effort?.toString(),
        ...(usage.last.totalTokens > 0 || (reportedCost ?? 0) > 0
          ? { tokenUsage: { ...usage, claudeCostUSD: reportedCost } } : {}),
        helperThreadId: message.session_id,
      };
      if (message.subtype !== "success") return { status: "failed", reason: message.subtype, ...inference };
      let answer: unknown;
      try { answer = JSON.parse(message.result); } catch { /* Invalid answers use the local summary. */ }
      return {
        status: "ok", object: answer && typeof answer === "object" && !Array.isArray(answer)
          && request.isMatch(answer as Record<string, unknown>) ? answer : undefined,
        ...inference,
      };
    }
    return { status: "failed", reason: "no_summary_result" };
  } finally {
    request.signal?.removeEventListener("abort", abort);
    session.close();
  }
}
