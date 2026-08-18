import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS,
  estimateTokenCount,
  type TokenMiserHelperUsage,
  type TokenMiserObjectMetadata,
  type TokenMiserSummary,
} from "./token-miser-types.js";

const METADATA_SUFFIX = ".json";
const OUTPUT_SUFFIX = ".txt";
const MAX_SEARCH_RESULTS = 100;
const MAX_READ_LINES = 2_000;

export type TokenMiserStoredObject = {
  metadata: TokenMiserObjectMetadata;
  output: string;
};

export type TokenMiserSearchMatch = {
  line: number;
  text: string;
};

export type TokenMiserReadResult = {
  objectId: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
};

export type TokenMiserUsageSummary = {
  interceptionCount: number;
  originalCharacters: number;
  baselineParentTokens: number;
  replacementTokens: number;
  retrievedTokens: number;
  estimatedParentTokensSaved: number;
  cachedReplayCount: number;
  cachedBaselineTokens: number;
  cachedRevealedTokens: number;
  estimatedCachedReplayTokensSaved: number;
};

export type TokenMiserThreadUsageSummary = TokenMiserUsageSummary & {
  interceptions: Array<{
    objectId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    createdAt: number;
    originalCharacters: number;
    baselineParentTokens: number;
    replacementTokens: number;
    retrievedTokens: number;
    estimatedParentTokensSaved: number;
    cachedReplayCount: number;
    cachedBaselineTokens: number;
    cachedRevealedTokens: number;
    estimatedCachedReplayTokensSaved: number;
    replayTrackingVersion?: 2;
    summary?: TokenMiserSummary;
  }>;
};

export type TokenMiserStoreOptions = {
  onMetadataUpdated?: (
    metadata: TokenMiserObjectMetadata,
  ) => void | Promise<void>;
};

