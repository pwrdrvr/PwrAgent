import { open, stat } from "node:fs/promises";
import type { AppLogSnapshot } from "../shared/app-metadata";
import { getMainLogFilePath } from "./log";

export const DEFAULT_LOG_TAIL_BYTES = 512 * 1024;

export async function readAppLogSnapshot(options?: {
  filePath?: string;
  maxBytes?: number;
}): Promise<AppLogSnapshot> {
  const filePath = options?.filePath ?? getMainLogFilePath();
  const readAt = Date.now();
  if (!filePath) {
    return {
      kind: "log-snapshot",
      title: "Logs",
      content: "",
      sizeBytes: 0,
      readAt,
      truncated: false,
      unavailableReason: "Log file path is not available.",
    };
  }

  try {
    const snapshot = await readFileTail(filePath, options?.maxBytes);
    return {
      kind: "log-snapshot",
      title: "Logs",
      path: filePath,
      content: snapshot.content,
      sizeBytes: snapshot.sizeBytes,
      modifiedAt: snapshot.modifiedAt,
      readAt,
      truncated: snapshot.truncated,
    };
  } catch (error) {
    return {
      kind: "log-snapshot",
      title: "Logs",
      path: filePath,
      content: "",
      sizeBytes: 0,
      readAt,
      truncated: false,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readFileTail(
  filePath: string,
  maxBytes = DEFAULT_LOG_TAIL_BYTES,
): Promise<{
  content: string;
  sizeBytes: number;
  modifiedAt: number;
  truncated: boolean;
}> {
  const cappedBytes = Math.max(1, Math.floor(maxBytes));
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error("Log path is not a file.");
  }

  const sizeBytes = fileStat.size;
  const start = Math.max(0, sizeBytes - cappedBytes);
  const length = sizeBytes - start;
  if (length === 0) {
    return {
      content: "",
      sizeBytes,
      modifiedAt: fileStat.mtimeMs,
      truncated: false,
    };
  }

  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    const truncated = start > 0;
    if (truncated) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
    }
    return {
      content,
      sizeBytes,
      modifiedAt: fileStat.mtimeMs,
      truncated,
    };
  } finally {
    await handle.close();
  }
}
