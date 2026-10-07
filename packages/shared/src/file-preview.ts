/**
 * File kinds the in-app preview renders instead of opening the editor.
 *
 * The renderer routes transcript links with this, the main process gates its
 * local read with it, and a federation owner gates file pull with it, so the
 * three checks cannot drift apart. Source code stays editor-first. `.env`
 * files stay out: they hold secrets that a federated peer could pull. Codex
 * session logs stay out too: PwrAgent reads Codex data only through the App
 * Server protocol, so a link to a rollout opens the editor instead.
 */
export type FilePreviewKind =
  | "markdown"
  | "json"
  | "jsonl"
  | "yaml"
  | "toml"
  | "csv"
  | "tsv"
  | "text";

const FILE_PREVIEW_KINDS_BY_EXTENSION: Record<string, FilePreviewKind> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  csv: "csv",
  tsv: "tsv",
  txt: "text",
  log: "text",
};

const FILE_PREVIEW_KIND_LABELS: Record<FilePreviewKind, string> = {
  markdown: "Markdown",
  json: "JSON",
  jsonl: "JSON Lines",
  yaml: "YAML",
  toml: "TOML",
  csv: "CSV",
  tsv: "TSV",
  text: "text",
};

export function filePreviewKind(filePath: string): FilePreviewKind | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase();
  const kind = extension ? FILE_PREVIEW_KINDS_BY_EXTENSION[extension] : undefined;
  return kind === "jsonl" && isCodexSessionLogPath(filePath) ? undefined : kind;
}

function isCodexSessionLogPath(filePath: string): boolean {
  // Codex worktrees also live under ~/.codex, so match the session folders.
  return /(?:^|[\\/])\.codex[\\/](?:archived_)?sessions[\\/]/i.test(filePath)
    || /(?:^|[\\/])rollout-[^\\/]*$/i.test(filePath);
}

export function isFilePreviewPath(filePath: string): boolean {
  return filePreviewKind(filePath) !== undefined;
}

/** A short name for the kind, as used in "Copy JSON" or "Copy text". */
export function filePreviewKindLabel(kind: FilePreviewKind): string {
  return FILE_PREVIEW_KIND_LABELS[kind];
}
