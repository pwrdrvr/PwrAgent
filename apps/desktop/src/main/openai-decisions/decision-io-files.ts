import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveReadableLocalFilePath,
  resolveWritableLocalFilePath,
} from "@pwragent/agent-tools/local-file-access";
import { OPENAI_DECISION_BOUNDS } from "@pwragent/shared/openai-decisions";
import {
  compactBatchItem,
  summarizeBatch,
  toolBatchItem,
  type DecisionBatchDetail,
  type DecisionBatchRecord,
} from "./decision-batches";

/**
 * Raw byte bound for `inputsFile` before JSON/JSONL parsing. Double the
 * compact JSON bound (`bulkMaxTotalBytes`, 4 MiB) so pretty-printed files
 * whose compact form fits within 4 MiB still load without risking unbounded
 * reads into memory.
 */
export const DECISION_INPUT_FILE_MAX_BYTES = OPENAI_DECISION_BOUNDS.bulkMaxTotalBytes * 2;

export type DecisionFileAccess = {
  allowedRoots: readonly string[];
  privateStorageRoots?: readonly string[];
  deniedRoots?: readonly string[];
};

export type DecisionFileErrorCode = "invalid_input" | "file_not_found" | "file_access_denied";

export class DecisionFileError extends Error {
  constructor(
    readonly code: DecisionFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DecisionFileError";
  }
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads and parses a batch `inputsFile` (JSON array or JSONL/NDJSON, one JSON
 * item per non-empty line). Enforces path access boundaries and raw byte
 * bounds before loading file contents into memory.
 */
export async function readDecisionInputsFile(
  rawPath: unknown,
  access: DecisionFileAccess | undefined,
): Promise<unknown[]> {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") || !path.isAbsolute(rawPath)) {
    throw new DecisionFileError("invalid_input", "inputsFile must be an absolute local file path.");
  }
  if (!access || access.allowedRoots.length === 0) {
    throw new DecisionFileError(
      "file_access_denied",
      "inputsFile is unavailable because no local file access roots are configured for this thread.",
    );
  }
  const readable = await resolveReadableLocalFilePath(rawPath, {
    allowedRoots: access.allowedRoots,
    privateStorageRoots: access.privateStorageRoots,
    deniedRoots: access.deniedRoots,
  });
  if (!readable.ok) {
    if (readable.reason === "not_found") {
      throw new DecisionFileError("file_not_found", `inputsFile not found: ${rawPath}`);
    }
    throw new DecisionFileError(
      "file_access_denied",
      "inputsFile must be inside this thread's workspace, a scratch project, or the temporary directory, and outside private storage.",
    );
  }

  let buffer: Buffer;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(readable.path, "r");
  } catch (error) {
    throw mapReadFsError(error, rawPath);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new DecisionFileError("invalid_input", "inputsFile must be a regular file, not a directory.");
    }
    if (info.size <= 0) {
      throw new DecisionFileError("invalid_input", "inputsFile is empty.");
    }
    if (info.size > DECISION_INPUT_FILE_MAX_BYTES) {
      throw new DecisionFileError(
        "invalid_input",
        `inputsFile must be at most ${DECISION_INPUT_FILE_MAX_BYTES} bytes.`,
      );
    }
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (buffer.byteLength <= 0) {
    throw new DecisionFileError("invalid_input", "inputsFile is empty.");
  }
  if (buffer.byteLength > DECISION_INPUT_FILE_MAX_BYTES) {
    throw new DecisionFileError(
      "invalid_input",
      `inputsFile must be at most ${DECISION_INPUT_FILE_MAX_BYTES} bytes.`,
    );
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(buffer);
  } catch {
    throw new DecisionFileError("invalid_input", "inputsFile must be valid UTF-8 text.");
  }
  return parseDecisionInputsFileContent(text, readable.path);
}

/**
 * Parses UTF-8 JSON array or JSONL/NDJSON text into an array of raw batch
 * items. `.jsonl` and `.ndjson` always parse line-by-line (so a single-line
 * JSON array item such as an image-parts array is treated as one item, not
 * unwrapped). Other extensions parse as a JSON array first and fall back to
 * multi-line JSONL when appropriate.
 */
export function parseDecisionInputsFileContent(text: string, filePath: string): unknown[] {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = cleaned.trim();
  if (!trimmed) {
    throw new DecisionFileError("invalid_input", "inputsFile is empty.");
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") {
    return parseJsonLines(cleaned);
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    throw new DecisionFileError(
      "invalid_input",
      "inputsFile must contain a JSON array or JSONL (one JSON item per line).",
    );
  } catch (error) {
    if (error instanceof DecisionFileError) throw error;
    if (trimmed.includes("\n") || trimmed.includes("\r")) {
      return parseJsonLines(cleaned);
    }
    throw new DecisionFileError("invalid_input", "inputsFile does not contain valid JSON.");
  }
}

