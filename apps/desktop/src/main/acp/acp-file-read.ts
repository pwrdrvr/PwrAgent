import {
  type AcpProviderTool,
  readFirstLocationPath,
} from "./acp-command-extraction.js";

/**
 * A file read or directory listing made through an ACP tool call, named the
 * way Claude's rows name them: `Read checkers.ts`, `Listed src`.
 *
 * Grok titles these calls `Read \`/absolute/path\`` and
 * `List \`/absolute/path\``, while Antigravity titles `read_file` as
 * `File Users/...` (omitting the leading `/` on POSIX paths). Both expose the
 * canonical path in `rawInput` or `locations`, along with optional line/page
 * bounds (`offset`/`limit`/`pages` for Grok, `StartLine`/`EndLine` for
 * Antigravity). The completing update can omit both the input and the tool
 * identity, so the caller retains the read metadata across updates.
 * `target_file` can also be an http(s) URL, which Grok fetches.
 */
export type AcpFileRead = {
  action: "read" | "listFiles";
  path: string;
  label: string;
  inputPath?: string;
  bounds?: AcpReadBounds;
};

type AcpReadBounds = {
  pages?: string;
  offset?: number;
  limit?: number;
  startLine?: number;
  endLine?: number;
};

export function readAcpFileRead(
  record: Record<string, unknown>,
  providerTool: AcpProviderTool | undefined,
  previous?: AcpFileRead,
): AcpFileRead | undefined {
  const toolName = providerTool?.name ?? readString(record, "name");
  if (!toolName) {
    return undefined;
  }
  const rawInput = asRecord(record.rawInput);
  if (toolName === "list_dir") {
    const inputPath =
      (rawInput
        ? readString(rawInput, "target_directory")
          ?? readString(rawInput, "DirectoryPath")
          ?? readString(rawInput, "directory_path")
          ?? readString(rawInput, "Path")
          ?? readString(rawInput, "path")
        : undefined)
      ?? previous?.inputPath;
    const path = inputPath ?? readFirstLocationPath(record) ?? previous?.path;
    return path
      ? { action: "listFiles", path, inputPath, label: `Listed ${targetName(path)}` }
      : undefined;
  }
  if (toolName !== "read_file") {
    return undefined;
  }
  const inputPath =
    (rawInput
      ? readString(rawInput, "target_file")
        ?? readString(rawInput, "file_path")
        ?? readString(rawInput, "filePath")
        ?? readString(rawInput, "Path")
        ?? readString(rawInput, "path")
      : undefined)
    ?? previous?.inputPath;
  const path = inputPath ?? readFirstLocationPath(record) ?? previous?.path;
  if (!path) {
    return undefined;
  }
  const bounds = rawInput ? readBounds(rawInput, previous?.bounds) : previous?.bounds;
  const range = bounds && formatRange(bounds);
  return {
    action: "read",
    path,
    inputPath,
    bounds,
    label: `Read ${targetName(path)}${range ? ` (${range})` : ""}`,
  };
}

function readBounds(rawInput: Record<string, unknown>, previous?: AcpReadBounds): AcpReadBounds {
  return {
    pages: readString(rawInput, "pages") ?? previous?.pages,
    offset: readPositiveInteger(rawInput, "offset") ?? previous?.offset,
    limit: readPositiveInteger(rawInput, "limit") ?? previous?.limit,
    startLine: readPositiveInteger(rawInput, "StartLine")
      ?? readPositiveInteger(rawInput, "start_line")
      ?? readPositiveInteger(rawInput, "startLine")
      ?? previous?.startLine,
    endLine: readPositiveInteger(rawInput, "EndLine")
      ?? readPositiveInteger(rawInput, "end_line")
      ?? readPositiveInteger(rawInput, "endLine")
      ?? previous?.endLine,
  };
}

function formatRange({ pages, offset, limit, startLine, endLine }: AcpReadBounds): string | undefined {
  if (pages) {
    return /^\d+$/u.test(pages) ? `page ${pages}` : `pages ${pages}`;
  }
  if (limit !== undefined) {
    const from = offset ?? 1;
    return `lines ${from}-${from + limit - 1}`;
  }
  if (offset !== undefined && offset > 1) {
    return `from line ${offset}`;
  }
  if (endLine !== undefined) {
    const from = startLine ?? 1;
    if (endLine >= from) {
      return `lines ${from}-${endLine}`;
    }
  }
  return startLine !== undefined && startLine > 1
    ? `from line ${startLine}`
    : undefined;
}

export function fileBaseName(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? filePath;
}

/**
 * The last segment of a file path, or of a URL's path without its query or
 * fragment, falling back to the URL's host.
 */
function targetName(target: string): string {
  if (/^https?:\/\//iu.test(target)) {
    try {
      const url = new URL(target);
      const segment = url.pathname.split("/").filter(Boolean).at(-1);
      return segment ? decodeSegment(segment) : url.host;
    } catch {
      return target;
    }
  }
  return fileBaseName(target);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function readPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
