import path from "node:path";
import type {
  AppServerThreadActivityDetail, AppServerThreadActivityEntry, AppServerThreadFileDiff, AppServerThreadPlanStep,
} from "@pwragent/shared";

/** Claude's checklist tool. Its calls are the turn's plan, not tool rows. */
export const CLAUDE_TODO_TOOL = "TodoWrite";

/** Larger diffs keep their counts, not their text. */
const MAX_DIFF_CHARS = 256 * 1024;

type ActivityStatus = AppServerThreadActivityEntry["status"];

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function inPath(input: Record<string, unknown>): string {
  const target = stringField(input, "path");
  return target ? ` in ${path.basename(target)}` : "";
}

/**
 * Names what a call of one of Claude Code's own file and web tools reads or
 * changes. Other tools keep the generic row with their input.
 */
export function claudeToolDetail(params: {
  id: string; name: string; input: Record<string, unknown>; status: ActivityStatus;
}): AppServerThreadActivityDetail | undefined {
  const { id, input, status } = params;
  const file = stringField(input, "file_path") ?? stringField(input, "notebook_path");
  switch (params.name) {
    case "Read":
      return file ? { id, kind: "read", label: `Read ${path.basename(file)}`, path: file, status } : undefined;
    case "Glob": {
      const pattern = stringField(input, "pattern");
      return pattern ? { id, kind: "read", label: `Listed ${pattern}${inPath(input)}`, status } : undefined;
    }
    case "Grep": {
      const pattern = stringField(input, "pattern");
      return pattern ? { id, kind: "read", label: `Searched for ${pattern}${inPath(input)}`, status } : undefined;
    }
    case "WebSearch": {
      const query = stringField(input, "query");
      return query ? { id, kind: "read", label: `Searched the web for ${query}`, status } : undefined;
    }
    case "WebFetch": {
      const url = stringField(input, "url");
      return url ? { id, kind: "read", label: `Fetched ${url}`, url, status } : undefined;
    }
    case "Edit":
    case "NotebookEdit":
      return file ? { id, kind: "write", label: `Edited ${path.basename(file)}`, path: file, status } : undefined;
    case "Write":
      return file ? { id, kind: "write", label: `Wrote ${path.basename(file)}`, path: file, status } : undefined;
    default:
      return undefined;
  }
}

type StructuredHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

function readHunks(value: unknown): StructuredHunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks = value.filter((hunk): hunk is StructuredHunk => Boolean(hunk) && typeof hunk === "object"
    && ["oldStart", "oldLines", "newStart", "newLines"].every((key) => typeof (hunk as Record<string, unknown>)[key] === "number")
    && Array.isArray((hunk as { lines?: unknown }).lines));
  return hunks.length === value.length ? hunks : undefined;
}

/**
 * The unified diff of a successful Edit or Write, from the structured patch
 * in its tool result. A new file whose patch is empty diffs its content.
 */
export function claudeFileDiff(result: unknown, cwd: string): { diff: string; fileDiff: AppServerThreadFileDiff } | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const filePath = typeof record.filePath === "string" ? record.filePath : undefined;
  let hunks = readHunks(record.structuredPatch);
  if (!filePath || !hunks) return undefined;
  const created = record.type === "create";
  if (created && hunks.length === 0 && typeof record.content === "string") {
    const lines = record.content.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) }];
  }
  if (hunks.length === 0) return undefined;
  const relative = path.relative(cwd, filePath);
  const name = (relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath)
    .split(path.sep).join("/").replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
  let additions = 0;
  let removals = 0;
  const body: string[] = [];
  for (const hunk of hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) removals += 1;
      body.push(line);
    }
  }
  const diff = [
    `diff --git a/${name} b/${name}`,
    created ? "--- /dev/null" : `--- a/${name}`,
    `+++ b/${name}`,
    ...body,
  ].join("\n");
  const kind = created ? "add" : "update";
  if (diff.length > MAX_DIFF_CHARS) {
    return { diff: "", fileDiff: { kind, diff: "", additions, removals, omittedReason: "This diff is too large to show.", originalLength: diff.length } };
  }
  return { diff, fileDiff: { kind, diff, additions, removals } };
}

/** The steps of a TodoWrite call, as a plan. */
export function claudeTodoSteps(input: unknown): AppServerThreadPlanStep[] | undefined {
  const todos = input && typeof input === "object" ? (input as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((todo): AppServerThreadPlanStep[] => {
    if (!todo || typeof todo !== "object") return [];
    const { content, status } = todo as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || !content.trim()) return [];
    return [{
      step: content,
      status: status === "completed" || status === "in_progress" ? status : "pending",
    }];
  });
}
