import path from "node:path";
import type {
  AppServerThreadActivityDetail, AppServerThreadActivityEntry, AppServerThreadFileDiff, AppServerThreadImagePart,
  AppServerThreadPlanStep,
} from "@pwragent/shared";
import { formatToolIdentifier, formatToolInvocation } from "../../shared/tool-activity";

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

/** An https link the row may open. A link carrying credentials is not one. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's artifact tools, which publish and read pages on claude.ai.
 * `Artifact` takes every action; the others take a family of them.
 */
export const CLAUDE_ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  "Artifact", "ArtifactComments", "ArtifactData", "ArtifactCheck",
]);

type ArtifactRow = { kind: "read" | "write"; label: string };

/** `Artifact` actions, as the bundled Claude Code 2.1.303 names them. */
const ARTIFACT_ACTIONS: Record<string, ArtifactRow> = {
  list: { kind: "read", label: "Listed artifacts" },
  read: { kind: "read", label: "Read an artifact" },
  list_types: { kind: "read", label: "Listed artifact types" },
  quickstart: { kind: "read", label: "Read how to start an artifact" },
  describe_type: { kind: "read", label: "Read an artifact type" },
  list_files: { kind: "read", label: "Listed an artifact's files" },
  read_file: { kind: "read", label: "Read an artifact's file" },
  list_assets: { kind: "read", label: "Listed an artifact's files" },
  read_asset: { kind: "read", label: "Read an artifact's file" },
  upload_asset: { kind: "write", label: "Uploaded a file to an artifact" },
  delete_asset: { kind: "write", label: "Deleted a file from an artifact" },
  comments: { kind: "read", label: "Read artifact comments" },
  reply: { kind: "write", label: "Replied to an artifact comment" },
  resolve: { kind: "write", label: "Resolved an artifact comment" },
  read_page_data: { kind: "read", label: "Read an artifact's page data" },
  read_db: { kind: "read", label: "Read artifact data" },
  write_db: { kind: "write", label: "Wrote artifact data" },
  verify: { kind: "read", label: "Checked an artifact" },
  preview: { kind: "read", label: "Previewed an artifact" },
  delete: { kind: "write", label: "Deleted an artifact" },
  pin: { kind: "write", label: "Pinned an artifact" },
  unpin: { kind: "write", label: "Unpinned an artifact" },
  share: { kind: "write", label: "Changed who can see an artifact" },
};

/** The `Artifact` action a call takes; a family tool's action maps onto one. */
export function claudeArtifactAction(name: string, input: Record<string, unknown>): string {
  const action = stringField(input, "action");
  switch (name) {
    case "ArtifactComments":
      return action === "read" || action === undefined ? "comments" : action;
    case "ArtifactData":
      return action && ["get", "list", "query", "profiles"].includes(action) ? "read_db" : "write_db";
    case "ArtifactCheck":
      return action ?? "verify";
    default:
      return action ?? "publish";
  }
}

/**
 * An artifact call's row. A deleted artifact's link no longer opens, so it
 * gets none. No row takes the source file as its path: publishing does not
 * change the file.
 */
