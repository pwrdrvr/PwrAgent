import fs from "node:fs";
import path from "node:path";
import {
  ACP_WORKSPACE_HANDOFF_RECORD, acpWorkspaceHistory, mergeAcpSyntheticHistory, prependAcpWorkspaceHistory,
} from "./acp-workspace-history.js";
import {
  type AcpBackendId,
  type AppServerThreadReplay,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  AcpSessionReplayNormalizer,
  type AcpReplayKit,
  acpSessionReplayNormalizerOptions,
  isAcpSessionMetadataUpdateKind,
  isAcpUsageUpdateKind,
  isAcpUserBoilerplateMessage,
  isGrokTransientUpdateKind,
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
const PWRAGENT_SYNTHETIC_UPDATE_META_KEY = "pwragentSynthetic";
const LEGACY_BACKEND_PATH_PREFIX = "acp_3A";
const COLLISION_SAFE_CURRENT_BACKEND_PATH_SUFFIX = "__current";

export function isPwrAgentSyntheticAcpUpdate(
  update: Record<string, unknown>,
): boolean {
  const meta = update._meta;
  return Boolean(
    meta
    && typeof meta === "object"
    && !Array.isArray(meta)
    && (meta as Record<string, unknown>)[PWRAGENT_SYNTHETIC_UPDATE_META_KEY] === true,
  );
}

type CachedRolloutRecords = {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  records: AcpRolloutRecord[];
};

const MAX_CACHED_ROLLOUT_SESSIONS = 32;

export class AcpRolloutStore {
  private readonly chunkBuffersBySession = new Map<string, Map<string, ChunkBuffer>>();
  private readonly lastFingerprintsBySession = new Map<string, Map<string, string>>();
  private readonly knownRolloutPaths = new Set<string>();
  private readonly recordCache = new Map<string, CachedRolloutRecords>();

  constructor(private readonly rootDir: string) {}

  appendUpdate(params: AcpRolloutStoreAppendParams): void {
    if (!shouldPersistUpdate(params.update)) {
      return;
    }
    const chunkKey = streamingChunkKey(params);
    if (chunkKey) {
      this.clearSessionFingerprints(params.backendId, params.sessionId);
      this.appendChunk(chunkKey, params);
      return;
    }
    this.flushSession(params.backendId, params.sessionId);

    const duplicateKey = updateDuplicateKey(params);
    const fingerprint = updateFingerprint(params.update);
    if (duplicateKey && fingerprint) {
      const sessionKey = rolloutSessionKey(params.backendId, params.sessionId);
      let sessionFingerprints = this.lastFingerprintsBySession.get(sessionKey);
      if (!sessionFingerprints) {
        sessionFingerprints = new Map();
        this.lastFingerprintsBySession.set(sessionKey, sessionFingerprints);
      }
      const previous = sessionFingerprints.get(duplicateKey);
      if (previous === fingerprint) {
        return;
      }
      sessionFingerprints.set(duplicateKey, fingerprint);
    } else {
      this.clearSessionFingerprints(params.backendId, params.sessionId);
    }

    this.writeRecord(params);
  }

  readUpdates(params: {
    backendId: AcpBackendId;
    sessionId: string;
  }): AcpRolloutRecord[] {
    this.flushSession(params.backendId, params.sessionId);
    const rolloutPath = this.rolloutPath(params.backendId, params.sessionId);
    const stat = statRolloutFile(rolloutPath);
    if (!stat) {
      this.recordCache.delete(rolloutPath);
      this.knownRolloutPaths.delete(rolloutPath);
      return [];
    }
    const cached = this.recordCache.get(rolloutPath);
    if (
      cached
      && cached.ino === stat.ino
      && cached.size === stat.size
      && cached.mtimeNs === stat.mtimeNs
      && cached.ctimeNs === stat.ctimeNs
    ) {
      return [...cached.records];
    }
    const records = readRolloutRecords(rolloutPath);
    this.setCachedRecords(rolloutPath, {
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      records,
    });
    return [...records];
  }

  readReplay(params: {
    backendId: AcpBackendId;
    sessionId: string;
    /** The session's workspace, which edit diffs name files relative to. */
    cwd?: string;
    workspaceAgentSessionId?: string;
    replayKit?: AcpReplayKit;
  }): AppServerThreadReplay {
    const options = {
      ...acpSessionReplayNormalizerOptions(params.backendId, params.cwd),
      replayKit: params.replayKit,
    };
    const normalizer = new AcpSessionReplayNormalizer({ ...options, workspaceSessionId: params.workspaceAgentSessionId });
    const records = this.readUpdates(params);
    const { current, previous } = acpWorkspaceHistory(records, params.workspaceAgentSessionId);
    for (const record of current) {
      if (previous && isPwrAgentSyntheticAcpUpdate(record.update)) continue;
      normalizer.apply({
        sessionId: params.sessionId,
        receivedAt: record.receivedAt,
        update: record.update,
      });
    }
    if (!previous) return normalizer.replay();
    const synthetic = new AcpSessionReplayNormalizer(options);
    for (const record of records) {
      if (!isPwrAgentSyntheticAcpUpdate(record.update)) continue;
      synthetic.apply({
        sessionId: params.sessionId,
        receivedAt: record.receivedAt,
        update: record.update,
      });
    }
    return mergeAcpSyntheticHistory(prependAcpWorkspaceHistory(previous, normalizer.replay()), synthetic.replay());
  }

  flushAll(): void {
    for (const sessionKey of [...this.chunkBuffersBySession.keys()]) {
      this.flushSessionByKey(sessionKey);
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
    const sessionKey = rolloutSessionKey(params.backendId, params.sessionId);
    const sessionBuffers = this.chunkBuffersBySession.get(sessionKey);
    const existing = sessionBuffers?.get(chunkKey);
    if (existing) {
      existing.text += text;
      if (existing.text.length >= CHUNK_FLUSH_TEXT_LENGTH) {
        this.flushChunk(sessionKey, chunkKey);
      }
      return;
    }

    // Switching chunk kind or message id starts a new transcript stream; flush
    // any earlier buffered chunk for this session first so rollout.jsonl keeps
    // wire order even when the new stream hits its flush threshold.
    this.flushSessionByKey(sessionKey);

    let nextBuffers = this.chunkBuffersBySession.get(sessionKey);
    if (!nextBuffers) {
      nextBuffers = new Map();
      this.chunkBuffersBySession.set(sessionKey, nextBuffers);
    }
    nextBuffers.set(chunkKey, {
      backendId: params.backendId,
      receivedAt: params.receivedAt,
      sessionId: params.sessionId,
      update: params.update,
      text,
    });
    if (text.length >= CHUNK_FLUSH_TEXT_LENGTH) {
      this.flushChunk(sessionKey, chunkKey);
    }
  }

  private flushSession(backendId: AcpBackendId, sessionId: string): void {
    this.flushSessionByKey(rolloutSessionKey(backendId, sessionId));
  }

  private flushSessionByKey(sessionKey: string): void {
    const sessionBuffers = this.chunkBuffersBySession.get(sessionKey);
    if (!sessionBuffers || sessionBuffers.size === 0) {
      return;
    }
    for (const chunkKey of [...sessionBuffers.keys()]) {
      this.flushChunk(sessionKey, chunkKey);
    }
  }

  private flushChunk(sessionKey: string, chunkKey: string): void {
    const sessionBuffers = this.chunkBuffersBySession.get(sessionKey);
    const buffer = sessionBuffers?.get(chunkKey);
    if (!buffer || !sessionBuffers) {
      return;
    }
    sessionBuffers.delete(chunkKey);
    if (sessionBuffers.size === 0) {
      this.chunkBuffersBySession.delete(sessionKey);
    }
    this.writeRecord({
      backendId: buffer.backendId,
      sessionId: buffer.sessionId,
      receivedAt: buffer.receivedAt,
      update: updateWithText(buffer.update, buffer.text),
    });
  }

  private writeRecord(params: AcpRolloutStoreAppendParams): void {
    const rolloutPath = this.rolloutPath(params.backendId, params.sessionId);
    if (!this.knownRolloutPaths.has(rolloutPath)) {
      fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
      this.knownRolloutPaths.add(rolloutPath);
    }
    const record: AcpRolloutRecord = {
      type: "update",
      receivedAt: params.receivedAt,
      update: params.update,
    };
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = BigInt(Buffer.byteLength(line, "utf8"));
    const cached = this.recordCache.get(rolloutPath);
    let cachedMatchesPreAppend = false;
    if (cached) {
      const preStat = statRolloutFile(rolloutPath);
      if (
        preStat
        && preStat.ino === cached.ino
        && preStat.size === cached.size
        && preStat.mtimeNs === cached.mtimeNs
        && preStat.ctimeNs === cached.ctimeNs
      ) {
        cachedMatchesPreAppend = true;
      } else {
        this.recordCache.delete(rolloutPath);
      }
    }
    const appendOptions = {
      encoding: "utf8" as const,
      // The owner commits the replacement provider ID after this boundary.
      flush: params.update.kind === ACP_WORKSPACE_HANDOFF_RECORD,
    };
    try {
      fs.appendFileSync(rolloutPath, line, appendOptions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        this.recordCache.delete(rolloutPath);
        throw error;
      }
      fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
      this.knownRolloutPaths.add(rolloutPath);
      this.recordCache.delete(rolloutPath);
      cachedMatchesPreAppend = false;
      fs.appendFileSync(rolloutPath, line, appendOptions);
    }
    if (cached && cachedMatchesPreAppend) {
      const postStat = statRolloutFile(rolloutPath);
      if (
        postStat
        && postStat.ino === cached.ino
        && postStat.size === cached.size + lineBytes
      ) {
        cached.records.push(record);
        cached.size = postStat.size;
        cached.mtimeNs = postStat.mtimeNs;
        cached.ctimeNs = postStat.ctimeNs;
      } else {
        this.recordCache.delete(rolloutPath);
      }
    }
  }

  private clearSessionFingerprints(backendId: AcpBackendId, sessionId: string): void {
    this.lastFingerprintsBySession.delete(rolloutSessionKey(backendId, sessionId));
  }

  deleteSession(backendId: AcpBackendId, sessionId: string): void {
    this.flushSession(backendId, sessionId);
    this.clearSessionFingerprints(backendId, sessionId);
    const rolloutPath = this.rolloutPath(backendId, sessionId);
    this.knownRolloutPaths.delete(rolloutPath);
    this.recordCache.delete(rolloutPath);
    fs.rmSync(path.dirname(rolloutPath), { recursive: true, force: true });
  }

  private setCachedRecords(rolloutPath: string, entry: CachedRolloutRecords): void {
    this.recordCache.delete(rolloutPath);
    this.recordCache.set(rolloutPath, entry);
    if (this.recordCache.size > MAX_CACHED_ROLLOUT_SESSIONS) {
      const oldestKey = this.recordCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.recordCache.delete(oldestKey);
      }
    }
  }

  private rolloutPath(backendId: AcpBackendId, sessionId: string): string {
    const rolloutPath = path.join(
      this.rootDir,
      encodeBackendPathSegment(backendId),
      encodePathSegment(sessionId),
      "rollout.jsonl",
    );
    if (!this.knownRolloutPaths.has(rolloutPath)) {
      this.recoverLegacySession(backendId, sessionId, rolloutPath);
    }
    return rolloutPath;
  }

  /**
   * Older desktop builds encoded `acp:grok` as `acp_3Agrok`; current builds
   * use `acp_grok`. An older process can still recreate the old directory
   * after a newer build has migrated it, so a one-time root marker cannot make
   * the layout durable. Recover only the exact requested session instead.
   *
   * The canonical session directory always wins. This deliberately leaves a
   * duplicate old-path session alone rather than merging or overwriting it.
   */
  private recoverLegacySession(
    backendId: AcpBackendId,
    sessionId: string,
    currentRolloutPath: string,
  ): void {
    const currentSessionPath = path.dirname(currentRolloutPath);
    if (fs.existsSync(currentSessionPath)) {
      return;
    }

    const legacySessionPath = path.join(
      this.rootDir,
      encodePathSegment(backendId),
      encodePathSegment(sessionId),
    );
    if (!fs.existsSync(legacySessionPath)) {
      return;
    }

    fs.mkdirSync(path.dirname(currentSessionPath), { recursive: true });
    try {
      fs.renameSync(legacySessionPath, currentSessionPath);
    } catch (error) {
      // Another current build may have recovered this same session first.
      if (
        isErrnoException(error) &&
        error.code === "ENOENT" &&
        !fs.existsSync(legacySessionPath) &&
        fs.existsSync(currentSessionPath)
      ) {
        return;
      }
      throw error;
    }

    try {
      fs.rmdirSync(path.dirname(legacySessionPath));
    } catch (error) {
      // Keep a non-empty legacy backend directory for any other sessions an
      // older app instance may still own. Its next current-build access will
      // recover that session independently.
      if (
        !isErrnoException(error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")
      ) {
        throw error;
      }
    }
  }
}

function shouldPersistUpdate(update: Record<string, unknown>): boolean {
  const kind = readKind(update);
  if (
    kind === "available_commands_update" ||
    kind === "config_option_update" ||
    kind === "current_mode_update" ||
    kind === "model_changed"
  ) {
    return false;
  }
  // Session metadata, context fill, and the provider's own transient
  // bookkeeping describe the session, not the conversation. A title-less
  // session_info_update carries no topic for the check below to catch, so
  // match on the kind as well.
  if (
    isAcpSessionMetadataUpdateKind(kind)
    || isAcpUsageUpdateKind(kind)
    || isGrokTransientUpdateKind(kind)
  ) {
    return false;
  }
  if (readAcpTopicTitle(update)) {
    return false;
  }
  // Don't persist ACP user boilerplate. These chunks arrive during session/load
  // replay, so without this guard every reload appends another copy to the
  // rollout and permanently pollutes durable history with setup/control text.
  if (
    kind === "user_message_chunk" &&
    isAcpUserBoilerplateMessage(readUpdateText(update))
  ) {
    return false;
  }
  return kind !== "unknown";
}

function streamingChunkKey(
  params: AcpRolloutStoreAppendParams,
): string | undefined {
  if (isPwrAgentSyntheticAcpUpdate(params.update)) {
    return undefined;
  }
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
    readString(params.update, "item_id");
  return id
    ? `${params.backendId}:${params.sessionId}:${id}`
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

function encodeBackendPathSegment(value: AcpBackendId): string {
  const currentPathSegment = value.replace(":", "_");
  // The old URL-style encoding makes `acp:grok` `acp_3Agrok`, which is also
  // the readable encoding of a valid current backend ID, `acp:3Agrok`.
  // Never let a current backend claim a directory that an old build can own.
  return currentPathSegment.startsWith(LEGACY_BACKEND_PATH_PREFIX)
    ? `${currentPathSegment}${COLLISION_SAFE_CURRENT_BACKEND_PATH_SUFFIX}`
    : currentPathSegment;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function rolloutSessionKey(backendId: AcpBackendId, sessionId: string): string {
  return `${backendId}:${sessionId}`;
}

function statRolloutFile(rolloutPath: string): {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
} | undefined {
  try {
    const stat = fs.statSync(rolloutPath, { bigint: true });
    return {
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch {
    return undefined;
  }
}

function readRolloutRecords(rolloutPath: string): AcpRolloutRecord[] {
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
