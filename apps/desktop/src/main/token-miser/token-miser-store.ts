import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mapTokenMiserFiles, withTokenMiserFileOperation } from "./token-miser-file-io";
import { TokenMiserOutputCache } from "./token-miser-output-cache";
import { TokenMiserRecordIndex } from "./token-miser-record-index";
import {
  TOKEN_MISER_MODEL_VISIBLE_CAP_BYTES,
  estimateTokenCount,
  utf8ByteLength,
  type TokenMiserHelperUsage,
  type TokenMiserCodeModeObservation,
  type TokenMiserGroupMemberSummary,
  type TokenMiserObjectMetadata,
  type TokenMiserSummary,
} from "./token-miser-types.js";

const METADATA_SUFFIX = ".json";
const OUTPUT_SUFFIX = ".txt";
const OBSERVATION_DIRECTORY = "code-mode-observations";
const MAX_SEARCH_RESULTS = 100;
const MAX_READ_LINES = 2_000;
const MAX_GROUP_BATCH_OPERATIONS = 16;
const DEFAULT_GROUP_BATCH_OUTPUT_CHARACTERS = 20_000;
const MAX_GROUP_BATCH_OUTPUT_CHARACTERS = 40_000;
const RETRIEVAL_DELIVERY_TTL_MS = 2 * 60_000;
const REPLAY_COUNTER_KEYS = ["parentRequestsObservedAfterGate", "cachedReplayCount", "cachedBaselineTokens", "cachedRevealedTokens"] as const;
type ReplayCounter = typeof REPLAY_COUNTER_KEYS[number];
type PendingReplayUpdate = {
  view: TokenMiserObjectMetadata;
  deltas: Partial<Record<ReplayCounter, number>>;
  baseRequestEpoch?: string;
};

function mergeReplayUpdate(metadata: TokenMiserObjectMetadata, pending?: PendingReplayUpdate): TokenMiserObjectMetadata {
  if (!pending) return metadata;
  const merged = { ...metadata };
  for (const key of REPLAY_COUNTER_KEYS) {
    if (pending.deltas[key]) merged[key] = (metadata[key] ?? 0) + pending.deltas[key]!;
  }
  // A different epoch written since we buffered this work belongs to the
  // other instance. Do not replace its request cursor with our older epoch.
  if (metadata.parentRequestEpoch === pending.view.parentRequestEpoch) {
    merged.lastParentCumulativeInputTokens = Math.max(
      metadata.lastParentCumulativeInputTokens ?? -1,
      pending.view.lastParentCumulativeInputTokens ?? -1,
    );
  } else if (metadata.parentRequestEpoch === pending.baseRequestEpoch) {
    merged.parentRequestEpoch = pending.view.parentRequestEpoch;
    merged.lastParentCumulativeInputTokens = pending.view.lastParentCumulativeInputTokens;
  }
  return merged;
}

async function readStoredFile(filePath: string): Promise<string> {
  return await withTokenMiserFileOperation(() => fs.readFile(filePath, "utf8"));
}

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

export type TokenMiserGroupStoredMember = {
  objectId: string;
  toolCallId: string;
  toolName: string;
  output: string;
};

export type TokenMiserGroupStoredOutput = {
  version: 1;
  groupId: string;
  members: TokenMiserGroupStoredMember[];
};

export type TokenMiserGroupBatchOperation = {
  objectId: string;
  mode: "full" | "search" | "head" | "tail";
  query?: string;
  maxMatches?: number;
  lines?: number;
};

export type TokenMiserGroupBatchResult = {
  sourceObjectId: string;
  groupId: string;
  results: Array<{
    objectId: string;
    mode: TokenMiserGroupBatchOperation["mode"];
    text?: string;
    totalCharacters?: number;
    totalLines?: number;
    truncated?: boolean;
    error?: "member_not_found" | "query_required";
  }>;
  truncated: boolean;
};

export type TokenMiserRetrievalDelivery = {
  deliveryId: string;
  text: string;
};

type PendingRetrievalDelivery = {
  generation: string;
  createdAt: number;
  objectId: string;
  threadId: string;
  visibleText: string;
  visibleTextOffset: number;
  wrappedText: string;
};

export type TokenMiserUsageSummary = {
  interceptionCount: number;
  passThroughCount: number;
  policyPassThroughCount: number;
  helperPassThroughCount: number;
  helperDecisionCount: number;
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
    originalOutputAvailableUntil?: number;
    turnId: string;
    toolUseId: string;
    toolName: string;
    createdAt: number;
    originalCharacters: number;
    baselineParentTokens: number;
    replacementCharacters: number;
    replacementTokens: number;
    retrievedCharacters: number;
    retrievedTokens: number;
    estimatedParentTokensSaved: number;
    cachedReplayCount: number;
    cachedBaselineTokens: number;
    cachedRevealedTokens: number;
    estimatedCachedReplayTokensSaved: number;
    replayTrackingVersion?: 2;
    disposition?: "summarized" | "passed_through";
    decisionSource?: "helper" | "policy";
    groupMembers?: TokenMiserGroupMemberSummary[];
    summary?: TokenMiserSummary;
  }>;
  codeMode: {
    unclassifiedCellCount: number;
    callCount: number;
    commandCellCount: number | null;
    directCommandCellCount: number | null;
    dispatchClusterCount: number | null;
    multiInvocationClusterCount: number | null;
    largestDispatchCluster: number | null;
    nestedCommandInvocationCount: number | null;
    patchCellCount: number | null;
    otherCellCount: number | null;
    pollingCellCount: number | null;
    directCount: number;
    summarizedCount: number;
    passThroughCount: number;
    retrievalCount: number;
    capturedNestedInvocationCount: number | null;
    observations: Array<TokenMiserCodeModeObservation & {
      disposition: "direct" | "summarized" | "passed_through" | "retrieval";
    }>;
  };
};

/**
 * Why a metadata write happened. Replay-counter writes fire once per active
 * gate per model request and change nothing the gate card or its usage line
 * shows, so the registry can keep its in-memory view fresh without paying for
 * a full ledger republish on each one.
 */
