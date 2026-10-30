import type { AppServerThreadActivityEntry, AppServerThreadEntry } from "@pwragent/shared";
import { summarizeToolActivityItems } from "../app-server/thread-activity";
import { claudeSavedToolOutput, claudeToolCallDetail } from "./claude-tool-activity";

/** Use the same shell-command detail shape as the other native backends. */
export function claudeCommandActivity(params: {
  id: string; command: string; status: AppServerThreadActivityEntry["status"]; output?: string;
}): AppServerThreadActivityEntry {
  return {
    ...summarizeToolActivityItems([{
      id: params.id, type: "commandExecution", command: params.command,
      status: params.status, aggregatedOutput: params.output,
    }])!,
    id: params.id,
    status: params.status,
  };
}

function normalizeSavedCommand(entry: AppServerThreadActivityEntry): AppServerThreadActivityEntry {
  if (entry.summary !== "Bash" || entry.details[0]?.command) return entry;
  // Older Claude replays kept invocation JSON in the first detail. Recover it
  // on read without rewriting history. The earliest output-only records cannot
  // recover a command that was never saved.
  try {
    const input: unknown = JSON.parse(entry.details[0]?.markdown ?? "");
    if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") return entry;
    const output = entry.details.find((detail) => detail.id === `${entry.id}:output`)?.markdown;
    return {
      ...entry,
      ...claudeCommandActivity({ id: entry.id, command: input.command, status: entry.status, output }),
      createdAt: entry.createdAt,
    };
  } catch {
    return entry;
  }
}

/**
 * Older replays kept any other tool's call as its input JSON under its raw
 * name, and a non-string result as the result's JSON. Show both as the named
 * tool row a new call gets, without rewriting history.
 */
function normalizeSavedToolCall(entry: AppServerThreadActivityEntry): AppServerThreadActivityEntry {
  const [first] = entry.details;
  if (!first || first.command || first.path || first.url || first.id !== entry.id
    || first.label !== entry.summary || /\s/u.test(entry.summary)) return entry;
  let input: unknown;
  try { input = JSON.parse(first.markdown ?? ""); }
  catch { return entry; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return entry;
  const saved = entry.details.find((detail) => detail.id === `${entry.id}:output`);
  const { text, images } = claudeSavedToolOutput(saved?.markdown, entry.summary);
  const detail = claudeToolCallDetail({
    id: entry.id, name: entry.summary, input: input as Record<string, unknown>, status: entry.status,
    output: text, images: [...saved?.images ?? [], ...images],
  });
  return { ...entry, summary: detail.label, details: [detail] };
}

/** A built-in tool's saved output whose result kept its images as JSON. */
function normalizeSavedOutputs(entry: AppServerThreadActivityEntry): AppServerThreadActivityEntry {
  if (!entry.details.some((detail) => detail.id.endsWith(":output") && detail.markdown?.startsWith("[{"))) return entry;
  return { ...entry, details: entry.details.map((detail) => {
    if (!detail.id.endsWith(":output") || !detail.markdown?.startsWith("[{")) return detail;
    const { text, images } = claudeSavedToolOutput(detail.markdown, entry.summary);
    if (!images.length && text === detail.markdown) return detail;
    const { markdown: _markdown, ...rest } = detail;
    return {
      ...rest,
      ...(text || !images.length ? { markdown: text } : {}),
      ...(images.length ? { images: [...detail.images ?? [], ...images] } : {}),
    };
  }) };
}

function normalizeSavedActivity(entry: AppServerThreadActivityEntry): AppServerThreadActivityEntry {
  return normalizeSavedOutputs(normalizeSavedToolCall(normalizeSavedCommand(entry)));
}

function isClaudeNotice(entry: AppServerThreadActivityEntry): boolean {
  return entry.id.startsWith("notice:");
}

/** Fold consecutive calls, retaining every detail and each conversation boundary. */
export function groupClaudeActivities(entries: AppServerThreadEntry[]): AppServerThreadEntry[] {
  const grouped: AppServerThreadEntry[] = [];
  let callCount = 0;
  for (const rawEntry of entries) {
    const entry = rawEntry.type === "activity" ? normalizeSavedActivity(rawEntry) : rawEntry;
    const previous = grouped.at(-1);
    // A notice, such as a compaction, is its own row, never a folded tool.
    if (entry.type !== "activity" || previous?.type !== "activity" || isClaudeNotice(entry) || isClaudeNotice(previous)
      || !entry.turn?.id || previous.turn?.id !== entry.turn.id) {
      grouped.push(entry);
      callCount = entry.type === "activity" ? 1 : 0;
      continue;
    }
    callCount += 1;
    const details = [...previous.details, ...entry.details];
    const statuses = [previous.status, entry.status];
    const status = statuses.includes("failed") ? "failed"
      : statuses.includes("in_progress") ? "in_progress"
      : statuses.includes("cancelled") ? "cancelled" : entry.status;
    const allCommands = details.every((detail) => detail.command && detail.command.source !== "tool");
    grouped[grouped.length - 1] = {
      ...previous, details, status,
      summary: allCommands ? `Ran ${callCount} commands` : `Used ${callCount} tools`,
    };
  }
  return grouped;
}
