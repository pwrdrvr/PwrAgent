import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_MESSAGE_ID_ERROR_PATTERN =
  /\[invalid_id_prefix\][\s\S]*Invalid ['"]input\[\d+\]\.id['"]:[\s\S]*Expected an ID that begins with ['"]msg['"]/i;

export type CodexInvalidResponseMessageIdRecoveryResult = {
  backupPath: string;
  removedMessageIdCount: number;
  rolloutPath: string;
  threadId: string;
};

export function isCodexInvalidResponseMessageIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return INVALID_MESSAGE_ID_ERROR_PATTERN.test(message);
}

export async function repairCodexInvalidResponseMessageIds(params: {
  codexHome: string;
  now?: () => number;
  rolloutPath: string;
  threadId: string;
  uniqueSuffix?: () => string;
}): Promise<CodexInvalidResponseMessageIdRecoveryResult> {
  assertCodexThreadId(params.threadId);
  const rolloutPath = await resolveAuthorizedRolloutPath({
    codexHome: params.codexHome,
    rolloutPath: params.rolloutPath,
    threadId: params.threadId,
  });
  const rolloutStat = await stat(rolloutPath);
  if (!rolloutStat.isFile()) {
    throw new Error(`Codex recovery target is not a regular file: ${rolloutPath}`);
  }

  const original = await readFile(rolloutPath);
  const originalText = original.toString("utf8");
  if (!Buffer.from(originalText, "utf8").equals(original)) {
    throw new Error(`Codex recovery target is not valid UTF-8: ${rolloutPath}`);
  }

  const repaired = repairJsonlText({
    source: originalText,
    threadId: params.threadId,
    rolloutPath,
  });
  if (repaired.removedMessageIdCount === 0) {
    throw new Error(
      `Codex recovery found no invalid persisted message IDs for thread ${params.threadId}`,
    );
  }

  const mode = rolloutStat.mode & 0o7777;
  const timestamp = new Date((params.now ?? Date.now)())
    .toISOString()
    .replace(/[:.]/g, "-");
  const suffix = (params.uniqueSuffix ?? randomUUID)();
  const backupPath = `${rolloutPath}.pwragent-invalid-message-id-${timestamp}-${suffix}.bak`;
  const tempPath = path.join(
    path.dirname(rolloutPath),
    `.${path.basename(rolloutPath)}.pwragent-invalid-message-id-${suffix}.tmp`,
  );

  await writeExclusiveFile({
    bytes: original,
    filePath: backupPath,
    mode,
  });
  await syncDirectory(path.dirname(rolloutPath));

  let tempCreated = false;
  try {
    await writeExclusiveFile({
      bytes: Buffer.from(repaired.text, "utf8"),
      filePath: tempPath,
      mode,
    });
    tempCreated = true;

    const current = await readFile(rolloutPath);
    if (!current.equals(original)) {
      throw new Error(
        `Codex recovery target changed after backup; refusing to overwrite ${rolloutPath}`,
      );
    }

    await rename(tempPath, rolloutPath);
    tempCreated = false;
    await syncDirectory(path.dirname(rolloutPath));
  } finally {
    if (tempCreated) {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  return {
    backupPath,
    removedMessageIdCount: repaired.removedMessageIdCount,
    rolloutPath,
    threadId: params.threadId,
  };
}

function repairJsonlText(params: {
  rolloutPath: string;
  source: string;
  threadId: string;
}): { removedMessageIdCount: number; text: string } {
  const sourceLines = params.source.split("\n");
  const hasFinalNewline = params.source.endsWith("\n");
  if (hasFinalNewline) {
    sourceLines.pop();
  }

  let matchingSessionMetadataCount = 0;
  let removedMessageIdCount = 0;
  const repairedLines = sourceLines.map((sourceLine, index) => {
    const hasCarriageReturn = sourceLine.endsWith("\r");
    const jsonText = hasCarriageReturn ? sourceLine.slice(0, -1) : sourceLine;
    if (!jsonText.trim()) {
      return sourceLine;
    }

    let record: unknown;
    try {
      record = JSON.parse(jsonText);
    } catch (error) {
      throw new Error(
        `Invalid JSONL record ${index + 1} in ${params.rolloutPath}`,
        { cause: error },
      );
    }

    const sessionMetadata = readSessionMetadataThreadIds(record);
    if (sessionMetadata.length > 0) {
      const wrongThreadId = sessionMetadata.find(
        (threadId) => threadId !== params.threadId,
      );
      if (wrongThreadId) {
        throw new Error(
          `Codex recovery target belongs to thread ${wrongThreadId}, not ${params.threadId}`,
        );
      }
      matchingSessionMetadataCount += 1;
    }

    const removedFromRecord = sanitizeInvalidMessageIdsInRolloutRecord(record);
    if (removedFromRecord === 0) {
      return sourceLine;
    }
    removedMessageIdCount += removedFromRecord;
    return `${JSON.stringify(record)}${hasCarriageReturn ? "\r" : ""}`;
  });

  if (matchingSessionMetadataCount === 0) {
    throw new Error(
      `Codex recovery target has no session metadata for thread ${params.threadId}`,
    );
  }

  return {
    removedMessageIdCount,
    text: `${repairedLines.join("\n")}${hasFinalNewline ? "\n" : ""}`,
  };
}

function sanitizeInvalidMessageIdsInRolloutRecord(value: unknown): number {
  if (!isRecord(value)) {
    return 0;
  }

  let removed = 0;
  if (value.type === "response_item") {
    removed += sanitizeResponseItem(value.payload);
  } else if (value.type === "message") {
    removed += sanitizeResponseItem(value);
  }
  removed += sanitizeReplacementHistories(value);
  return removed;
}

function sanitizeResponseItem(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, entry) => count + sanitizeResponseItem(entry),
      0,
    );
  }
  if (!isRecord(value)) {
    return 0;
  }

  let removed = 0;
  if (
    value.type === "message"
    && typeof value.id === "string"
    && !isValidResponseMessageId(value.id)
  ) {
    delete value.id;
    removed += 1;
  }
  for (const child of Object.values(value)) {
    removed += sanitizeResponseItem(child);
  }
  return removed;
}