export type TokenMiserMetadataUpdateReason =
  | "replay"
  | "retrieval"
  | "stopped"
  | "stored"
  | "flushed";

export type TokenMiserStoreOptions = {
  onMetadataUpdated?: (
    metadata: TokenMiserObjectMetadata,
    reason: TokenMiserMetadataUpdateReason,
  ) => void | Promise<void>;
  onCodeModeObservationUpdated?: (
    observation: TokenMiserCodeModeObservation,
  ) => void | Promise<void>;
};

export type TokenMiserStoreParams = {
  objectId?: string;
  threadId: string;
  turnId: string;
  toolUseId: string;
  toolName: string;
  output: string;
  /** UTF-8 bytes that could have entered the parent before preservation encoding. */
  baselineCharacters?: number;
  /**
   * Optional provider-enforced ceiling for the original model-visible result.
   * Code mode supplies its resolved `max_output_tokens`; direct hook results
   * retain the historical 10k-token cap below.
   */
  baselineParentTokenCap?: number;
  /** UTF-8 bytes; the legacy field name is retained in persisted metadata. */
  replacementCharacters: number;
  summary: TokenMiserSummary;
  disposition?: "summarized" | "passed_through";
  groupId?: string;
  groupMembers?: TokenMiserGroupMemberSummary[];
  helperUsage?: TokenMiserHelperUsage;
  parentCumulativeInputTokens?: number;
  parentModel?: string;
  parentServiceTier?: string;
  now?: number;
};

export type TokenMiserStagedObject = {
  metadata: TokenMiserObjectMetadata;
  /** Verify the temporary reservation before its replacement is delivered. */
  persist(): Promise<void>;
  /** Persist accepted accounting and publish its fixed decision note. */
  commit(): Promise<void>;
  /** Remove an object whose replacement was not accepted by the caller. */
  discard(): Promise<void>;
};

export class TokenMiserStore {
  private readonly archivedThreads = new Set<string>();
  private readonly outputs = new TokenMiserOutputCache();
  private readonly updateLocks = new Map<string, Promise<void>>();
  private readonly pendingRetrievalDeliveries =
    new Map<string, { createdAt: number; threadId: string }>();
  private readonly replayUpdates = new Map<string, PendingReplayUpdate>();
  private readonly outputGenerations = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly metadataIndexes = new Map<string, TokenMiserRecordIndex<TokenMiserObjectMetadata>>();
  private readonly observationIndexes = new Map<string, TokenMiserRecordIndex<TokenMiserCodeModeObservation>>();

  constructor(
    private readonly rootDir: string,
    private readonly options: TokenMiserStoreOptions = {},
  ) {}

  private threadKey(threadId: string): string {
    return createHash("sha256").update(threadId).digest("hex");
  }

  private threadRoot(key: string): string {
    return path.join(this.rootDir, "threads", key);
  }

  private async threadKeys(threadId?: string): Promise<string[]> {
    if (threadId !== undefined) return [this.threadKey(threadId)];
    return await withTokenMiserFileOperation(() => fs.readdir(path.join(this.rootDir, "threads")))
      .then((names) => names.filter((name) => /^[a-f0-9]{64}$/.test(name)))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
  }

  private metadataIndex(key: string): TokenMiserRecordIndex<TokenMiserObjectMetadata> {
    let index = this.metadataIndexes.get(key);
    if (!index) {
      index = new TokenMiserRecordIndex(this.threadRoot(key), async (name) => {
        const value = JSON.parse(await readStoredFile(path.join(this.threadRoot(key), name))) as TokenMiserObjectMetadata;
        if (value.version !== 1 || this.threadKey(value.threadId) !== key || `${value.objectId}.json` !== name) return undefined;
        this.owners.set(value.objectId, key);
        return value;
      });
      this.metadataIndexes.set(key, index);
    }
    return index;
  }

  private observationIndex(key: string): TokenMiserRecordIndex<TokenMiserCodeModeObservation> {
    let index = this.observationIndexes.get(key);
    if (!index) {
      const directory = path.join(this.threadRoot(key), OBSERVATION_DIRECTORY);
      index = new TokenMiserRecordIndex(directory, async (name) => {
        const value = JSON.parse(await readStoredFile(path.join(directory, name))) as TokenMiserCodeModeObservation;
        return value.version === 1 && this.threadKey(value.threadId) === key ? value : undefined;
      });
      this.observationIndexes.set(key, index);
    }
    return index;
  }

  async store(params: TokenMiserStoreParams): Promise<TokenMiserObjectMetadata> {
    const staged = await this.stage(params);
    await staged.commit();
    return staged.metadata;
  }