export class TokenMiserStore {
  private readonly updateLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly rootDir: string,
    private readonly options: TokenMiserStoreOptions = {},
  ) {}

  async store(params: {
    objectId?: string;
    threadId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    output: string;
    replacementCharacters: number;
    summary: TokenMiserSummary;
    helperUsage?: TokenMiserHelperUsage;
    parentCumulativeInputTokens?: number;
    now?: number;
  }): Promise<TokenMiserObjectMetadata> {
    await this.ensureRoot();
    const objectId = params.objectId ?? randomUUID();
    if (!isSafeObjectId(objectId)) {
      throw new Error("Invalid Token Miser object id.");
    }
    const originalCharacters = params.output.length;
    const metadata: TokenMiserObjectMetadata = {
      version: 1,
      objectId,
      threadId: params.threadId,
      turnId: params.turnId,
      toolUseId: params.toolUseId,
      toolName: params.toolName,
      createdAt: params.now ?? Date.now(),
      originalCharacters,
      baselineParentTokens: estimateTokenCount(
        Math.min(originalCharacters, TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS),
      ),
      replacementCharacters: params.replacementCharacters,
      retrievedCharacters: 0,
      replayTrackingVersion: 2,
      parentRequestsObservedAfterGate: 0,
      cachedReplayCount: 0,
      cachedBaselineTokens: 0,
      cachedRevealedTokens: 0,
      ...(params.parentCumulativeInputTokens !== undefined
        ? {
            lastParentCumulativeInputTokens:
              params.parentCumulativeInputTokens,
          }
        : {}),
      summary: params.summary,
      ...(params.helperUsage ? { helperUsage: params.helperUsage } : {}),
    };
    await writePrivateFileAtomic(this.outputPath(objectId), params.output);
    await this.writeMetadata(metadata);
    await this.options.onMetadataUpdated?.(metadata);
    return metadata;
  }

  async readMetadata(objectId: string): Promise<TokenMiserObjectMetadata | undefined> {
    if (!isSafeObjectId(objectId)) {
      return undefined;
    }
    try {
      const raw = await fs.readFile(this.metadataPath(objectId), "utf8");
      const value = JSON.parse(raw) as TokenMiserObjectMetadata;
      return value?.version === 1 && value.objectId === objectId
        ? value
        : undefined;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async readLines(params: {
    objectId: string;
    threadId: string;
    startLine?: number;
    endLine?: number;
  }): Promise<TokenMiserReadResult | undefined> {
    const stored = await this.readAuthorizedObject(params.objectId, params.threadId);
    if (!stored) {
      return undefined;
    }
    const lines = splitLines(stored.output);
    const startLine = clampInteger(params.startLine ?? 1, 1, Math.max(1, lines.length));
    const requestedEnd = params.endLine ?? startLine + 199;
    const endLine = clampInteger(
      requestedEnd,
      startLine,
      Math.min(lines.length, startLine + MAX_READ_LINES - 1),
    );
    const text = lines.slice(startLine - 1, endLine).join("\n");
    const result = {
      objectId: params.objectId,
      startLine,
      endLine,
      totalLines: lines.length,
      text,
    };
    await this.recordRetrieval(params.objectId, JSON.stringify(result).length);
    return result;
  }

  async readAll(params: {
    objectId: string;
    threadId: string;
  }): Promise<TokenMiserReadResult | undefined> {
    const stored = await this.readAuthorizedObject(params.objectId, params.threadId);
    if (!stored) {
      return undefined;
    }
    const lines = splitLines(stored.output);
    const result = {
      objectId: params.objectId,
      startLine: 1,
      endLine: lines.length,
      totalLines: lines.length,
      text: stored.output,
    };
    await this.recordRetrieval(params.objectId, JSON.stringify(result).length);
    return result;
  }

  async search(params: {
    objectId: string;
    threadId: string;
    query: string;
    maxResults?: number;
  }): Promise<{ objectId: string; totalLines: number; matches: TokenMiserSearchMatch[] } | undefined> {
    const stored = await this.readAuthorizedObject(params.objectId, params.threadId);
    if (!stored) {
      return undefined;
    }
    const query = params.query.trim().toLocaleLowerCase();
    const lines = splitLines(stored.output);
    const maxResults = clampInteger(params.maxResults ?? 20, 1, MAX_SEARCH_RESULTS);
    const matches: TokenMiserSearchMatch[] = [];
    if (query) {
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        if (lines[index]!.toLocaleLowerCase().includes(query)) {
          matches.push({
            line: index + 1,
            text: lines[index]!,
          });
        }
      }
    }
    const result = {
      objectId: params.objectId,
      totalLines: lines.length,
      matches,
    };
    await this.recordRetrieval(params.objectId, JSON.stringify(result).length);
    return result;
  }

  async listMetadata(): Promise<TokenMiserObjectMetadata[]> {
    const entries = await fs.readdir(this.rootDir).catch((error: unknown) => {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    });
    const metadata = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(METADATA_SUFFIX))
        .map((entry) => this.readMetadata(entry.slice(0, -METADATA_SUFFIX.length))),
    );
    return metadata
      .filter((entry): entry is TokenMiserObjectMetadata => Boolean(entry))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async summarizeUsage(params?: {
    threadId?: string;
  }): Promise<TokenMiserUsageSummary> {
    const allMetadata = await this.listMetadata();
    const metadata = params?.threadId
      ? allMetadata.filter((entry) => entry.threadId === params.threadId)
      : allMetadata;
    return summarizeMetadata(metadata);
  }

  async summarizeThreadUsage(
    threadId: string,
  ): Promise<TokenMiserThreadUsageSummary> {
    const metadata = (await this.listMetadata()).filter(
      (entry) => entry.threadId === threadId,
    );
    return {
      ...summarizeMetadata(metadata),
      interceptions: metadata.map((entry) => {
        const replacementTokens = estimateTokenCount(
          entry.replacementCharacters,
        );
        const retrievedTokens = estimateTokenCount(entry.retrievedCharacters);
        return {
          objectId: entry.objectId,
          turnId: entry.turnId,
          toolUseId: entry.toolUseId,
          toolName: entry.toolName,
          createdAt: entry.createdAt,
          originalCharacters: entry.originalCharacters,
          baselineParentTokens: entry.baselineParentTokens,
          replacementTokens,
          retrievedTokens,
          estimatedParentTokensSaved:
            entry.baselineParentTokens - replacementTokens - retrievedTokens,
          cachedReplayCount: entry.cachedReplayCount ?? 0,
          cachedBaselineTokens: entry.cachedBaselineTokens ?? 0,
          cachedRevealedTokens: entry.cachedRevealedTokens ?? 0,
          estimatedCachedReplayTokensSaved:
            (entry.cachedBaselineTokens ?? 0)
            - (entry.cachedRevealedTokens ?? 0),
          ...(entry.replayTrackingVersion
            ? { replayTrackingVersion: entry.replayTrackingVersion }
            : {}),
          ...(entry.summary ? { summary: entry.summary } : {}),
        };
      }),
    };
  }

  async prune(params: {
    maxAgeMs: number;
    maxBytes: number;
    now?: number;
  }): Promise<void> {
    const now = params.now ?? Date.now();
    const metadata = await this.listMetadata();
    const retained: Array<{ metadata: TokenMiserObjectMetadata; bytes: number }> = [];
    for (const entry of metadata) {
      const outputPath = this.outputPath(entry.objectId);
      const stats = await fs.stat(outputPath).catch(() => undefined);
      if (!stats || now - entry.createdAt > params.maxAgeMs) {
        await this.remove(entry.objectId);
        continue;
      }
      retained.push({ metadata: entry, bytes: stats.size });
    }
    let totalBytes = retained.reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of retained.reverse()) {
      if (totalBytes <= params.maxBytes) {
        break;
      }
      await this.remove(entry.metadata.objectId);
      totalBytes -= entry.bytes;
    }
  }

  private async readAuthorizedObject(
    objectId: string,
    threadId: string,
  ): Promise<TokenMiserStoredObject | undefined> {
    const metadata = await this.readMetadata(objectId);
    if (!metadata || metadata.threadId !== threadId) {
      return undefined;
    }
    const output = await fs.readFile(this.outputPath(objectId), "utf8").catch(
      (error: unknown) => {
        if (isMissingFileError(error)) {
          return undefined;
        }
        throw error;
      },
    );
    return output === undefined ? undefined : { metadata, output };
  }

  private async recordRetrieval(objectId: string, characters: number): Promise<void> {
    if (characters <= 0) {
      return;
    }
    await this.updateMetadata(objectId, (metadata) => {
      metadata.retrievedCharacters += characters;
      return true;
    });
  }

  async recordParentModelRequest(params: {
    cumulativeInputTokens: number;
    objectId: string;
  }): Promise<TokenMiserObjectMetadata | undefined> {
    return await this.updateMetadata(params.objectId, (metadata) => {
      // The caller owns the request boundary: it holds one cursor for the whole
      // thread, so every gate is offered the same events. This per-gate mark
      // stays as a backstop against a caller that has no cursor, and it can
      // never disagree with one that does — the thread cursor is seeded from
      // the highest gate mark and only ever moves above it, so anything the
      // caller accepts is already above every gate's own mark.
      if (
        metadata.replayTrackingVersion !== 2
        || metadata.replayTrackingStoppedAt !== undefined
        || params.cumulativeInputTokens
          <= (metadata.lastParentCumulativeInputTokens ?? -1)
      ) {
        return false;
      }
      metadata.lastParentCumulativeInputTokens = params.cumulativeInputTokens;
      metadata.parentRequestsObservedAfterGate =
        (metadata.parentRequestsObservedAfterGate ?? 0) + 1;
      // The first completed request launched the tool whose output was gated.
      // The second is the first request that receives the replacement summary,
      // already priced as uncached input. Only later requests replay it from
      // cache and would have replayed the original payload from cache too.
      if (metadata.parentRequestsObservedAfterGate <= 2) {
        return true;
      }
      metadata.cachedReplayCount = (metadata.cachedReplayCount ?? 0) + 1;
      metadata.cachedBaselineTokens =
        (metadata.cachedBaselineTokens ?? 0) + metadata.baselineParentTokens;
      metadata.cachedRevealedTokens =
        (metadata.cachedRevealedTokens ?? 0)
        + estimateTokenCount(
          metadata.replacementCharacters + metadata.retrievedCharacters,
        );
      return true;
    });
  }

  async stopReplayTracking(params: {
    objectId: string;
    stoppedAt?: number;
  }): Promise<TokenMiserObjectMetadata | undefined> {
    return await this.updateMetadata(params.objectId, (metadata) => {
      if (
        metadata.replayTrackingVersion !== 2
        || metadata.replayTrackingStoppedAt !== undefined
      ) {
        return false;
      }
      metadata.replayTrackingStoppedAt = params.stoppedAt ?? Date.now();
      return true;
    });
  }

  private async updateMetadata(
    objectId: string,
    update: (metadata: TokenMiserObjectMetadata) => boolean,
  ): Promise<TokenMiserObjectMetadata | undefined> {
    const previous = this.updateLocks.get(objectId) ?? Promise.resolve();
    let updated: TokenMiserObjectMetadata | undefined;
    const next = previous.then(async () => {
      const metadata = await this.readMetadata(objectId);
      if (!metadata || !update(metadata)) {
        return;
      }
      await this.writeMetadata(metadata);
      await this.options.onMetadataUpdated?.(metadata);
      updated = metadata;
    });
    this.updateLocks.set(objectId, next);
    try {
      await next;
    } finally {
      if (this.updateLocks.get(objectId) === next) {
        this.updateLocks.delete(objectId);
      }
    }
    return updated;
  }

  private async remove(objectId: string): Promise<void> {
    await Promise.all([
      fs.rm(this.outputPath(objectId), { force: true }),
      fs.rm(this.metadataPath(objectId), { force: true }),
    ]);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  private async writeMetadata(metadata: TokenMiserObjectMetadata): Promise<void> {
    await writePrivateFileAtomic(
      this.metadataPath(metadata.objectId),
      `${JSON.stringify(metadata)}\n`,
    );
  }

  private metadataPath(objectId: string): string {
    return path.join(this.rootDir, `${objectId}${METADATA_SUFFIX}`);
  }

  private outputPath(objectId: string): string {
    return path.join(this.rootDir, `${objectId}${OUTPUT_SUFFIX}`);
  }
}