function parseJsonLines(text: string): unknown[] {
  const lines = text.split(/\r?\n/u);
  const items: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    if (items.length >= OPENAI_DECISION_BOUNDS.bulkMaxItems) {
      throw new DecisionFileError(
        "invalid_input",
        `inputsFile must contain 1 to ${OPENAI_DECISION_BOUNDS.bulkMaxItems} items.`,
      );
    }
    try {
      items.push(JSON.parse(line));
    } catch {
      throw new DecisionFileError(
        "invalid_input",
        `inputsFile line ${index + 1} is not valid JSON.`,
      );
    }
  }
  if (items.length === 0) {
    throw new DecisionFileError("invalid_input", "inputsFile is empty.");
  }
  return items;
}

/**
 * Validates and canonicalizes a caller-requested `outputFile` before any
 * provider request runs. Refuses non-absolute paths, symlinks, directories,
 * private storage, and destinations outside the thread's allowed roots.
 */
export async function resolveWritableDecisionOutputFile(
  rawPath: unknown,
  access: DecisionFileAccess | undefined,
): Promise<string> {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") || !path.isAbsolute(rawPath)) {
    throw new DecisionFileError("invalid_input", "outputFile must be an absolute local file path.");
  }
  if (!access || access.allowedRoots.length === 0) {
    throw new DecisionFileError(
      "file_access_denied",
      "outputFile is unavailable because no local file access roots are configured for this thread.",
    );
  }
  let resolved: Awaited<ReturnType<typeof resolveWritableLocalFilePath>>;
  try {
    resolved = await resolveWritableLocalFilePath(rawPath, {
      allowedRoots: access.allowedRoots,
      privateStorageRoots: access.privateStorageRoots,
      deniedRoots: access.deniedRoots,
    });
  } catch (error) {
    throw new DecisionFileError(
      "invalid_input",
      `Could not validate outputFile: ${error instanceof Error ? error.message : "filesystem error"}`,
    );
  }
  if (!resolved.ok) {
    switch (resolved.reason) {
      case "forbidden":
        throw new DecisionFileError(
          "file_access_denied",
          "outputFile must be inside this thread's workspace, a scratch project, or the temporary directory, and outside private storage.",
        );
      case "symlink":
        throw new DecisionFileError("invalid_input", "outputFile must not be a symbolic link.");
      case "not_a_file":
        throw new DecisionFileError("invalid_input", "outputFile must be a file path, not a directory.");
      case "invalid":
        throw new DecisionFileError("invalid_input", "outputFile must be a valid absolute local file path.");
    }
  }
  return resolved.path;
}

/**
 * Atomically writes UTF-8 text to a validated `outputFile`. Re-checks path
 * containment after creating parent directories and rejects symlinks right
 * before rename.
 */
export async function writeDecisionOutputFile(
  targetPath: string,
  content: string,
  access: DecisionFileAccess | undefined,
): Promise<string> {
  const canonical = await resolveWritableDecisionOutputFile(targetPath, access);
  await mkdir(path.dirname(canonical), { recursive: true });
  // Re-verify after directory creation in case a symlink raced into a parent.
  const verified = await resolveWritableDecisionOutputFile(canonical, access);
  const tempPath = `${verified}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    const existing = await lstat(verified).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new DecisionFileError("invalid_input", "outputFile must not be a symbolic link.");
      }
      if (!existing.isFile()) {
        throw new DecisionFileError("invalid_input", "outputFile must be a file path, not a directory.");
      }
    }
    await rename(tempPath, verified);
    return verified;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

/**
 * Formats a finished batch for a caller-requested `outputFile`.
 * - `.json`: a single JSON object `{ ...summary, detail, results }` with every
 *   item in input order (`0..count-1`).
 * - `.jsonl` / `.ndjson` / other: one compact JSON result object per line in
 *   input order.
 * Rail-only previews/thumbnails are never written to `outputFile`.
 */
export function formatBatchOutputFile(
  record: DecisionBatchRecord,
  detail: DecisionBatchDetail,
  outputFile: string,
): string {
  const items: unknown[] = [];
  for (let index = 0; index < record.count; index += 1) {
    const item = record.results[index];
    if (!item) continue;
    items.push(detail === "full" ? toolBatchItem(item) : compactBatchItem(item));
  }
  if (path.extname(outputFile).toLowerCase() === ".json") {
    return `${JSON.stringify({ ...summarizeBatch(record), detail, results: items })}\n`;
  }
  return items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
}

/** Formats a single-input invocation result as JSON for `outputFile`. */
export function formatSingleOutputFile(result: Record<string, unknown>): string {
  return `${JSON.stringify(result)}\n`;
}

function mapReadFsError(error: unknown, rawPath: string): DecisionFileError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new DecisionFileError("file_not_found", `inputsFile not found: ${rawPath}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new DecisionFileError("file_access_denied", `Permission denied reading inputsFile: ${rawPath}`);
  }
  return new DecisionFileError("invalid_input", `Could not read inputsFile: ${rawPath}`);
}
