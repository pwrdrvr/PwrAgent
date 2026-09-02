import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS,
  estimateTokenCount,
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
// Reducer acknowledgements expire after 60 seconds. A longer grace protects a
// fresh pending output owned by another PwrAgent process sharing the profile,
// while still reclaiming raw files left by a crash before acceptance.
const PENDING_OUTPUT_ORPHAN_GRACE_MS = 5 * 60_000;

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
    callCount: number;
    commandCellCount: number;
    directCommandCellCount: number;
    dispatchClusterCount: number;
    multiInvocationClusterCount: number;
    largestDispatchCluster: number;
    nestedCommandInvocationCount: number;
    patchCellCount: number;
    otherCellCount: number;
    pollingCellCount: number;
    directCount: number;
    summarizedCount: number;
    passThroughCount: number;
    retrievalCount: number;
    capturedNestedInvocationCount: number;
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
  | "stored";

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
  /** Characters that could have entered the parent before preservation encoding. */
  baselineCharacters?: number;
  /**
   * Optional provider-enforced ceiling for the original model-visible result.
   * Code mode supplies its resolved `max_output_tokens`; direct hook results
   * retain the historical 10k-token cap below.
   */
  baselineParentTokenCap?: number;
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
  /** Persist the retrievable object before its replacement is delivered. */
  persist(): Promise<void>;
  /** Publish the already-persisted object to live accounting and cards. */
  commit(): Promise<void>;
  /** Remove an object whose replacement was not accepted by the caller. */
  discard(): Promise<void>;
};

export class TokenMiserStore {
  private readonly updateLocks = new Map<string, Promise<void>>();
  private readonly pendingRetrievalDeliveries =
    new Map<string, PendingRetrievalDelivery>();

  constructor(
    private readonly rootDir: string,
    private readonly options: TokenMiserStoreOptions = {},
  ) {}

  async store(params: TokenMiserStoreParams): Promise<TokenMiserObjectMetadata> {
    const staged = await this.stage(params);
    await staged.commit();
    return staged.metadata;
  }

