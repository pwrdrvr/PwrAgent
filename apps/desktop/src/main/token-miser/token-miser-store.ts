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

export class TokenMiserStore {
  private readonly updateLocks = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

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
      summary: params.summary,
      ...(params.helperUsage ? { helperUsage: params.helperUsage } : {}),
    };
    await writePrivateFileAtomic(this.outputPath(objectId), params.output);
    await this.writeMetadata(metadata);
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
    await this.recordRetrieval(params.objectId, text.length);
    return {
      objectId: params.objectId,
      startLine,
      endLine,
      totalLines: lines.length,
      text,
    };
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
    await this.recordRetrieval(params.objectId, stored.output.length);
    return {
      objectId: params.objectId,
      startLine: 1,
      endLine: lines.length,
      totalLines: lines.length,
      text: stored.output,
    };
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
    const returnedCharacters = matches.reduce(
      (total, match) => total + match.text.length,
      0,
    );
    await this.recordRetrieval(params.objectId, returnedCharacters);
    return {
      objectId: params.objectId,
      totalLines: lines.length,
      matches,
    };
  }

  async listMetadata(): Promise<TokenMiserObjectMetadata[]> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir);
    const metadata = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(METADATA_SUFFIX))
        .map((entry) => this.readMetadata(entry.slice(0, -METADATA_SUFFIX.length))),
    );
    return metadata
      .filter((entry): entry is TokenMiserObjectMetadata => Boolean(entry))
      .sort((left, right) => right.createdAt - left.createdAt);
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
    const previous = this.updateLocks.get(objectId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const metadata = await this.readMetadata(objectId);
      if (!metadata) {
        return;
      }
      metadata.retrievedCharacters += characters;
      await this.writeMetadata(metadata);
    });
    this.updateLocks.set(objectId, next);
    try {
      await next;
    } finally {
      if (this.updateLocks.get(objectId) === next) {
        this.updateLocks.delete(objectId);
      }
    }
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