function sanitizeReplacementHistories(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, entry) => count + sanitizeReplacementHistories(entry),
      0,
    );
  }
  if (!isRecord(value)) {
    return 0;
  }

  let removed = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === "replacement_history" || key === "replacementHistory") {
      removed += sanitizeResponseItem(child);
    } else {
      removed += sanitizeReplacementHistories(child);
    }
  }
  return removed;
}

function isValidResponseMessageId(value: string): boolean {
  return value.startsWith("msg_") && value.length > "msg_".length;
}

function readSessionMetadataThreadIds(value: unknown): string[] {
  if (
    !isRecord(value)
    || value.type !== "session_meta"
    || !isRecord(value.payload)
  ) {
    return [];
  }
  const ids = [value.payload.id, value.payload.session_id]
    .filter((candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
    )
    .map((candidate) => candidate.trim());
  return [...new Set(ids)];
}

async function resolveAuthorizedRolloutPath(params: {
  codexHome: string;
  rolloutPath: string;
  threadId: string;
}): Promise<string> {
  if (!path.isAbsolute(params.rolloutPath)) {
    throw new Error("Codex recovery requires an absolute rollout path");
  }
  const resolvedPath = path.resolve(params.rolloutPath);
  const expectedSuffix = `-${params.threadId}.jsonl`;
  if (
    !path.basename(resolvedPath).startsWith("rollout-")
    || !path.basename(resolvedPath).endsWith(expectedSuffix)
  ) {
    throw new Error(
      `Codex recovery path does not identify thread ${params.threadId}: ${resolvedPath}`,
    );
  }

  const fileStat = await lstat(resolvedPath);
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Codex recovery refuses a symlink target: ${resolvedPath}`);
  }

  const lexicalRoots = [
    path.resolve(params.codexHome, "sessions"),
    path.resolve(params.codexHome, "archived_sessions"),
  ];
  const lexicalRoot = lexicalRoots.find((root) =>
    isPathInside(root, resolvedPath),
  );
  if (!lexicalRoot) {
    throw new Error(
      `Codex recovery path is outside the configured session storage: ${resolvedPath}`,
    );
  }

  const [realRoot, realFile] = await Promise.all([
    realpath(lexicalRoot),
    realpath(resolvedPath),
  ]);
  if (!isPathInside(realRoot, realFile)) {
    throw new Error(
      `Codex recovery path resolves outside the configured session storage: ${resolvedPath}`,
    );
  }
  return realFile;
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return (
    relativePath.length > 0
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
  );
}

function assertCodexThreadId(threadId: string): void {
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
    throw new Error(`Codex recovery received an invalid thread ID: ${threadId}`);
  }
}

async function writeExclusiveFile(params: {
  bytes: Buffer;
  filePath: string;
  mode: number;
}): Promise<void> {
  const flags =
    fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_WRONLY;
  const handle = await open(params.filePath, flags, params.mode);
  try {
    await handle.writeFile(params.bytes);
    await handle.chmod(params.mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(directoryPath, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32"
      && (code === "EACCES" || code === "EISDIR" || code === "EPERM")
    ) {
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
