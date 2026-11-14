import type { AcpProviderTool } from "./acp-command-extraction.js";

/**
 * A file read or directory listing made through an ACP tool call, named the
 * way Claude's rows name them: `Read checkers.ts`, `Listed src`.
 *
 * Grok titles these calls `Read \`/absolute/path\`` and
 * `List \`/absolute/path\``, which in a worktree is mostly path. Its
 * `read_file` input is `target_file` with an optional 1-based `offset`, a
 * line `limit`, and `pages` for documents; `list_dir` input is
 * `target_directory`. The completing update can omit both the input and the
 * tool identity, so the caller remembers the first read it derives.
 */
export type AcpFileRead = {
  path: string;
  label: string;
};

export function readAcpFileRead(
  record: Record<string, unknown>,
  providerTool: AcpProviderTool | undefined,
): AcpFileRead | undefined {
  const rawInput = asRecord(record.rawInput);
  if (!rawInput || !providerTool) {
    return undefined;
  }
  if (providerTool.name === "list_dir") {
    const path = readString(rawInput, "target_directory");
    return path ? { path, label: `Listed ${baseName(path)}` } : undefined;
  }
  if (providerTool.name !== "read_file") {
    return undefined;
  }
  const path = readString(rawInput, "target_file");
  if (!path) {
    return undefined;
  }
  const range = readRange(rawInput);
  return {
    path,
    label: `Read ${baseName(path)}${range ? ` (${range})` : ""}`,
  };
}

function readRange(rawInput: Record<string, unknown>): string | undefined {
  const pages = readString(rawInput, "pages");
  if (pages) {
    return /^\d+$/u.test(pages) ? `page ${pages}` : `pages ${pages}`;
  }
  const offset = readPositiveInteger(rawInput, "offset");
  const limit = readPositiveInteger(rawInput, "limit");
  if (limit !== undefined) {
    const from = offset ?? 1;
    return `lines ${from}-${from + limit - 1}`;
  }
  return offset !== undefined && offset > 1
    ? `from line ${offset}`
    : undefined;
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? filePath;
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