async function writePrivateFileAtomic(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function summarizeMetadata(
  metadata: TokenMiserObjectMetadata[],
): TokenMiserUsageSummary {
  const baselineParentTokens = metadata.reduce(
    (total, entry) => total + entry.baselineParentTokens,
    0,
  );
  const replacementTokens = metadata.reduce(
    (total, entry) => total + estimateTokenCount(entry.replacementCharacters),
    0,
  );
  const retrievedTokens = metadata.reduce(
    (total, entry) => total + estimateTokenCount(entry.retrievedCharacters),
    0,
  );
  const cachedBaselineTokens = metadata.reduce(
    (total, entry) => total + (entry.cachedBaselineTokens ?? 0),
    0,
  );
  const cachedRevealedTokens = metadata.reduce(
    (total, entry) => total + (entry.cachedRevealedTokens ?? 0),
    0,
  );
  return {
    interceptionCount: metadata.length,
    originalCharacters: metadata.reduce(
      (total, entry) => total + entry.originalCharacters,
      0,
    ),
    baselineParentTokens,
    replacementTokens,
    retrievedTokens,
    estimatedParentTokensSaved:
      baselineParentTokens - replacementTokens - retrievedTokens,
    cachedReplayCount: metadata.reduce(
      (total, entry) => total + (entry.cachedReplayCount ?? 0),
      0,
    ),
    cachedBaselineTokens,
    cachedRevealedTokens,
    estimatedCachedReplayTokensSaved:
      cachedBaselineTokens - cachedRevealedTokens,
  };
}

function isSafeObjectId(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : minimum;
  return Math.min(maximum, Math.max(minimum, normalized));
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