function claudeArtifactDetail(params: {
  id: string; name: string; input: Record<string, unknown>; status: ActivityStatus;
}): AppServerThreadActivityDetail | undefined {
  const { id, name, input, status } = params;
  const action = claudeArtifactAction(name, input);
  const url = action === "delete" ? undefined : httpsUrl(input.url);
  if (action === "publish") {
    const file = stringField(input, "file_path");
    const title = stringField(input, "title") ?? (file ? path.basename(file) : undefined);
    return { id, kind: "write", label: title ? `Published ${title}` : "Published an artifact", ...(url ? { url } : {}), status };
  }
  const row = ARTIFACT_ACTIONS[action];
  return row ? { id, kind: row.kind, label: row.label, ...(url ? { url } : {}), status } : undefined;
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** The page a publish or read result names. */
function artifactPage(action: string, result: unknown): { url: string; title?: string } | undefined {
  if (action !== "publish" && action !== "read") return undefined;
  const record = resultRecord(result);
  const page = resultRecord(action === "read" ? record?.read : record);
  const url = httpsUrl(page?.url);
  return page && url ? { url, title: stringField(page, "title") } : undefined;
}

/**
 * Artifact actions whose result the operator reads: listings, comments, data,
 * and where a downloaded file was saved. Any other result, such as a
 * quickstart's or a publish's, is written for the model, and a read returns
 * the page's raw HTML.
 */
const ARTIFACT_OPERATOR_OUTPUT = new Set([
  "list", "comments", "read_db", "list_files", "list_assets", "read_file", "read_asset",
]);

/**
 * Whether a successful artifact call's row shows the result text: when the
 * text is for the operator, or when the result does not confirm what the
 * row says. A publish or read with no readable page keeps the text that
 * names it, and a delete keeps it unless the result says it deleted.
 */
export function claudeArtifactShowsOutput(action: string, result: unknown): boolean {
  if (ARTIFACT_OPERATOR_OUTPUT.has(action)) return true;
  if (action === "publish" || action === "read") return !artifactPage(action, result);
  if (action === "delete") return resultRecord(resultRecord(result)?.artifact_delete)?.deleted !== true;
  return false;
}

/**
 * The row of an artifact call Claude Code answered. A publish, including one
 * that creates an artifact from a type, names the page and links to it. A
 * read names the page it read.
 */
export function claudeArtifactResult(
  detail: AppServerThreadActivityDetail, action: string, result: unknown,
): AppServerThreadActivityDetail | undefined {
  const page = artifactPage(action, result);
  if (!page) return undefined;
  const verb = action === "read" ? "Read" : "Published";
  return { ...detail, url: page.url, ...(page.title ? { label: `${verb} ${page.title}` } : {}) };
}

/**
 * Names what a call of one of Claude Code's own file, web and artifact tools
 * reads or changes. Other tools keep the generic row with their input.
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
      return CLAUDE_ARTIFACT_TOOLS.has(params.name) ? claudeArtifactDetail(params) : undefined;
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
    // ToolSearch answers with the tools it loaded.
    if (record?.type === "tool_reference" && typeof record.tool_name === "string") {
      text.push(claudeToolIdentifier(record.tool_name).identifier);
      continue;
    }
    const image = record?.type === "image" ? claudeImageBlockPart(record, alt) : undefined;
    if (image) images.push(image);
    else text.push(JSON.stringify(block));
  }
  return { text: text.join("\n"), images };
}

const CLAUDE_RESULT_BLOCK_TYPES = new Set(["text", "image", "tool_reference", "document", "search_result"]);

/**
 * A saved output, split as `claudeToolResultContent` splits a live one.
 * Rows saved before images were drawn kept a non-string result as its JSON.
 */
export function claudeSavedToolOutput(markdown: string | undefined, alt: string): {
  text: string; images: AppServerThreadImagePart[];
} {
  if (!markdown?.startsWith("[{\"type\":")) return { text: markdown ?? "", images: [] };
  try {
    const blocks: unknown = JSON.parse(markdown);
    const isResult = Array.isArray(blocks) && blocks.every((block) => block && typeof block === "object"
      && CLAUDE_RESULT_BLOCK_TYPES.has((block as { type?: unknown }).type as string));
    return isResult ? claudeToolResultContent(blocks, alt) : { text: markdown, images: [] };
  } catch {
    return { text: markdown, images: [] };
  }
}

/** The name a tool row shows. Claude names an MCP tool `mcp__<server>__<tool>`. */
export function claudeToolIdentifier(name: string): { identifier: string; mcp: boolean } {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match
    ? { identifier: formatToolIdentifier(match[1], match[2]), mcp: true }
    : { identifier: name, mcp: false };
}

/**
 * A call of an MCP tool, or of another tool without a row of its own: named,
 * with its arguments and result inside, as Codex shows the same calls.
 */
export function claudeToolCallDetail(params: {
  id: string; name: string; input: Record<string, unknown>; status: ActivityStatus;
  output?: string; images?: AppServerThreadImagePart[];
}): AppServerThreadActivityDetail {
  const { identifier, mcp } = claudeToolIdentifier(params.name);
  return {
    id: params.id, kind: "command", label: mcp ? `Used MCP ${identifier}` : identifier,
    command: {
      displayCommand: formatToolInvocation(identifier, params.input), rawCommand: identifier, source: "tool",
      ...(params.output ? { output: params.output } : {}),
    },
    ...(params.images?.length ? { images: params.images } : {}),
    status: params.status,
  };
}

/** The arguments a tool row was built with: its invocation after the name line. */
export function claudeToolCallArguments(detail: AppServerThreadActivityDetail): Record<string, unknown> | undefined {
  const command = detail.command;
  if (command?.source !== "tool" || command.rawCommand === undefined) return undefined;
  const json = command.displayCommand.slice(command.rawCommand.length + 1);
  try {
    const value: unknown = json ? JSON.parse(json) : undefined;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** A shell command the row ran. A tool row's command names a tool instead. */
export function claudeShellCommand(detail: AppServerThreadActivityDetail | undefined): string | undefined {
  return detail?.command?.source === "tool" ? undefined : detail?.command?.rawCommand;
}