  async stage(params: TokenMiserStoreParams): Promise<TokenMiserStagedObject> {
    const objectId = params.objectId ?? randomUUID();
    if (!isSafeObjectId(objectId)) {
      throw new Error("Invalid Token Miser object id.");
    }
    const originalCharacters = params.baselineCharacters ?? params.output.length;
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
          Math.min(originalCharacters, TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS),
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
      summary: params.summary,
      ...(params.disposition ? { disposition: params.disposition } : {}),
      ...(params.groupId ? { groupId: params.groupId } : {}),
      ...(params.groupMembers ? { groupMembers: params.groupMembers } : {}),
      ...(params.helperUsage ? { helperUsage: params.helperUsage } : {}),
      ...(params.parentModel ? { parentModel: params.parentModel } : {}),
      ...(params.parentServiceTier
        ? { parentServiceTier: params.parentServiceTier }
        : {}),
    };
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
        if (persisted || committed || discarded) {
          return;
        }
        await this.ensureRoot();
        await writePrivateFileAtomic(this.outputPath(objectId), params.output);
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
          if (!persisted) {
            await this.ensureRoot();
            await writePrivateFileAtomic(
              this.outputPath(objectId),
              params.output,
            );
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
    const metadata = (await this.listMetadata()).find((entry) =>
      entry.threadId === params.threadId && entry.groupId === params.groupId
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
    const metadata = await this.readMetadata(params.objectId);
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
    this.pendingRetrievalDeliveries.set(deliveryId, {
      createdAt: now,
      objectId: params.objectId,
      threadId: params.threadId,
      visibleText: params.visibleText,
      visibleTextOffset: begin.length + 1,
      wrappedText,
    });
    return { deliveryId, text: wrappedText };
  }

  async confirmModelVisibleRetrievals(params: {
    maxVisibleCharacters?: number;
    output: string;
    threadId: string;
  }): Promise<number> {
    // One Code Mode cell can emit several individually bounded retrievals, but
    // Codex applies one shared ceiling to the outer result. Attribute each
    // delivery by its position in that visible prefix so their sum cannot
    // exceed the containing result.
    const candidates = [...this.pendingRetrievalDeliveries.entries()]
      .filter(([, pending]) => pending.threadId === params.threadId)
      .map(([deliveryId, pending]) => ({
        deliveryId,
        outputOffset: params.output.indexOf(pending.wrappedText),
        pending,
      }))
      .filter((candidate) => candidate.outputOffset >= 0)
      .sort((left, right) => left.outputOffset - right.outputOffset);
    const visibleOutputEnd = Math.min(
      params.output.length,
      normalizePositiveInteger(
        params.maxVisibleCharacters,
        Number.MAX_SAFE_INTEGER,
      ),
    );
    let confirmedCharacters = 0;
    for (const { deliveryId, outputOffset, pending } of candidates) {
      this.pendingRetrievalDeliveries.delete(deliveryId);
      const visibleTextStart = outputOffset + pending.visibleTextOffset;
      const visibleCharacters = Math.max(
        0,
        Math.min(
          pending.visibleText.length,
          visibleOutputEnd - visibleTextStart,
        ),
      );
      await this.recordRetrieval(pending.objectId, visibleCharacters);
      confirmedCharacters += visibleCharacters;
    }
    return confirmedCharacters;
  }

  abandonRetrievalDelivery(deliveryId: string): void {
    this.pendingRetrievalDeliveries.delete(deliveryId);
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

  async recordCodeModeObservation(params: Omit<
    TokenMiserCodeModeObservation,
    "version" | "observationId" | "createdAt"
  > & { createdAt?: number }): Promise<TokenMiserCodeModeObservation> {
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
      ...(params.outputPreview
        ? { outputPreview: params.outputPreview.slice(0, 5_000) }
        : {}),
      ...(params.outputPreviewTruncated
        ? { outputPreviewTruncated: true }
        : {}),
      maxOutputTokens: params.maxOutputTokens,
      scriptStatus: params.scriptStatus,
      ...(params.script ? { script: params.script.slice(-4_000) } : {}),
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
    await fs.mkdir(this.observationRoot(), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomic(
      this.observationPath(observationId),
      `${JSON.stringify(observation)}\n`,
    );
    await this.options.onCodeModeObservationUpdated?.(observation);
    return observation;
  }

  async listCodeModeObservations(
    threadId?: string,
  ): Promise<TokenMiserCodeModeObservation[]> {
    const entries = await fs.readdir(this.observationRoot()).catch(
      (error: unknown) => {
        if (isMissingFileError(error)) return [];
        throw error;
      },
    );
    const observations = await Promise.all(entries
      .filter((entry) => entry.endsWith(METADATA_SUFFIX))
      .map(async (entry) => {
        try {
          const raw = await fs.readFile(
            path.join(this.observationRoot(), entry),
            "utf8",
          );
          const value = JSON.parse(raw) as TokenMiserCodeModeObservation;
          return value?.version === 1
            && value.observationId === entry.slice(0, -METADATA_SUFFIX.length)
            ? value
            : undefined;
        } catch {
          return undefined;
        }
      }));
    return observations
      .filter((entry): entry is TokenMiserCodeModeObservation => Boolean(entry))
      .filter((entry) => !threadId || entry.threadId === threadId)
      .sort((left, right) => left.createdAt - right.createdAt);
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
    const observations = await this.listCodeModeObservations(threadId);
    const metadataByToolUseId = new Map(
      metadata.map((entry) => [entry.toolUseId, entry]),
    );
    const codeModeObservations = observations.map((observation) => {
      const disposition = observation.retrieval
        ? "retrieval" as const
        : metadataByToolUseId.get(observation.callId)?.disposition
          ?? "direct" as const;
      return { ...observation, disposition };
    });
    const commandCount = (entry: TokenMiserCodeModeObservation) =>
      entry.capturedCommandInvocationCount
      ?? (entry.retrieval ? 0 : entry.capturedNestedInvocationCount);
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
        callCount: codeModeObservations.length,
        commandCellCount: commandCells.length,
        directCommandCellCount: commandCells.filter(
          (entry) => entry.disposition === "direct",
        ).length,
        dispatchClusterCount: dispatchClusterSizes.length,
        multiInvocationClusterCount: dispatchClusterSizes.filter(
          (size) => size > 1,
        ).length,
        largestDispatchCluster: dispatchClusterSizes.length > 0
          ? Math.max(...dispatchClusterSizes)
          : 0,
        nestedCommandInvocationCount: dispatchClusterSizes.reduce(
          (total, size) => total + size,
          0,
        ),
        patchCellCount: codeModeObservations.filter(
          (entry) => (entry.capturedPatchInvocationCount ?? 0) > 0,
        ).length,
        otherCellCount: codeModeObservations.filter(
          (entry) => !entry.retrieval
            && (
              entry.capturedNestedInvocationCount === 0
              || (entry.capturedOtherInvocationCount ?? 0) > 0
            ),
        ).length,
        pollingCellCount: codeModeObservations.filter(
          (entry) => (entry.capturedPollingInvocationCount ?? 0) > 0,
        ).length,
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
        capturedNestedInvocationCount: codeModeObservations.reduce(
          (total, entry) => total + entry.capturedNestedInvocationCount,
          0,
        ),
        observations: codeModeObservations,
      },
    };
  }

  async prune(params: {
    maxAgeMs: number;
    maxBytes: number;
    now?: number;
  }): Promise<void> {
    const now = params.now ?? Date.now();
    const metadata = await this.listMetadata();
    const observations = await this.listCodeModeObservations();
    const retainedObservations: Array<{
      observation: TokenMiserCodeModeObservation;
      bytes: number;
    }> = [];
    for (const observation of observations) {
      const observationPath = this.observationPath(observation.observationId);
      const stats = await fs.stat(observationPath).catch(() => undefined);
      if (!stats || now - observation.createdAt > params.maxAgeMs) {
        await fs.rm(observationPath, { force: true });
        continue;
      }
      retainedObservations.push({ observation, bytes: stats.size });
    }
    await this.pruneStalePendingOutputs(
      new Set(metadata.map((entry) => entry.objectId)),
      now,
    );
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
    const candidates = [
      ...retained.map((entry) => ({
        bytes: entry.bytes,
        createdAt: entry.metadata.createdAt,
        remove: () => this.remove(entry.metadata.objectId),
      })),
      ...retainedObservations.map((entry) => ({
        bytes: entry.bytes,
        createdAt: entry.observation.createdAt,
        remove: () => fs.rm(
          this.observationPath(entry.observation.observationId),
          { force: true },
        ),
      })),
    ].sort((left, right) => left.createdAt - right.createdAt);
    let totalBytes = candidates.reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of candidates) {
      if (totalBytes <= params.maxBytes) {
        break;
      }
      await entry.remove();
      totalBytes -= entry.bytes;
    }
  }