  async stage(params: TokenMiserStoreParams): Promise<TokenMiserStagedObject> {
    const generation = await this.readRetentionGeneration(params.threadId);
    if (await this.isArchived(params.threadId)) throw new Error("Token Miser originals are unavailable for an archived thread.");
    const objectId = params.objectId ?? randomUUID();
    if (!isSafeObjectId(objectId)) {
      throw new Error("Invalid Token Miser object id.");
    }
    if (await this.readMetadata(objectId, params.threadId)) throw new Error("Token Miser object id already exists.");
    const originalCharacters =
      params.baselineCharacters ?? utf8ByteLength(params.output);
    const metadata: TokenMiserObjectMetadata = {
      version: 1,
      objectId,
      threadId: params.threadId,
      turnId: params.turnId,
      toolUseId: params.toolUseId,
      toolName: params.toolName,
      createdAt: params.now ?? Date.now(),
      originalCharacters,
      baselineParentTokens: Math.min(
        estimateTokenCount(
          Math.min(originalCharacters, TOKEN_MISER_MODEL_VISIBLE_CAP_BYTES),
        ),
        normalizePositiveInteger(
          params.baselineParentTokenCap,
          Number.MAX_SAFE_INTEGER,
        ),
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
      summary: { summary: params.disposition === "passed_through" ? "Output passed through." : "Output summarized.", usefulDetails: [] },
      ...(params.disposition ? { disposition: params.disposition } : {}),
      ...(params.groupId ? { groupId: params.groupId } : {}),
      ...(params.groupMembers ? { groupMembers: params.groupMembers.map((member) => ({ objectId: member.objectId, toolCallId: member.toolCallId, toolName: member.toolName, summary: "Output summarized." })) } : {}),
      ...(params.helperUsage ? { helperUsage: safeHelperUsage(params.helperUsage) } : {}),
      ...(params.parentModel ? { parentModel: params.parentModel } : {}),
      ...(params.parentServiceTier
        ? { parentServiceTier: params.parentServiceTier }
        : {}),
    };
    if (this.owners.has(objectId)) throw new Error("Token Miser object id already reserved.");
    // Reserve before returning a replacement. The closure retains no raw text.
    const retained = params.disposition === "passed_through"
      || this.outputs.put(objectId, params.output);
    if (!retained) throw new Error("Token Miser temporary output capacity exceeded.");
    this.owners.set(objectId, this.threadKey(params.threadId));
    this.outputGenerations.set(objectId, generation);
    let persisted = false;
    let committed = false;
    let discarded = false;
    let operation = Promise.resolve();
    const serialize = async (next: () => Promise<void>): Promise<void> => {
      operation = operation.catch(() => undefined).then(next);
      await operation;
    };
    const persist = async (): Promise<void> => {
      await serialize(async () => {
        if (!await this.isCurrentRetention(metadata.threadId, generation)) {
          this.outputs.remove(objectId);
          throw new Error("Token Miser original output expired or unavailable.");
        }
        if (persisted || committed || discarded) {
          return;
        }
        if (metadata.disposition !== "passed_through" && this.outputs.get(objectId) === undefined) {
          throw new Error("Token Miser original output expired or unavailable.");
        }
        persisted = true;
      });
    };
    return {
      metadata,
      persist,
      commit: async () => {
        await serialize(async () => {
          if (committed || discarded) {
            return;
          }
          if (!await this.isCurrentRetention(metadata.threadId, generation)) {
            this.outputs.remove(objectId);
            throw new Error("Token Miser original output expired or unavailable.");
          }
          if (!persisted) {
            if (metadata.disposition !== "passed_through" && this.outputs.get(objectId) === undefined) {
              throw new Error("Token Miser original output expired or unavailable.");
            }
            persisted = true;
          }
          await this.writeMetadata(metadata);
          committed = true;
          await this.options.onMetadataUpdated?.(metadata, "stored");
        });
      },
      discard: async () => {
        await serialize(async () => {
          if (committed || discarded) {
            return;
          }
          await this.remove(objectId);
          persisted = false;
          discarded = true;
        });
      },
    };
  }

  async readMetadata(objectId: string, threadId?: string): Promise<TokenMiserObjectMetadata | undefined> {
    const metadata = await this.readDurableMetadata(objectId, threadId);
    return metadata ? mergeReplayUpdate(metadata, this.replayUpdates.get(objectId)) : undefined;
  }

  private async readDurableMetadata(objectId: string, threadId?: string): Promise<TokenMiserObjectMetadata | undefined> {
    if (!isSafeObjectId(objectId)) {
      return undefined;
    }
    if (threadId === undefined && !this.owners.has(objectId)) await this.listMetadata();
    const key = threadId === undefined ? this.owners.get(objectId) : this.threadKey(threadId);
    if (!key) return undefined;
    try {
      const raw = await readStoredFile(path.join(this.threadRoot(key), `${objectId}.json`));
      const value = JSON.parse(raw) as TokenMiserObjectMetadata;
      return value?.version === 1 && value.objectId === objectId && this.threadKey(value.threadId) === key
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
    if (!stored || stored.metadata.groupId) {
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
    return result;
  }

  async readAll(params: {
    objectId: string;
    threadId: string;
  }): Promise<TokenMiserReadResult | undefined> {
    const stored = await this.readAuthorizedObject(params.objectId, params.threadId);
    if (!stored || stored.metadata.groupId) {
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
    return result;
  }

  async search(params: {
    objectId: string;
    threadId: string;
    query: string;
    maxResults?: number;
  }): Promise<{ objectId: string; totalLines: number; matches: TokenMiserSearchMatch[] } | undefined> {
    const stored = await this.readAuthorizedObject(params.objectId, params.threadId);
    if (!stored || stored.metadata.groupId) {
      return undefined;
    }
    // Locale-independent: toLocaleLowerCase maps I to a dotless i under tr/az,
    // so a Turkish-locale host would miss matches that are plainly present.
    const query = params.query.trim().toLowerCase();
    const lines = splitLines(stored.output);
    const maxResults = clampInteger(params.maxResults ?? 20, 1, MAX_SEARCH_RESULTS);
    const matches: TokenMiserSearchMatch[] = [];
    if (query) {
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        if (lines[index]!.toLowerCase().includes(query)) {
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
    return result;
  }

  async readGroupBatch(params: {
    groupId: string;
    threadId: string;
    operations: TokenMiserGroupBatchOperation[];
    maxOutputChars?: number;
  }): Promise<TokenMiserGroupBatchResult | undefined> {
    const metadata = (await this.listMetadata(params.threadId)).find((entry) =>
      entry.groupId === params.groupId
    );
    if (!metadata || !metadata.groupMembers?.length) {
      return undefined;
    }
    const stored = await this.readAuthorizedObject(
      metadata.objectId,
      params.threadId,
    );
    if (!stored) {
      return undefined;
    }
    const group = parseGroupStoredOutput(stored.output, params.groupId);
    if (!group) {
      return undefined;
    }
    const operations = params.operations.slice(0, MAX_GROUP_BATCH_OPERATIONS);
    const members = new Map(group.members.map((member) => [member.objectId, member]));
    const results = operations.map((operation) =>
      readGroupMember(members.get(operation.objectId), operation)
    );
    const maxOutputChars = clampInteger(
      params.maxOutputChars ?? DEFAULT_GROUP_BATCH_OUTPUT_CHARACTERS,
      5_000,
      MAX_GROUP_BATCH_OUTPUT_CHARACTERS,
    );
    const result = boundGroupBatchResult({
      sourceObjectId: metadata.objectId,
      groupId: params.groupId,
      results,
      truncated: params.operations.length > operations.length,
    }, maxOutputChars);
    return result;
  }

  async prepareRetrievalDelivery(params: {
    objectId: string;
    threadId: string;
    visibleText: string;
  }): Promise<TokenMiserRetrievalDelivery | undefined> {
    const generation = this.outputGenerations.get(params.objectId);
    if (!await this.isCurrentRetention(params.threadId, generation)) return undefined;
    const metadata = await this.readMetadata(params.objectId, params.threadId);
    if (
      !metadata
      || metadata.threadId !== params.threadId
      || metadata.disposition === "passed_through"
    ) {
      return undefined;
    }
    const now = Date.now();
    for (const [deliveryId, pending] of this.pendingRetrievalDeliveries) {
      if (now - pending.createdAt > RETRIEVAL_DELIVERY_TTL_MS) {
        this.pendingRetrievalDeliveries.delete(deliveryId);
      }
    }
    const deliveryId = randomUUID();
    const begin = `<pwragent_token_miser_retrieval id="${deliveryId}">`;
    const end = `</pwragent_token_miser_retrieval id="${deliveryId}">`;
    const wrappedText = `${begin}\n${params.visibleText}\n${end}`;
    if (!this.outputs.put(deliveryId, JSON.stringify({
      generation,
      createdAt: now,
      objectId: params.objectId,
      threadId: params.threadId,
      visibleText: params.visibleText,
      visibleTextOffset: begin.length + 1,
      wrappedText,
    }))) return undefined;
    this.pendingRetrievalDeliveries.set(deliveryId, { createdAt: now, threadId: params.threadId });
    return { deliveryId, text: wrappedText };
  }

  /** Match only live, thread-owned deliveries, never script text or marker syntax. */
  async partitionRetrievalOutput(params: { output: string; threadId: string }): Promise<Array<{
    text: string;
    retrieval: boolean;
  }>> {
    if (await this.isArchived(params.threadId)) {
      return [{ text: params.output, retrieval: false }];
    }
    const generation = await this.readRetentionGeneration(params.threadId);
    const matches = [...this.pendingRetrievalDeliveries.entries()]
      .filter(([, reference]) => reference.threadId === params.threadId)
      .flatMap(([deliveryId, reference]) => {
        const text = this.outputs.get(deliveryId);
        if (!text || Date.now() - reference.createdAt > RETRIEVAL_DELIVERY_TTL_MS) {
          this.abandonRetrievalDelivery(deliveryId);
          return [];
        }
        const pending = JSON.parse(text) as PendingRetrievalDelivery;
        if (pending.generation !== generation) return [];
        const matches: Array<{ start: number; end: number }> = [];
        let start = params.output.indexOf(pending.wrappedText);
        while (start >= 0) {
          matches.push({ start, end: start + pending.wrappedText.length });
          start = params.output.indexOf(pending.wrappedText, start + pending.wrappedText.length);
        }
        return matches;
      })
      .sort((left, right) => left.start - right.start);
    const parts: Array<{ text: string; retrieval: boolean }> = [];
    let offset = 0;
    for (const match of matches) {
      if (match.start < offset) continue;
      if (match.start > offset) {
        parts.push({ text: params.output.slice(offset, match.start), retrieval: false });
      }
      parts.push({ text: params.output.slice(match.start, match.end), retrieval: true });
      offset = match.end;
    }
    if (offset < params.output.length) {
      parts.push({ text: params.output.slice(offset), retrieval: false });
    }
    return parts;
  }

  async confirmModelVisibleRetrievals(params: {
    maxVisibleBytes?: number;
    output: string;
    threadId: string;
  }): Promise<number> {
    // One Code Mode cell can emit several individually bounded retrievals, but
    // Codex applies one shared ceiling to the outer result. Its truncator keeps
    // both the beginning and end, so attribute only the intersections with
    // those exact UTF-8 byte-budgeted ranges.
    if (await this.isArchived(params.threadId)) return 0;
    const generation = await this.readRetentionGeneration(params.threadId);
    const candidates = [...this.pendingRetrievalDeliveries.entries()]
      .filter(([, pending]) => pending.threadId === params.threadId)
      .flatMap(([deliveryId, reference]) => {
        const text = this.outputs.get(deliveryId);
        if (!text || Date.now() - reference.createdAt > RETRIEVAL_DELIVERY_TTL_MS) {
          this.abandonRetrievalDelivery(deliveryId);
          return [];
        }
        const pending = JSON.parse(text) as PendingRetrievalDelivery;
        return [{ deliveryId, outputOffset: params.output.indexOf(pending.wrappedText), pending }];
      })
      .filter((candidate) => candidate.outputOffset >= 0)
      .sort((left, right) => left.outputOffset - right.outputOffset);
    const visibleRanges = codexVisibleStringRanges(
      params.output,
      normalizePositiveInteger(params.maxVisibleBytes, Number.MAX_SAFE_INTEGER),
    );
    let confirmedCharacters = 0;
    for (const { deliveryId, outputOffset, pending } of candidates) {
      this.abandonRetrievalDelivery(deliveryId);
      if (pending.generation !== generation) continue;
      let visibleCharacters = 0;
      let occurrence = outputOffset;
      // A cell can emit the same delivery more than once. Each visible copy
      // enters context, but update its metadata only once per delivery.
      while (occurrence >= 0) {
        const visibleTextStart = occurrence + pending.visibleTextOffset;
        const visibleTextEnd = visibleTextStart + pending.visibleText.length;
        visibleCharacters += visibleRanges.reduce((total, range) => {
          const start = Math.max(visibleTextStart, range.start);
          const end = Math.min(visibleTextEnd, range.end);
          return end > start
            ? total + utf8ByteLength(params.output.slice(start, end))
            : total;
        }, 0);
        occurrence = params.output.indexOf(
          pending.wrappedText,
          occurrence + pending.wrappedText.length,
        );
      }
      await this.recordRetrieval(pending.objectId, visibleCharacters);
      confirmedCharacters += visibleCharacters;
    }
    return confirmedCharacters;
  }

  abandonRetrievalDelivery(deliveryId: string): void {
    this.pendingRetrievalDeliveries.delete(deliveryId);
    this.outputs.remove(deliveryId);
  }

  async listMetadata(threadId?: string): Promise<TokenMiserObjectMetadata[]> {
    return (await mapTokenMiserFiles(await this.threadKeys(threadId), (key) => this.metadataIndex(key).list(threadId))).flat()
      .map((entry) => mergeReplayUpdate(entry, this.replayUpdates.get(entry.objectId)))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async recordCodeModeObservation(params: Omit<
    TokenMiserCodeModeObservation,
    "version" | "observationId" | "createdAt"
  > & { createdAt?: number }, publish = true): Promise<TokenMiserCodeModeObservation> {
    const observationId = createHash("sha256")
      .update(JSON.stringify([params.threadId, params.turnId, params.callId]))
      .digest("hex");
    const observation: TokenMiserCodeModeObservation = {
      version: 1,
      observationId,
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      cellId: params.cellId,
      createdAt: params.createdAt ?? Date.now(),
      outputCharacters: params.outputCharacters,
      maxOutputTokens: params.maxOutputTokens,
      scriptStatus: ["completed", "running", "failed", "cancelled"].includes(params.scriptStatus) ? params.scriptStatus : "unknown",
      retrieval: params.retrieval,
      capturedNestedInvocationCount: params.capturedNestedInvocationCount,
      ...(params.capturedCommandInvocationCount === undefined
        ? {}
        : { capturedCommandInvocationCount: params.capturedCommandInvocationCount }),
      ...(params.capturedPollingInvocationCount === undefined
        ? {}
        : { capturedPollingInvocationCount: params.capturedPollingInvocationCount }),
      ...(params.capturedPatchInvocationCount === undefined
        ? {}
        : { capturedPatchInvocationCount: params.capturedPatchInvocationCount }),
      ...(params.capturedOtherInvocationCount === undefined
        ? {}
        : { capturedOtherInvocationCount: params.capturedOtherInvocationCount }),
    };
    await fs.mkdir(this.observationRoot(params.threadId), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomic(
      this.observationPath(observationId, params.threadId),
      `${JSON.stringify(observation)}\n`,
    );
    this.observationIndex(this.threadKey(observation.threadId)).remember(`${observationId}${METADATA_SUFFIX}`, observation.threadId);
    if (publish) await this.options.onCodeModeObservationUpdated?.(observation);
    return observation;
  }

  async listCodeModeObservations(
    threadId?: string,
  ): Promise<TokenMiserCodeModeObservation[]> {
    return (await mapTokenMiserFiles(await this.threadKeys(threadId), (key) => this.observationIndex(key).list(threadId))).flat()
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async summarizeUsage(params?: {
    threadId?: string;
  }): Promise<TokenMiserUsageSummary> {
    const metadata = await this.listMetadata(params?.threadId);
    return summarizeMetadata(metadata);
  }

  async summarizeThreadUsage(
    threadId: string,
    metadataSnapshot?: TokenMiserObjectMetadata[],
  ): Promise<TokenMiserThreadUsageSummary> {
    // Accounting and savings can share the same current metadata snapshot.
    const metadata = (metadataSnapshot ?? await this.listMetadata(threadId))
      .filter((entry) => entry.threadId === threadId);
    const generation = metadata.some((entry) => this.outputs.expiresAt(entry.objectId) !== undefined)
      ? await this.readRetentionGeneration(threadId)
      : undefined;
    const archived = await this.isArchived(threadId);
    const observations = await this.listCodeModeObservations(threadId);
    const metadataByToolUseId = new Map(
      metadata.map((entry) => [entry.toolUseId, entry]),
    );
    const codeModeObservations = observations.map((observation) => {
      const disposition = observation.retrieval
        ? "retrieval" as const
        : metadataByToolUseId.get(observation.callId)?.disposition
          ?? "direct" as const;
      // Legacy zeroes meant no hooks arrived, not that no tools executed.
      const capturedNestedInvocationCount = observation.capturedNestedInvocationCount || null;
      return { ...observation, capturedNestedInvocationCount, disposition };
    });
    const capturedCells = codeModeObservations.filter(
      (entry) => entry.capturedNestedInvocationCount !== null,
    );
    const capturedCount = (count: number) => capturedCells.length > 0 ? count : null;
    const commandCount = (entry: TokenMiserCodeModeObservation) =>
      entry.capturedCommandInvocationCount
      ?? (entry.retrieval ? 0 : entry.capturedNestedInvocationCount ?? 0);
    const commandCells = codeModeObservations.filter(
      (entry) => commandCount(entry) > 0,
    );
    const dispatchClusterSizes = commandCells.map(
      commandCount,
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
          originalOutputAvailableUntil: archived || this.outputGenerations.get(entry.objectId) !== generation
            ? undefined
            : this.outputs.expiresAt(entry.objectId),
          turnId: entry.turnId,
          toolUseId: entry.toolUseId,
          toolName: entry.toolName,
          createdAt: entry.createdAt,
          originalCharacters: entry.originalCharacters,
          baselineParentTokens: entry.baselineParentTokens,
          replacementCharacters: entry.replacementCharacters,
          replacementTokens,
          retrievedCharacters: entry.retrievedCharacters,
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
          ...(entry.disposition ? { disposition: entry.disposition } : {}),
          ...(entry.helperUsage
            ? { decisionSource: "helper" as const }
            : entry.disposition === "passed_through"
              ? { decisionSource: "policy" as const }
              : {}),
          ...(entry.groupMembers ? { groupMembers: entry.groupMembers } : {}),
          ...(entry.summary ? { summary: entry.summary } : {}),
        };
      }),
      codeMode: {
        unclassifiedCellCount: codeModeObservations.length - capturedCells.length,
        callCount: codeModeObservations.length,
        commandCellCount: capturedCount(commandCells.length),
        directCommandCellCount: capturedCount(commandCells.filter(
          (entry) => entry.disposition === "direct",
        ).length),
        dispatchClusterCount: capturedCount(dispatchClusterSizes.length),
        multiInvocationClusterCount: capturedCount(dispatchClusterSizes.filter(
          (size) => size > 1,
        ).length),
        largestDispatchCluster: capturedCells.length === 0
          ? null
          : dispatchClusterSizes.length > 0
            ? Math.max(...dispatchClusterSizes)
            : 0,
        nestedCommandInvocationCount: capturedCount(dispatchClusterSizes.reduce(
          (total, size) => total + size,
          0,
        )),
        patchCellCount: capturedCount(capturedCells.filter(
          (entry) => (entry.capturedPatchInvocationCount ?? 0) > 0,
        ).length),
        otherCellCount: capturedCount(capturedCells.filter(
          (entry) => !entry.retrieval
            && (
              entry.capturedNestedInvocationCount === 0
              || (entry.capturedOtherInvocationCount ?? 0) > 0
            ),
        ).length),
        pollingCellCount: capturedCount(capturedCells.filter(
          (entry) => (entry.capturedPollingInvocationCount ?? 0) > 0,
        ).length),
        directCount: codeModeObservations.filter(
          (entry) => entry.disposition === "direct",
        ).length,
        summarizedCount: codeModeObservations.filter(
          (entry) => entry.disposition === "summarized",
        ).length,
        passThroughCount: codeModeObservations.filter(
          (entry) => entry.disposition === "passed_through",
        ).length,
        retrievalCount: codeModeObservations.filter(
          (entry) => entry.disposition === "retrieval",
        ).length,
        capturedNestedInvocationCount: capturedCount(codeModeObservations.reduce(
          (total, entry) => total + (entry.capturedNestedInvocationCount ?? 0),
          0,
        )),
        observations: codeModeObservations,
      },
    };
  }

  async flushThread(threadId: string): Promise<void> {
    for (const [objectId, pending] of this.replayUpdates) {
      if (pending.view.threadId !== threadId) continue;
      await this.updateMetadata(objectId, () => true, "flushed");
    }
  }

  async flushAll(): Promise<void> {
    // The caller stops event producers before draining. Include updates that
    // have entered the serialization queue but have not reached the buffer.
    await Promise.allSettled([...this.updateLocks.values()]);
    const failures: unknown[] = [];
    for (const objectId of [...this.replayUpdates.keys()]) {
      try { await this.updateMetadata(objectId, () => true, "flushed"); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Token Miser replay flush failed");
  }

  private async isArchived(threadId: string): Promise<boolean> {
    return this.archivedThreads.has(threadId) || await this.hasArchiveMarker(threadId);
  }

  private async hasArchiveMarker(threadId: string): Promise<boolean> {
    return await withTokenMiserFileOperation(() => fs.stat(path.join(this.threadRoot(this.threadKey(threadId)), "archived")))
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
  }

  private async readRetentionGeneration(threadId: string): Promise<string> {
    return await readStoredFile(path.join(this.threadRoot(this.threadKey(threadId)), "retention-generation"))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
  }

  private async isCurrentRetention(threadId: string, generation: string | undefined): Promise<boolean> {
    return generation !== undefined
      && !await this.isArchived(threadId)
      && generation === await this.readRetentionGeneration(threadId);
  }

  async restoreThread(threadId: string): Promise<void> {
    const root = this.threadRoot(this.threadKey(threadId));
    // Atomically remove the archive marker and retain its unique generation.
    // Duplicate restoration cannot rotate the generation of newly staged work.
    await withTokenMiserFileOperation(() => fs.rename(
      path.join(root, "archived"),
      path.join(root, "retention-generation"),
    )).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        this.archivedThreads.add(threadId);
        throw error;
      }
    });
    this.archivedThreads.delete(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    const key = this.threadKey(threadId);
    this.archivedThreads.add(threadId);
    for (const [objectId, owner] of this.owners) {
      if (owner === key) this.outputs.remove(objectId);
    }
    for (const [id, pending] of this.pendingRetrievalDeliveries) {
      if (pending.threadId === threadId) this.abandonRetrievalDelivery(id);
    }
    await fs.mkdir(this.threadRoot(key), { recursive: true, mode: 0o700 });
    if (!await this.hasArchiveMarker(threadId)) await writePrivateFileAtomic(path.join(this.threadRoot(key), "archived"), `${randomUUID()}\n`);
    // Successful persistence is authoritative across instances, including a
    // later restore elsewhere. Keep the local guard only on write failure.
    this.archivedThreads.delete(threadId);
    await this.flushThread(threadId);
  }

  async prune(_params: { maxAgeMs: number; maxBytes: number; now?: number }): Promise<void> {
    // Only legacy flat files are migrated; safe accounting has no payload TTL.
    // Startup migration must not create a profile before onboarding selects it.
    const directory = await fs.opendir(this.rootDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!directory) return;
    for await (const entry of directory) {
      if (!entry.isFile()) continue;
      const file = path.join(this.rootDir, entry.name);
      if (entry.name.endsWith(".txt") || entry.name.endsWith(".tmp")) {
        await withTokenMiserFileOperation(() => fs.rm(file, { force: true }));
      } else if (entry.name.endsWith(".json")) {
        const metadata = JSON.parse(await readStoredFile(file)) as TokenMiserObjectMetadata;
        if (metadata.version !== 1 || !isSafeObjectId(metadata.objectId) || typeof metadata.threadId !== "string") {
          throw new Error("Invalid legacy Token Miser accounting record; migration stopped.");
        }
        metadata.summary = { summary: metadata.disposition === "passed_through" ? "Output passed through." : "Output summarized.", usefulDetails: [] };
        metadata.groupMembers = metadata.groupMembers?.map((member) => ({ objectId: member.objectId, toolCallId: member.toolCallId, toolName: member.toolName, summary: "Output summarized." }));
        if (!await this.readMetadata(metadata.objectId, metadata.threadId)) await this.writeMetadata(metadata);
        await withTokenMiserFileOperation(() => fs.rm(file, { force: true }));
      }
    }
    const legacy = await fs.opendir(path.join(this.rootDir, OBSERVATION_DIRECTORY)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (legacy) for await (const entry of legacy) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(this.rootDir, OBSERVATION_DIRECTORY, entry.name);
      const observation = JSON.parse(await readStoredFile(file)) as TokenMiserCodeModeObservation;
      if (observation.version !== 1 || typeof observation.threadId !== "string") throw new Error("Invalid legacy Token Miser observation; migration stopped.");
      await this.recordCodeModeObservation(observation, false);
      await withTokenMiserFileOperation(() => fs.rm(file, { force: true }));
    }
  }

  private async readAuthorizedObject(
    objectId: string,
    threadId: string,
  ): Promise<TokenMiserStoredObject | undefined> {
    if (!await this.isCurrentRetention(threadId, this.outputGenerations.get(objectId))) return undefined;
    const metadata = await this.readMetadata(objectId, threadId);
    if (
      !metadata
      || metadata.threadId !== threadId
      || metadata.disposition === "passed_through"
    ) {
      return undefined;
    }
    const output = this.outputs.get(objectId);
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
    requestEpoch?: string;
  }): Promise<TokenMiserObjectMetadata | undefined> {
    return await this.updateMetadata(params.objectId, (metadata) => {
      // The caller owns the request boundary: it holds one cursor for the whole
      // thread, so every gate is offered the same events. This per-gate mark
      // stays as a backstop against a caller that has no cursor, and it can
      // never disagree with one that does — the thread cursor is seeded from
      // the highest gate mark and only ever moves above it, so anything the
      // caller accepts is already above every gate's own mark.
      const requestEpochChanged = Boolean(
        params.requestEpoch
        && params.requestEpoch !== metadata.parentRequestEpoch,
      );
      if (
        metadata.replayTrackingVersion !== 2
        || metadata.replayTrackingStoppedAt !== undefined
        || (
          !requestEpochChanged
          && params.cumulativeInputTokens
            <= (metadata.lastParentCumulativeInputTokens ?? -1)
        )
      ) {
        return false;
      }
      if (params.requestEpoch) {
        metadata.parentRequestEpoch = params.requestEpoch;
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
    }, "replay");
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
    }, "stopped");
  }

  private async updateMetadata(
    objectId: string,
    update: (metadata: TokenMiserObjectMetadata) => boolean,
    reason: TokenMiserMetadataUpdateReason = "retrieval",
  ): Promise<TokenMiserObjectMetadata | undefined> {
    // Swallow the predecessor's rejection: this chain only serializes access,
    // so one failed write must not stop every queued update behind it from
    // running — which would silently retire the gate.
    const previous = (this.updateLocks.get(objectId) ?? Promise.resolve())
      .catch(() => undefined);
    let updated: TokenMiserObjectMetadata | undefined;
    const next = previous.then(async () => {
      const pending = this.replayUpdates.get(objectId);
      if (reason === "flushed" && !pending) return;
      // Replay events stay in RAM. Persistence boundaries always merge our
      // counter deltas into fresh disk state, preserving retirement/retrieval.
      const current = reason === "replay" && pending
        ? pending.view
        : await this.readMetadata(objectId);
      if (!current) {
        this.replayUpdates.delete(objectId);
        return;
      }
      const metadata = { ...current };
      if (!update(metadata)) {
        return;
      }
      if (reason === "replay") {
        const deltas = { ...pending?.deltas };
        for (const key of REPLAY_COUNTER_KEYS) {
          const delta = (metadata[key] ?? 0) - (current[key] ?? 0);
          if (delta) deltas[key] = (deltas[key] ?? 0) + delta;
        }
        this.replayUpdates.set(objectId, {
          view: metadata, deltas,
          baseRequestEpoch: pending ? pending.baseRequestEpoch : current.parentRequestEpoch,
        });
      } else {
        await this.writeMetadata(metadata);
        this.replayUpdates.delete(objectId);
      }
      await this.options.onMetadataUpdated?.(metadata, reason);
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
    this.outputs.remove(objectId);
    await Promise.all([
      fs.rm(this.outputPath(objectId), { force: true }),
      fs.rm(this.metadataPath(objectId), { force: true }),
    ]);
    this.metadataIndex(this.owners.get(objectId)!).forget(`${objectId}${METADATA_SUFFIX}`);
  }

  private async writeMetadata(metadata: TokenMiserObjectMetadata): Promise<void> {
    await fs.mkdir(this.threadRoot(this.threadKey(metadata.threadId)), { recursive: true, mode: 0o700 });
    this.owners.set(metadata.objectId, this.threadKey(metadata.threadId));
    await writePrivateFileAtomic(
      this.metadataPath(metadata.objectId),
      `${JSON.stringify(safeMetadata(metadata))}\n`,
    );
    this.metadataIndex(this.threadKey(metadata.threadId)).remember(`${metadata.objectId}${METADATA_SUFFIX}`, metadata.threadId);
  }

  private metadataPath(objectId: string): string {
    return path.join(this.threadRoot(this.owners.get(objectId)!), `${objectId}${METADATA_SUFFIX}`);
  }

  private outputPath(objectId: string): string {
    return path.join(this.rootDir, `${objectId}${OUTPUT_SUFFIX}`);
  }

  private observationRoot(threadId: string): string {
    return path.join(this.threadRoot(this.threadKey(threadId)), OBSERVATION_DIRECTORY);
  }

  private observationPath(observationId: string, threadId: string): string {
    return path.join(this.observationRoot(threadId), `${observationId}${METADATA_SUFFIX}`);
  }
}

function safeHelperUsage(value: TokenMiserHelperUsage): TokenMiserHelperUsage {
  return {
    helperThreadId: value.helperThreadId,
    helperTurnId: value.helperTurnId,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    serviceTier: value.serviceTier,
    tokenUsage: safeTokenUsage(value.tokenUsage),
  };
}

function safeTokenUsage(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const result: Record<string, unknown> = {};
  const counts = new Set(["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens", "modelContextWindow", "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "reasoning_output_tokens", "cache_read_input_tokens", "cached_tokens", "reasoning_tokens"]);
  const containers = new Set(["tokenUsage", "token_usage", "info", "last", "last_token_usage", "total", "total_token_usage", "data", "payload", "usage", "result", "input_tokens_details", "output_tokens_details"]);
  for (const [key, entry] of Object.entries(value)) {
    if (counts.has(key) && typeof entry === "number" && Number.isFinite(entry) && entry >= 0) result[key] = entry;
    else if (containers.has(key)) result[key] = safeTokenUsage(entry, depth + 1);
  }
  return result;
}

function safeMetadata(value: TokenMiserObjectMetadata): TokenMiserObjectMetadata {
  const result = {} as TokenMiserObjectMetadata;
  // Deliberate allowlist: legacy JSON and helper objects may have extra content.
  const keys = ["version", "objectId", "threadId", "turnId", "toolUseId", "toolName", "createdAt", "originalCharacters", "baselineParentTokens", "replacementCharacters", "retrievedCharacters", "replayTrackingVersion", "parentRequestsObservedAfterGate", "lastParentCumulativeInputTokens", "cachedReplayCount", "cachedBaselineTokens", "cachedRevealedTokens", "replayTrackingStoppedAt", "parentRequestEpoch", "disposition", "groupId", "parentModel", "parentServiceTier"] as const;
  for (const key of keys) {
    Object.assign(result, { [key]: value[key] });
  }
  result.summary = { summary: value.disposition === "passed_through" ? "Output passed through." : "Output summarized.", usefulDetails: [] };
  if (value.helperUsage) result.helperUsage = safeHelperUsage(value.helperUsage);
  if (value.groupMembers) result.groupMembers = value.groupMembers.map((member) => ({
    objectId: member.objectId, toolCallId: member.toolCallId, toolName: member.toolName, summary: "Output summarized.",
  }));
  return result;
}

async function writePrivateFileAtomic(filePath: string, contents: string): Promise<void> {
  await withTokenMiserFileOperation(async () => {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
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
    passThroughCount: metadata.filter(
      (entry) => entry.disposition === "passed_through",
    ).length,
    policyPassThroughCount: metadata.filter(
      (entry) => entry.disposition === "passed_through" && !entry.helperUsage,
    ).length,
    helperPassThroughCount: metadata.filter(
      (entry) => entry.disposition === "passed_through" && Boolean(entry.helperUsage),
    ).length,
    helperDecisionCount: metadata.filter(
      (entry) => Boolean(entry.helperUsage),
    ).length,
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

function parseGroupStoredOutput(
  value: string,
  groupId: string,
): TokenMiserGroupStoredOutput | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<TokenMiserGroupStoredOutput>;
    if (
      parsed.version !== 1
      || parsed.groupId !== groupId
      || !Array.isArray(parsed.members)
      || !parsed.members.every((member) =>
        member
        && typeof member.objectId === "string"
        && typeof member.toolCallId === "string"
        && typeof member.toolName === "string"
        && typeof member.output === "string"
      )
    ) {
      return undefined;
    }
    return parsed as TokenMiserGroupStoredOutput;
  } catch {
    return undefined;
  }
}

function readGroupMember(
  member: TokenMiserGroupStoredMember | undefined,
  operation: TokenMiserGroupBatchOperation,
): TokenMiserGroupBatchResult["results"][number] {
  if (!member) {
    return {
      objectId: operation.objectId,
      mode: operation.mode,
      error: "member_not_found",
    };
  }
  const lines = splitLines(member.output);
  let text: string;
  if (operation.mode === "search") {
    const query = operation.query?.trim().toLowerCase();
    if (!query) {
      return {
        objectId: operation.objectId,
        mode: operation.mode,
        error: "query_required",
      };
    }
    const maxMatches = clampInteger(operation.maxMatches ?? 20, 1, 100);
    const matches: string[] = [];
    for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
      if (lines[index]!.toLowerCase().includes(query)) {
        matches.push(`${index + 1}: ${lines[index]}`);
      }
    }
    text = matches.join("\n");
  } else if (operation.mode === "head") {
    const count = clampInteger(operation.lines ?? 100, 1, 500);
    text = lines.slice(0, count).join("\n");
  } else if (operation.mode === "tail") {
    const count = clampInteger(operation.lines ?? 100, 1, 500);
    text = lines.slice(Math.max(0, lines.length - count)).join("\n");
  } else {
    text = member.output;
  }
  return {
    objectId: operation.objectId,
    mode: operation.mode,
    text,
    totalCharacters: member.output.length,
    totalLines: lines.length,
  };
}

function boundGroupBatchResult(
  result: TokenMiserGroupBatchResult,
  maxOutputChars: number,
): TokenMiserGroupBatchResult {
  let serializedLength = JSON.stringify(result, null, 2).length;
  if (serializedLength <= maxOutputChars) {
    return result;
  }
  result.truncated = true;
  for (let index = result.results.length - 1; index >= 0; index -= 1) {
    const entry = result.results[index]!;
    if (!entry.text) {
      continue;
    }
    const overflow = serializedLength - maxOutputChars;
    const retainedLength = Math.max(0, entry.text.length - overflow - 32);
    entry.text = entry.mode === "tail"
      ? entry.text.slice(-retainedLength)
      : entry.text.slice(0, retainedLength);
    entry.truncated = true;
    serializedLength = JSON.stringify(result, null, 2).length;
    if (serializedLength <= maxOutputChars) {
      break;
    }
  }
  return result;
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

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function codexVisibleStringRanges(
  text: string,
  maxBytes: number,
): Array<{ start: number; end: number }> {
  const totalBytes = utf8ByteLength(text);
  if (totalBytes <= maxBytes) {
    return [{ start: 0, end: text.length }];
  }
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const prefixEnd = utf8PrefixEnd(text, leftBudget);
  const suffixStart = Math.max(
    prefixEnd,
    utf8SuffixStart(text, totalBytes - rightBudget),
  );
  return [
    { start: 0, end: prefixEnd },
    { start: suffixStart, end: text.length },
  ].filter((range) => range.end > range.start);
}

function utf8PrefixEnd(text: string, maxBytes: number): number {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  return end;
}

function utf8SuffixStart(text: string, targetByteOffset: number): number {
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    if (bytes >= targetByteOffset) {
      return index;
    }
    bytes += utf8ByteLength(character);
    index += character.length;
  }
  return text.length;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
