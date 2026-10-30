import path from "node:path";
import type {
  AppServerThreadActivityDetail, AppServerThreadActivityEntry, AppServerThreadFileDiff, AppServerThreadImagePart,
  AppServerThreadPlanStep,
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

/**
 * A turn's edits as one diff with one section per file, the shape of a
 * cumulative turn diff. Repeat edits of a file append their hunks to its
 * section, so the live Edited Files row counts files, not edits.
 */
export function claudeTurnDiff(diffs: readonly string[]): string {
  const files = new Map<string, string[]>();
  for (const diff of diffs) {
    // claudeFileDiff writes three header lines, then the hunks.
    const lines = diff.split("\n");
    const section = files.get(lines[0]);
    if (section) section.push(...lines.slice(3));
    else files.set(lines[0], lines);
  }
  return [...files.values()].map((lines) => lines.join("\n")).join("\n");
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

const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The media type a base64 image's leading bytes name, for a block that omits it. */
function sniffBase64ImageType(data: string): string | undefined {
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  return undefined;
}

function claudeImageBlockPart(block: Record<string, unknown>, alt: string): AppServerThreadImagePart | undefined {
  const source = block.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return undefined;
  if (source.type === "url" && typeof source.url === "string" && /^https:\/\//iu.test(source.url)) {
    return { type: "image", url: source.url, alt };
  }
  if (source.type !== "base64" || typeof source.data !== "string" || !source.data) return undefined;
  const data = source.data.replace(/\s+/gu, "");
  const declared = typeof source.media_type === "string" ? source.media_type.toLowerCase() : undefined;
  const mediaType = declared && CLAUDE_IMAGE_TYPES.has(declared) ? declared : sniffBase64ImageType(data);
  return mediaType ? { type: "image", url: `data:${mediaType};base64,${data}`, alt } : undefined;
}

/**
 * Splits a tool result's content into the text the row shows and the images
 * it draws. Claude's replies carry no images of their own: a picture reaches
 * the transcript as an `image` block of a tool result, as when Read opens a
 * PNG or an MCP tool returns a screenshot. Other blocks stay as JSON.
 */
export function claudeToolResultContent(content: unknown, alt: string): {
  text: string; images: AppServerThreadImagePart[];
} {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content === undefined ? "" : JSON.stringify(content), images: [] };
  const text: string[] = [];
  const images: AppServerThreadImagePart[] = [];
  for (const block of content as unknown[]) {
    const record = block && typeof block === "object" ? block as Record<string, unknown> : undefined;
    if (record?.type === "text" && typeof record.text === "string") {
      text.push(record.text);
      continue;
    }
    const image = record?.type === "image" ? claudeImageBlockPart(record, alt) : undefined;
    if (image) images.push(image);
    else text.push(JSON.stringify(block));
  }
  return { text: text.join("\n"), images };
}