  private async readAuthorizedObject(
    objectId: string,
    threadId: string,
  ): Promise<TokenMiserStoredObject | undefined> {
    const metadata = await this.readMetadata(objectId);
    if (
      !metadata
      || metadata.threadId !== threadId
      || metadata.disposition === "passed_through"
    ) {
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

  private async pruneStalePendingOutputs(
    committedObjectIds: ReadonlySet<string>,
    now: number,
  ): Promise<void> {
    const entries = await fs.readdir(this.rootDir).catch((error: unknown) => {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.endsWith(OUTPUT_SUFFIX)) {
        return;
      }
      const objectId = entry.slice(0, -OUTPUT_SUFFIX.length);
      if (!isSafeObjectId(objectId) || committedObjectIds.has(objectId)) {
        return;
      }
      const outputPath = this.outputPath(objectId);
      const stats = await fs.stat(outputPath).catch(() => undefined);
      if (
        stats
        && now - stats.mtimeMs > PENDING_OUTPUT_ORPHAN_GRACE_MS
      ) {
        await fs.rm(outputPath, { force: true });
      }
    }));
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
      const metadata = await this.readMetadata(objectId);
      if (!metadata || !update(metadata)) {
        return;
      }
      await this.writeMetadata(metadata);
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

  private observationRoot(): string {
    return path.join(this.rootDir, OBSERVATION_DIRECTORY);
  }

  private observationPath(observationId: string): string {
    return path.join(this.observationRoot(), `${observationId}${METADATA_SUFFIX}`);
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

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
