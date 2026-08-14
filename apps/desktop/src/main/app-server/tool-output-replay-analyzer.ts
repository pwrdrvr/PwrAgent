import type {
  AppServerBackendKind,
  AppServerThreadActivityDetail,
  AppServerThreadReplay,
  ThreadToolAnalysisCoverage,
  ThreadToolInvocationCategory,
  ThreadToolInvocationRecord,
} from "@pwragent/shared";
import {
  buildToolInvocationSteeringPrompt,
  buildToolOutputMetrics,
  normalizeToolInvocationCommand,
} from "./tool-invocation-accounting";

export const TOOL_OUTPUT_ANALYZER_VERSION = "1";
const LARGE_OUTPUT_CHARS = 4_000;
const CRITICAL_OUTPUT_CHARS = 40_000;
const POLLING_MIN_CASES = 5;

export type ToolOutputReplayAnalysis = {
  coverage: ThreadToolAnalysisCoverage;
  invocations: ThreadToolInvocationRecord[];
};

export function analyzeNormalizedToolReplay(params: {
  analyzedAt?: number;
  backend: AppServerBackendKind;
  complete: boolean;
  pages: AppServerThreadReplay[];
  threadId: string;
}): ToolOutputReplayAnalysis {
  const analyzedAt = params.analyzedAt ?? Date.now();
  const invocationsById = new Map<string, ThreadToolInvocationRecord>();
  const seenEntryIds = new Set<string>();
  const missingOutputIds = new Set<string>();
  let scannedThrough: string | undefined;

  for (const replay of params.pages) {
    for (const entry of replay.entries) {
      seenEntryIds.add(entry.id);
      scannedThrough = entry.id;
      if (entry.type !== "activity") {
        continue;
      }
      for (const detail of entry.details) {
        if (!detail.command) {
          continue;
        }
        const outputState = readOutputState(detail);
        const metrics = buildToolOutputMetrics(detail.command.output, {
          outputTruncated: outputState === "truncated",
        });
        const toolName = toolNameForDetail(detail);
        const normalized = normalizeToolInvocationCommand({
          command: detail.command.rawCommand ?? detail.command.displayCommand,
          toolName,
        });
        const category = categoryForReplayDetail(detail, normalized.category);
        const observedAt = entry.createdAt ?? entry.turn?.completedAt
          ?? entry.turn?.startedAt ?? analyzedAt;
        const invocationId = deterministicFindingId([
          params.backend,
          params.threadId,
          entry.turn?.id ?? "no-turn",
          entry.id,
          detail.id,
        ]);
        if (outputState === "unavailable" || outputState === "compacted") {
          missingOutputIds.add(invocationId);
        } else {
          missingOutputIds.delete(invocationId);
        }
        const reason = classifyNoisyReason({
          category,
          outputChars: metrics.outputChars,
          outputState,
        });
        const invocation: ThreadToolInvocationRecord = {
          ...metrics,
          backend: params.backend,
          category,
          ...(entry.turn?.completedAt ? { completedAt: entry.turn.completedAt } : {}),
          ...(detail.command.exitCode !== undefined
            ? { exitCode: detail.command.exitCode }
            : {}),
          findingId: invocationId,
          invocationId,
          itemId: entry.id,
          noisy: Boolean(reason),
          ...(reason ? { noisyReason: reason } : {}),
          ...(normalized.normalizedCommand
            ? { normalizedCommand: normalized.normalizedCommand }
            : {}),
          observedAt,
          outputState,
          source: "history",
          status: activityStatusToInvocationStatus(detail.status ?? entry.status),
          ...(entry.turn?.startedAt ? { startedAt: entry.turn.startedAt } : {}),
          threadId: params.threadId,
          toolName,
          ...(entry.turn?.id ? { turnId: entry.turn.id } : {}),
          updatedAt: analyzedAt,
          outputTruncated: outputState === "truncated",
        };
        invocationsById.set(
          invocationId,
          reason
            ? {
                ...invocation,
                suggestedPrompt: buildToolInvocationSteeringPrompt({
                  invocation,
                  reason: humanizeReason(reason),
                }),
              }
            : invocation,
        );
      }
    }
  }

  const invocations = [...invocationsById.values()];
  markRepeatedPolling(invocations);
  const entryCount = seenEntryIds.size;
  const missingOutputCount = missingOutputIds.size;
  const complete = params.complete && missingOutputCount === 0;
  const explanation = complete
    ? undefined
    : missingOutputCount > 0
      ? `${missingOutputCount.toLocaleString()} tool result${missingOutputCount === 1 ? " was" : "s were"} unavailable or compacted in normalized replay, so totals are a lower bound.`
      : "The App Server did not provide complete replay pagination, so totals cover only the available normalized history.";
  return {
    coverage: {
      analyzedAt,
      analyzerVersion: TOOL_OUTPUT_ANALYZER_VERSION,
      completeness: complete ? "complete" : "partial",
      entryCount,
      invocationCount: invocations.length,
      missingOutputCount,
      pageCount: params.pages.length,
      ...(scannedThrough ? { scannedThrough } : {}),
      ...(explanation ? { explanation } : {}),
    },
    invocations,
  };
}

