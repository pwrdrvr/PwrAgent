import fs from "node:fs";
import path from "node:path";
import type { AcpBackendId, AppServerThreadReplay } from "@pwragent/shared";
import {
  AcpSessionReplayNormalizer,
  readAcpContentText,
  readAcpTopicTitle,
} from "./acp-session-normalizer.js";

export type AcpRolloutRecord = {
  type: "update";
  receivedAt: number;
  update: Record<string, unknown>;
};

export type AcpRolloutStoreAppendParams = {
  backendId: AcpBackendId;
  sessionId: string;
  receivedAt: number;
  update: Record<string, unknown>;
};

type ChunkBuffer = {
  backendId: AcpBackendId;
  receivedAt: number;
  sessionId: string;
  update: Record<string, unknown>;
  text: string;
};

const CHUNK_FLUSH_TEXT_LENGTH = 2_048;

export class AcpRolloutStore {
  private readonly chunkBuffers = new Map<string, ChunkBuffer>();
  private readonly lastFingerprints = new Map<string, string>();

  constructor(private readonly rootDir: string) {}

  appendUpdate(params: AcpRolloutStoreAppendParams): void {
    if (!shouldPersistUpdate(params.update)) {
      return;
    }
    const chunkKey = streamingChunkKey(params);
    if (chunkKey) {
      this.appendChunk(chunkKey, params);
      return;
    }
    this.flushSession(params.backendId, params.sessionId);

    const duplicateKey = updateDuplicateKey(params);
    const fingerprint = updateFingerprint(params.update);
    if (duplicateKey && fingerprint) {
      const previous = this.lastFingerprints.get(duplicateKey);
      if (previous === fingerprint) {
        return;
      }
      this.lastFingerprints.set(duplicateKey, fingerprint);
    }

    this.writeRecord(params);
  }

  readUpdates(params: {
    backendId: AcpBackendId;
    sessionId: string;
  }): AcpRolloutRecord[] {
    this.flushSession(params.backendId, params.sessionId);
    const rolloutPath = this.rolloutPath(params.backendId, params.sessionId);
    if (!fs.existsSync(rolloutPath)) {
      return [];
    }
    return fs
      .readFileSync(rolloutPath, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.trim()) {
          return [];
        }
        const parsed = parseJson(line);
        return isRolloutRecord(parsed) ? [parsed] : [];
      });
  }

  readReplay(params: {
    backendId: AcpBackendId;
    sessionId: string;
  }): AppServerThreadReplay {
    const normalizer = new AcpSessionReplayNormalizer();
    for (const record of this.readUpdates(params)) {
      normalizer.apply({
        sessionId: params.sessionId,
        receivedAt: record.receivedAt,
        update: record.update,
      });
    }
    return normalizer.replay();
  }

  flushAll(): void {
    for (const key of [...this.chunkBuffers.keys()]) {
      this.flushChunk(key);
    }
  }

  private appendChunk(
    chunkKey: string,
    params: AcpRolloutStoreAppendParams,
  ): void {
    const text = readUpdateText(params.update);
    if (!text) {
      return;
    }
    const existing = this.chunkBuffers.get(chunkKey);
    if (existing) {
      existing.text += text;
      if (existing.text.length >= CHUNK_FLUSH_TEXT_LENGTH) {
        this.flushChunk(chunkKey);
      }
      return;
    }

    this.chunkBuffers.set(chunkKey, {
      backendId: params.backendId,
      receivedAt: params.receivedAt,
      sessionId: params.sessionId,
      update: params.update,
      text,
    });
    if (text.length >= CHUNK_FLUSH_TEXT_LENGTH) {
      this.flushChunk(chunkKey);
    }
  }

  private flushSession(backendId: AcpBackendId, sessionId: string): void {
    const prefix = `${backendId}:${sessionId}:`;
    for (const key of [...this.chunkBuffers.keys()]) {
      if (key.startsWith(prefix)) {
        this.flushChunk(key);
      }
    }
  }

  private flushChunk(chunkKey: string): void {
    const buffer = this.chunkBuffers.get(chunkKey);
    if (!buffer) {
      return;
    }
    this.chunkBuffers.delete(chunkKey);
    this.writeRecord({
      backendId: buffer.backendId,
      sessionId: buffer.sessionId,
      receivedAt: buffer.receivedAt,
      update: updateWithText(buffer.update, buffer.text),
    });
  }

  private writeRecord(params: AcpRolloutStoreAppendParams): void {
    const rolloutPath = this.rolloutPath(params.backendId, params.sessionId);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.appendFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "update",
        receivedAt: params.receivedAt,
        update: params.update,
      } satisfies AcpRolloutRecord)}\n`,
      "utf8",
    );
  }

  private rolloutPath(backendId: AcpBackendId, sessionId: string): string {
    return path.join(
      this.rootDir,
      encodePathSegment(backendId),
      encodePathSegment(sessionId),
      "rollout.jsonl",
    );
  }
}

function shouldPersistUpdate(update: Record<string, unknown>): boolean {
  const kind = readKind(update);
  if (
    kind === "available_commands_update" ||
    kind === "config_option_update" ||
    kind === "current_mode_update"
  ) {
    return false;
  }
  if (readAcpTopicTitle(update)) {
    return false;
  }
  return kind !== "unknown";
}

function streamingChunkKey(
  params: AcpRolloutStoreAppendParams,
): string | undefined {
  const kind = readKind(params.update);
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") {
    return undefined;
  }
  const id =
    readString(params.update, "messageId") ??
    readString(params.update, "message_id") ??
    readString(params.update, "id") ??
    "default";
  return `${params.backendId}:${params.sessionId}:${kind}:${id}`;
}

function updateDuplicateKey(
  params: AcpRolloutStoreAppendParams,
): string | undefined {
  const kind = readKind(params.update);
  if (kind !== "tool_call" && kind !== "tool_call_update") {
    return undefined;
  }
  const id =
    readString(params.update, "toolCallId") ??
    readString(params.update, "tool_call_id") ??
    readString(params.update, "id") ??
    readString(params.update, "itemId") ??
    readString(params.update, "item_id") ??
    readString(params.update, "title");
  return id
    ? `${params.backendId}:${params.sessionId}:${kind}:${id}`
    : undefined;
}

function updateFingerprint(update: Record<string, unknown>): string | undefined {
  const kind = readKind(update);
  if (kind !== "tool_call" && kind !== "tool_call_update") {
    return undefined;
  }
  const content = readAcpContentText(update.content) ?? "";
  return JSON.stringify({
    command: readString(update, "command"),
    contentHash: hashString(content),
    contentLength: content.length,
    kind,
    status: readString(update, "status"),
    title: readString(update, "title"),
  });
}

function readUpdateText(update: Record<string, unknown>): string | undefined {
  return readAcpContentText(update.content) ?? readString(update, "text");
}

function updateWithText(
  update: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  const content = update.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return {
      ...update,
      content: {
        ...content,
        text,
      },
    };
  }
  return {
    ...update,
    text,
  };
}

function readKind(update: Record<string, unknown>): string {
  return (
    readString(update, "sessionUpdate") ??
    readString(update, "session_update") ??
    readString(update, "kind") ??
    readString(update, "type") ??
    "unknown"
  );
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash.toString(16);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRolloutRecord(value: unknown): value is AcpRolloutRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === "update" &&
    typeof record.receivedAt === "number" &&
    record.update !== null &&
    typeof record.update === "object" &&
    !Array.isArray(record.update)
  );
}