function readOutputState(
  detail: AppServerThreadActivityDetail,
): ThreadToolInvocationRecord["outputState"] {
  const output = detail.command?.output;
  const context = [detail.label, detail.markdown, output].filter(Boolean).join(" ");
  if (/compact(?:ed|ion)|removed from context/i.test(context)) {
    return "compacted";
  }
  if (/truncated|additional lines omitted|output clipped/i.test(context)) {
    return "truncated";
  }
  return output === undefined ? "unavailable" : "available";
}

function toolNameForDetail(detail: AppServerThreadActivityDetail): string {
  if (detail.command?.source === "tool") {
    return /^mcp__|\bmcp\b/i.test(detail.command.displayCommand)
      ? "mcpToolCall"
      : "toolCall";
  }
  if (detail.command?.source === "agent") {
    return "subAgent";
  }
  return "commandExecution";
}

function categoryForReplayDetail(
  detail: AppServerThreadActivityDetail,
  category: ThreadToolInvocationCategory,
): ThreadToolInvocationCategory {
  if (
    detail.command?.source === "tool"
    && /^mcp__|\bmcp\b/i.test(detail.command.displayCommand)
  ) {
    return "mcp";
  }
  return category;
}

function classifyNoisyReason(params: {
  category: ThreadToolInvocationCategory;
  outputChars: number;
  outputState: ThreadToolInvocationRecord["outputState"];
}): string | undefined {
  if (params.outputChars >= CRITICAL_OUTPUT_CHARS) {
    return "large-output-critical";
  }
  if (params.outputChars < LARGE_OUTPUT_CHARS) {
    return undefined;
  }
  if (params.category === "file-io") return "broad-file-read";
  if (params.category === "search") return "broad-search";
  if (params.category === "build-test" || params.category === "package-manager") {
    return "verbose-build-test";
  }
  if (params.category === "mcp") return "broad-mcp-result";
  return params.outputState === "truncated"
    ? "large-truncated-output"
    : "large-output";
}

function humanizeReason(reason: string): string {
  return reason.replaceAll("-", " ");
}

function activityStatusToInvocationStatus(
  status: AppServerThreadActivityDetail["status"],
): ThreadToolInvocationRecord["status"] {
  if (status === "in_progress") return "in_progress";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

function markRepeatedPolling(invocations: ThreadToolInvocationRecord[]): void {
  const byTurn = new Map<string, ThreadToolInvocationRecord[]>();
  for (const invocation of invocations) {
    if (invocation.category !== "polling") continue;
    const key = invocation.turnId ?? "no-turn";
    byTurn.set(key, [...(byTurn.get(key) ?? []), invocation]);
  }
  for (const records of byTurn.values()) {
    if (records.length < POLLING_MIN_CASES) continue;
    for (const record of records) {
      record.noisy = true;
      record.noisyReason = "repeat-polling-output";
      record.suggestedPrompt = buildToolInvocationSteeringPrompt({
        invocation: record,
        reason: "repeated polling wakes the model and replays accumulated context",
      });
    }
  }
}

function deterministicFindingId(parts: string[]): string {
  let hash = 2166136261;
  const identity = parts.join("\u001f");
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `history-tool:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
