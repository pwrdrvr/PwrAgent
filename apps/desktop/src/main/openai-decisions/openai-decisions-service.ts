import { createHash, randomUUID } from "node:crypto";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import {
  OPENAI_DECISIONS_ORIGIN,
  OPENAI_DECISIONS_PRICING_CATALOG_ID,
  OPENAI_DECISIONS_PRICING_CATALOG_VERSION,
  OPENAI_DECISIONS_PROVIDER,
  OPENAI_DECISION_BOUNDS,
  buildOpenAIDecisionsRequestBody,
  canonicalJson,
  parseOpenAIDecisionAdHocDefinition,
  openAIDecisionPromptCacheMaterial,
  openAIDecisionSafetyMaterial,
  parseOpenAIDecisionRegistration,
  priceOpenAIDecisionsUsage,
  readOpenAIDecisionsUsage,
  validateOpenAIDecisionInput,
  type OpenAIDecisionInputSchema,
  type OpenAIDecisionQuestion,
  type OpenAIDecisionsPrice,
  type RegisteredDecisionProvider,
  type OpenAIDecisionsUsage,
} from "@pwragent/shared/openai-decisions";
import {
  OpenAIDecisionConflictError,
  OpenAIDecisionNameTakenError,
  type OpenAIDecisionCaller,
  type OpenAIDecisionRegistryStorage,
  type OpenAIDecisionVersionRecord,
} from "../storage/openai-decision-store";
import { codexModelProviderAccountKey } from "../usage-account-identity";
import { OpenAIDecisionsUsageBatcher } from "./openai-decisions-usage-batcher";
import {
  DECISION_BATCH_LIMITS,
  DecisionBatchRegistry,
  DecisionItemTimings,
  batchCardMessage,
  batchCardTask,
  batchWakeupText,
  compactBatchItem,
  finishedItems,
  isFinishedBatch,
  pageBatchResults,
  recordBatchItem,
  summarizeBatch,
  type DecisionBatchCaller,
  type DecisionBatchDetail,
  type DecisionBatchItem,
  type DecisionBatchRecord,
  type DecisionBatchStatusFilter,
} from "./decision-batches";
import {
  DecisionBatchFileWriter,
  batchEndEntry,
  batchHeaderEntry,
  batchItemEntry,
  decisionBatchFilePath,
  isDecisionBatchId,
  listDecisionBatchFileIds,
  readDecisionBatchFile,
} from "./decision-batch-files";
import type { SystemOneTarget } from "../decision/system-one";
import { buildSystemOneDecisionRequest, postSystemOneDecision } from "./system-one-decisions";
import {
  postOpenAIDecision,
  type OpenAIDecisionsAttempt,
  type OpenAIDecisionsHttpOptions,
} from "./openai-decisions-client";

export type OpenAIDecisionsErrorCode =
  | "decision_name_taken"
  | "decision_not_found"
  | "decision_deleted"
  | "invalid_definition"
  | "invalid_input"
  | "credential_missing"
  | "provider_disabled"
  | "credential_rejected"
  | "model_unavailable"
  | "rate_limited"
  | "overloaded"
  | "busy"
  | "batch_not_found"
  | "upstream_error";

export class OpenAIDecisionsError extends Error {
  constructor(
    readonly code: OpenAIDecisionsErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpenAIDecisionsError";
  }
}

export type OpenAIDecisionsLogger = {
  info: (message: string, fields: Record<string, unknown>) => void;
  warn: (message: string, fields: Record<string, unknown>) => void;
};

/** What a batch's card on its thread shows. The caller is the thread. */
export type DecisionBatchCardReport = {
  caller: DecisionBatchCaller;
  batchId: string;
  task: string;
  message: string;
  status: "running" | "success" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type OpenAIDecisionsServiceOptions = {
  store: OpenAIDecisionRegistryStorage;
  /** Reads `openaiDecisionsApiKey`. Called only after local validation passes. */
  readApiKey: () => Promise<string | undefined>;
  /**
   * The saved Jev or local decision model: endpoint, model and key. Read per
   * request, after validation. Undefined when that provider cannot run.
   */
  readSystemOneTarget?: (provider: "jev" | "local") => Promise<SystemOneTarget | undefined>;
  /** The provider for a registration that names none. Defaults to openai. */
  resolveDefaultProvider?: () => Promise<RegisteredDecisionProvider>;
  /**
   * Whether Settings lets agents use a provider. Read on each register,
   * update and invoke. Absent = every provider is on.
   */
  isProviderEnabled?: (provider: RegisteredDecisionProvider) => boolean;
  readAccountSettings: () => { organizationId?: string; projectId?: string };
  profileId: () => string;
  /** Writes a batch of summed usage lines in one transaction. */
  recordUsageLines: (lines: ThreadUsageLineRecord[]) => Promise<void>;
  /** Usage batching window and size; see OpenAIDecisionsUsageBatcher. */
  usageFlushMs?: number;
  usageFlushCount?: number;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  sleep?: OpenAIDecisionsHttpOptions["sleep"];
  timeoutMs?: number;
  now?: () => number;
  newDecisionId?: () => string;
  log?: OpenAIDecisionsLogger;
  /** Waiters allowed behind the one in-flight call per decision. */
  queueLimit?: number;
  /** Writes a batch's card on its calling thread. */
  reportBatch?: (report: DecisionBatchCardReport) => Promise<void>;
  /** Starts or queues a turn on the thread whose background batch ended. */
  wakeThread?: (caller: DecisionBatchCaller, wake: { batchId: string; text: string }) => Promise<void>;
  /**
   * The thread's directory for batch result files. Each batch is appended
   * there as JSONL; without it, batches live in memory only.
   */
  batchResultsDirectory?: (caller: DecisionBatchCaller) => string;
  newBatchId?: () => string;
};

const INVOKE_KEYS = new Set([
  "name",
  "decisionId",
  "version",
  "input",
  "inputs",
  "concurrency",
  "definition",
  "detail",
  "background",
]);
const BATCH_RESULTS_KEYS = new Set(["batchId", "status", "from", "limit", "detail"]);
/** A failure every later item in a batch would repeat. */
const BATCH_STOPPING_CODES = new Set(["credential_missing", "provider_disabled", "credential_rejected", "model_unavailable"]);
/** Each provider's name on its Settings → AI Providers screen. */
const PROVIDER_SETTINGS_NAMES: Record<RegisteredDecisionProvider, string> = {
  openai: "OpenAI Decisions",
  jev: "TypeSafe Jev",
  local: "Local decision model",
};
const TARGET_KEYS = new Set(["name", "decisionId"]);
/** A batch card is rewritten at each further tenth of its items. */
const BATCH_CARD_STEPS = 10;

/** Writes a batch's card: on start (or while it waits), on progress, and at its end. */
type BatchCard = {
  update: () => void;
  progress: () => void;
  finish: () => Promise<void>;
};

/**
 * Registered OpenAI Decisions. The registry is local: OpenAI has no
 * register, update, delete, or version API. Invoke replays the stored
 * questions on `POST /v1/decisions`. The key is read from the secret store
 * inside invoke and never appears in a row, a result, or a log line.
 */
export class OpenAIDecisionsService {
  private readonly lanes = new Map<string, { active: boolean; waiters: Array<() => void> }>();
  private readonly usage: OpenAIDecisionsUsageBatcher;
  private readonly batches: DecisionBatchRegistry;
  /** Per-request timing per decision version, in memory only. */
  private readonly timings = new DecisionItemTimings();
  /** Each running batch's settlement, so cancel and close can wait for it. */
  private readonly runs = new Map<string, Promise<void>>();
  /** Batches their caller cancelled: no wake-up follows. */
  private readonly silentBatches = new Set<string>();
  /** Each running batch's result file writer. */
  private readonly writers = new Map<string, DecisionBatchFileWriter>();
  private closing = false;

  constructor(private readonly options: OpenAIDecisionsServiceOptions) {
    this.batches = new DecisionBatchRegistry(() => this.now());
    this.usage = new OpenAIDecisionsUsageBatcher({
      write: options.recordUsageLines,
      ...(options.usageFlushMs !== undefined ? { flushAfterMs: options.usageFlushMs } : {}),
      ...(options.usageFlushCount !== undefined ? { flushAtCount: options.usageFlushCount } : {}),
      onWriteError: (error, lines, requests) => options.log?.warn("decision usage batch not recorded", {
        lines,
        requests,
        error: error instanceof Error ? error.name : "unknown",
      }),
    });
  }

  /** Writes pending usage now. */
  async flushUsage(): Promise<void> {
    await this.usage.flush();
  }

  /** At owner shutdown: writes pending usage, then writes later usage at once. */
  async closeUsage(): Promise<void> {
    await this.usage.close();
  }

  async register(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    const parsed = parseOpenAIDecisionRegistration(args);
    if (!parsed.ok) throw new OpenAIDecisionsError("invalid_definition", parsed.message);
    const definition = parsed.value;
    if (this.options.store.findActiveByName(definition.name, caller).length > 0) {
      throw nameTaken(definition.name);
    }
    const provider = definition.provider
      ?? await this.options.resolveDefaultProvider?.()
      ?? "openai";
    this.assertProviderEnabled(provider);
    const decisionId = (this.options.newDecisionId ?? randomUUID)();
    const record: OpenAIDecisionVersionRecord = {
      decisionId,
      version: 1,
      name: definition.name,
      scope: definition.scope,
      ownerBackend: caller.backend,
      ...(definition.scope === "thread" ? { ownerThreadId: caller.threadId } : {}),
      status: "active",
      provider,
      questions: definition.questions,
      ...(definition.prefix !== undefined ? { prefix: definition.prefix } : {}),
      inputSchema: definition.inputSchema,
      promptCacheKey: promptCacheKey(decisionId, 1, definition.questions, definition.prefix),
      createdAt: this.now(),
    };
    try {
      this.options.store.insertFirstVersion(record);
    } catch (error) {
      if (error instanceof OpenAIDecisionNameTakenError) throw nameTaken(definition.name);
      throw error;
    }
    this.options.log?.info("registered decision", logFields(record));
    return {
      decisionId,
      name: record.name,
      version: 1,
      scope: record.scope,
      provider,
      inputSchema: record.inputSchema,
      questions: record.questions,
    };
  }

  list(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    for (const key of Object.keys(args)) {
      if (key !== "includeInstructions") {
        throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
      }
    }
    if (args.includeInstructions !== undefined && typeof args.includeInstructions !== "boolean") {
      throw new OpenAIDecisionsError("invalid_input", "includeInstructions must be true or false.");
    }
    const includeInstructions = args.includeInstructions === true;
    return {
      decisions: this.options.store.listVisible(caller).map((record) => ({
        decisionId: record.decisionId,
        name: record.name,
        version: record.version,
        scope: record.scope,
        provider: record.provider,
        questions: record.questions.map((question) => summarizeQuestion(question, includeInstructions)),
        inputSchema: record.inputSchema,
        hasPrefix: record.prefix !== undefined,
        ...(includeInstructions && record.prefix !== undefined ? { prefix: record.prefix } : {}),
        ...timingField(this.timings.summary(record.decisionId, record.version)),
      })),
    };
  }

  update(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    const parsed = parseOpenAIDecisionRegistration(args, { extraKeys: ["decisionId"] });
    if (!parsed.ok) throw new OpenAIDecisionsError("invalid_definition", parsed.message);
    const current = this.resolveTarget(caller, {
      decisionId: args.decisionId,
      name: parsed.value.name,
    });
    if (current.name !== parsed.value.name) {
      throw new OpenAIDecisionsError("invalid_definition", "Update cannot rename a decision.");
    }
    if (args.scope !== undefined && args.scope !== current.scope) {
      throw new OpenAIDecisionsError("invalid_definition", "Update cannot change a decision's scope.");
    }
    const version = current.version + 1;
    const definition = parsed.value;
    // Editing a decision whose provider is off is allowed; moving one onto
    // a provider that is off is not.
    if (definition.provider !== undefined && definition.provider !== current.provider) {
      this.assertProviderEnabled(definition.provider);
    }
    const record: OpenAIDecisionVersionRecord = {
      ...current,
      version,
      status: "active",
      provider: definition.provider ?? current.provider,
      questions: definition.questions,
      inputSchema: definition.inputSchema,
      promptCacheKey: promptCacheKey(current.decisionId, version, definition.questions, definition.prefix),
      createdAt: this.now(),
    };
    delete record.prefix;
    if (definition.prefix !== undefined) record.prefix = definition.prefix;
    try {
      this.options.store.insertNextVersion(record);
    } catch (error) {
      if (error instanceof OpenAIDecisionConflictError) {
        throw new OpenAIDecisionsError("decision_not_found", error.message);
      }
      if (error instanceof OpenAIDecisionNameTakenError) throw nameTaken(record.name);
      throw error;
    }
    this.options.log?.info("updated decision", logFields(record));
    return {
      decisionId: record.decisionId,
      name: record.name,
      version,
      scope: record.scope,
      provider: record.provider,
      inputSchema: record.inputSchema,
    };
  }

  delete(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    for (const key of Object.keys(args)) {
      if (!TARGET_KEYS.has(key)) throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
    }
    const current = this.resolveTarget(caller, args);
    this.options.store.softDelete(current.decisionId);
    this.options.log?.info("deleted decision", logFields(current));
    return { decisionId: current.decisionId, name: current.name, deleted: true };
  }

  /**
   * Runs one input, or a batch. Every batch gets a batch id and keeps its
   * finished items in owner memory and in its thread's result file, so
   * decisions_batch_results can read them after a cancel, a client
   * timeout, a background run, or a restart.
   * `onProgress` receives one line per finished batch item.
   */
  async invoke(
    caller: OpenAIDecisionCaller,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<Record<string, unknown>> {
    for (const key of Object.keys(args)) {
      if (!INVOKE_KEYS.has(key)) throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
    }
    // close() waits only for the batches it saw, so nothing starts after it.
    if (this.closing) throw new OpenAIDecisionsError("busy", "PwrAgent is shutting down. Try again after it restarts.");
    const bulk = args.inputs !== undefined;
    const single = "input" in args;
    if (bulk && single) {
      throw new OpenAIDecisionsError("invalid_input", "Pass input for one item or inputs for a batch, not both.");
    }
    if (!bulk && !single) {
      throw new OpenAIDecisionsError("invalid_input", "Pass input for one item, or inputs for a batch.");
    }
    const inputs = bulk ? parseBulkInputs(args.inputs) : [args.input];
    const concurrency = parseConcurrency(args.concurrency, bulk);
    const detail = parseDetail(args.detail) ?? (bulk ? "compact" : "full");
    const background = parseBackground(args.background, bulk);
    const { record, schema } = args.definition !== undefined
      ? await this.adHocRecord(caller, args)
      : this.registeredRecord(caller, args);
    // Every input is checked before the key is read or any request is sent.
    const validated = inputs.map((input, index) => {
      const result = validateOpenAIDecisionInput(schema, input);
      if (!result.ok) {
        throw new OpenAIDecisionsError("invalid_input", bulk ? `inputs[${index}]: ${result.message}` : result.message);
      }
      return result.value;
    });
    if (!bulk) {
      const run = await this.itemRunner(caller, record, signal);
      const result = await this.inLane(record.decisionId, signal, async () => await run(validated[0]));
      return detail === "compact" ? compactSingleResult(result) : result;
    }
    if (background && this.batches.unfinishedBackground(caller) >= DECISION_BATCH_LIMITS.backgroundPerThread) {
      throw new OpenAIDecisionsError(
        "busy",
        `This thread already has ${DECISION_BATCH_LIMITS.backgroundPerThread} background batches running. Wait for one to finish or cancel one with decisions_batch_cancel.`,
      );
    }
    const batch = this.newBatch(caller, record, validated.length, concurrency, background);
    const run = await this.itemRunner(caller, record, batch.controller.signal);
    // A full queue is refused as busy, as before batches had ids. Nothing
    // awaits between this check and inLane's own, so they cannot disagree.
    this.assertLaneHasRoom(record.decisionId);
    this.batches.add(batch);
    this.openBatchFile(batch);
    const card = this.batchCard(batch);
    // A batch that must wait for its lane shows as waiting, so the
    // operator can see it and stop it.
    if (this.lanes.get(batch.decisionId)?.active) card.update();
    if (background) {
      const done = this.inLane(batch.decisionId, batch.controller.signal, async () =>
        await this.runBatch(batch, validated, run, card))
        .catch((error: unknown) => this.finishUnstarted(batch, card, error));
      this.runs.set(batch.batchId, done);
      void done.finally(() => this.runs.delete(batch.batchId));
      return {
        ...summarizeBatch(batch),
        next: "Running in the background. End your turn: PwrAgent starts a turn on this thread when the batch ends. Read answers any time with decisions_batch_results.",
      };
    }
    // A blocking batch stops when its call does. Its finished items stay
    // readable by batch id either way.
    const onAbort = () => {
      batch.cancelReason ??= "the call was cancelled";
      batch.controller.abort();
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const done = this.inLane(batch.decisionId, batch.controller.signal, async () =>
        await this.runBatch(batch, validated, run, card, onProgress))
        .catch((error: unknown) => this.finishUnstarted(batch, card, error));
      this.runs.set(batch.batchId, done);
      await done;
    } finally {
      this.runs.delete(batch.batchId);
      signal?.removeEventListener("abort", onAbort);
    }
    const page = pageBatchResults(batch, { from: 0, limit: batch.count, status: "all", detail });
    return {
      ...summarizeBatch(batch),
      detail,
      results: page.results,
      ...(page.nextFrom !== undefined ? { nextFrom: page.nextFrom } : {}),
    };
  }

  /**
   * Reads a batch this thread started: its totals and a page of finished
   * items. Without batchId, lists this thread's batches, newest first.
   */
  async batchResults(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    for (const key of Object.keys(args)) {
      if (!BATCH_RESULTS_KEYS.has(key)) throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
    }
    if (args.batchId === undefined) {
      for (const key of ["status", "from", "limit", "detail"] as const) {
        if (args[key] !== undefined) {
          throw new OpenAIDecisionsError("invalid_input", `${key} needs a batchId.`);
        }
      }
      return { batches: (await this.listBatches(caller)).map((batch) => summarizeBatch(batch)) };
    }
    const status = parseStatusFilter(args.status);
    const from = parseIndex(args.from, "from", 0);
    const limit = parseIndex(args.limit, "limit", DECISION_BATCH_LIMITS.pageDefaultItems);
    if (limit < 1 || limit > DECISION_BATCH_LIMITS.pageMaxItems) {
      throw new OpenAIDecisionsError(
        "invalid_input",
        `limit must be an integer from 1 to ${DECISION_BATCH_LIMITS.pageMaxItems}.`,
      );
    }
    const detail = parseDetail(args.detail) ?? "compact";
    const batch = await this.ownBatch(caller, args.batchId);
    const page = pageBatchResults(batch, { from, limit, status, detail });
    return {
      ...summarizeBatch(batch),
      detail,
      status,
      from,
      results: page.results,
      ...(page.nextFrom !== undefined ? { nextFrom: page.nextFrom } : {}),
    };
  }

  /**
   * Cancels a batch this thread started. Requests in flight are aborted and
   * unsent items are skipped; finished items stay readable. No wake-up
   * turn follows, since the caller asked for the stop.
   */
  async cancelBatch(
    caller: OpenAIDecisionCaller,
    args: Record<string, unknown>,
    reason = "cancelled with decisions_batch_cancel",
  ) {
    for (const key of Object.keys(args)) {
      if (key !== "batchId") throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
    }
    const batch = await this.ownBatch(caller, args.batchId);
    if (isFinishedBatch(batch)) return { ...summarizeBatch(batch), alreadyFinished: true };
    batch.cancelReason ??= reason;
    this.silentBatches.add(batch.batchId);
    batch.controller.abort();
    await this.runs.get(batch.batchId);
    return summarizeBatch(batch);
  }

  /**
   * The operator's Stop on a batch's card: cancels it as decisions_batch_cancel
   * does, with no wake-up. "not_running" when the thread has no running
   * batch with that id, such as one that already ended.
   */
  async stopBatch(caller: OpenAIDecisionCaller, batchId: string): Promise<"stopped" | "not_running"> {
    const batch = this.batches.get(caller, batchId);
    if (!batch || isFinishedBatch(batch)) return "not_running";
    await this.cancelBatch(caller, { batchId }, "stopped from the thread");
    return "stopped";
  }

  /**
   * At owner shutdown: cancels running batches without a card or wake-up
   * (the database is closing), then writes pending usage.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const batch of this.batches.unfinished()) {
      batch.cancelReason ??= "PwrAgent shut down";
      batch.controller.abort();
    }
    await Promise.all([...this.runs.values()]);
    await this.usage.close();
  }

  /** The caller's batch from memory, else from its result file. */
  private async ownBatch(caller: OpenAIDecisionCaller, batchId: unknown) {
    if (typeof batchId !== "string" || batchId.length === 0) {
      throw new OpenAIDecisionsError("invalid_input", "batchId must be a string.");
    }
    const batch = this.batches.get(caller, batchId) ?? await this.readBatchFile(caller, batchId);
    if (!batch) {
      throw new OpenAIDecisionsError(
        "batch_not_found",
        "This thread has no batch with that id. Result files keep the latest 20 batches per thread. Call decisions_batch_results without batchId to list them.",
      );
    }
    return batch;
  }

  private async readBatchFile(caller: OpenAIDecisionCaller, batchId: string) {
    const directory = this.options.batchResultsDirectory?.(caller);
    // Only an id PwrAgent could have generated becomes a path.
    if (!directory || !isDecisionBatchId(batchId)) return undefined;
    return await readDecisionBatchFile(decisionBatchFilePath(directory, batchId), caller);
  }

  /** Batches in memory, plus those only in result files, newest first. */
  private async listBatches(caller: OpenAIDecisionCaller): Promise<DecisionBatchRecord[]> {
    const inMemory = this.batches.list(caller);
    const directory = this.options.batchResultsDirectory?.(caller);
    if (!directory) return inMemory;
    const known = new Set(inMemory.map((batch) => batch.batchId));
    const onDisk = await Promise.all((await listDecisionBatchFileIds(directory))
      .filter((batchId) => !known.has(batchId))
      .map(async (batchId) => await this.readBatchFile(caller, batchId)));
    return [...inMemory, ...onDisk.filter((batch): batch is DecisionBatchRecord => batch !== undefined)]
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  /** Starts the batch's result file with its header line. */
  private openBatchFile(batch: DecisionBatchRecord): void {
    const directory = this.options.batchResultsDirectory?.(batch.caller);
    if (!directory) return;
    batch.resultsFile = decisionBatchFilePath(directory, batch.batchId);
    const writer = new DecisionBatchFileWriter(batch.resultsFile, {
      keep: () => new Set(this.batches.unfinished().map((running) => running.batchId)),
      onError: (error) => {
        // A batch whose file failed still runs; its summary stops naming the file.
        delete batch.resultsFile;
        this.options.log?.warn("decision batch results file not written", {
          decisionId: batch.decisionId,
          batchId: batch.batchId,
          error: error instanceof Error ? error.name : "unknown",
        });
      },
    });
    writer.append(batchHeaderEntry(batch));
    this.writers.set(batch.batchId, writer);
  }

  /** Records an item once, in memory and in the batch's file. */
  private recordItem(batch: DecisionBatchRecord, item: DecisionBatchItem): void {
    if (recordBatchItem(batch, item)) this.writers.get(batch.batchId)?.append(batchItemEntry(item));
  }

  private newBatch(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    count: number,
    concurrency: number,
    background: boolean,
  ): DecisionBatchRecord {
    return {
      batchId: `batch_${(this.options.newBatchId ?? randomUUID)()}`,
      caller: { backend: caller.backend, threadId: caller.threadId },
      decisionId: record.decisionId,
      name: record.name,
      version: record.version,
      provider: record.provider,
      count,
      concurrency,
      background,
      state: "queued",
      createdAt: this.now(),
      results: new Array<DecisionBatchItem | undefined>(count).fill(undefined),
      succeeded: 0,
      failed: 0,
      skipped: 0,
      controller: new AbortController(),
    };
  }

  /**
   * A batch cancelled while it waited for its lane, so nothing was sent,
   * or one that failed unexpectedly. Either way it ends cancelled, and
   * whatever finished stays readable.
   */
  private async finishUnstarted(batch: DecisionBatchRecord, card: BatchCard, error: unknown): Promise<void> {
    if (isFinishedBatch(batch)) return;
    if (!(error instanceof OpenAIDecisionsError)) {
      this.options.log?.warn("decision batch failed unexpectedly", {
        decisionId: batch.decisionId,
        batchId: batch.batchId,
        error: error instanceof Error ? error.name : "unknown",
      });
      batch.cancelReason ??= "the batch failed unexpectedly";
    }
    batch.cancelReason ??= "the call was cancelled";
    batch.controller.abort();
    await this.finishBatch(batch, card);
  }

  /** The stored version a call names: latest active, or a pinned version. */
  private registeredRecord(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    if (
      args.version !== undefined
      && (!Number.isInteger(args.version) || (args.version as number) < 1)
    ) {
      throw new OpenAIDecisionsError("invalid_input", "version must be a positive integer.");
    }
    const latest = this.resolveTarget(caller, args);
    const record = args.version === undefined || args.version === latest.version
      ? latest
      : this.options.store.getVersion(latest.decisionId, args.version as number);
    if (!record) {
      throw new OpenAIDecisionsError(
        "decision_not_found",
        `Decision "${latest.name}" has no version ${String(args.version)}.`,
      );
    }
    if (record.status === "deleted") {
      throw new OpenAIDecisionsError("decision_deleted", `Decision "${record.name}" was deleted.`);
    }
    return { record, schema: record.inputSchema as OpenAIDecisionInputSchema | undefined };
  }

  /**
   * An ad hoc definition, built for this call and never stored. Its id is a
   * digest of the definition, so repeating the same definition reuses the
   * same prompt cache key and queue.
   */
  private async adHocRecord(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    for (const key of ["name", "decisionId", "version"] as const) {
      if (args[key] !== undefined) {
        throw new OpenAIDecisionsError("invalid_input", `Pass ${key} or definition, not both.`);
      }
    }
    const parsed = parseOpenAIDecisionAdHocDefinition(args.definition);
    if (!parsed.ok) throw new OpenAIDecisionsError("invalid_definition", parsed.message);
    const definition = parsed.value;
    const provider = definition.provider
      ?? await this.options.resolveDefaultProvider?.()
      ?? "openai";
    const decisionId = `${AD_HOC_DECISION_ID_PREFIX}${sha256Hex(canonicalJson({
      provider,
      questions: definition.questions,
      prefix: definition.prefix ?? null,
    })).slice(0, 32)}`;
    const record: OpenAIDecisionVersionRecord = {
      decisionId,
      version: 1,
      name: "ad_hoc",
      scope: "thread",
      ownerBackend: caller.backend,
      ownerThreadId: caller.threadId,
      status: "active",
      provider,
      questions: definition.questions,
      ...(definition.prefix !== undefined ? { prefix: definition.prefix } : {}),
      inputSchema: definition.inputSchema ?? {},
      promptCacheKey: promptCacheKey(decisionId, 1, definition.questions, definition.prefix),
      createdAt: this.now(),
    };
    return { record, schema: definition.inputSchema };
  }

  /** Refuses a provider the operator turned off in Settings. */
  private assertProviderEnabled(provider: RegisteredDecisionProvider): void {
    if (this.options.isProviderEnabled?.(provider) === false) {
      const name = PROVIDER_SETTINGS_NAMES[provider];
      throw new OpenAIDecisionsError(
        "provider_disabled",
        `${name} is turned off. Turn it on in Settings → AI Providers → ${name}.`,
      );
    }
  }

  /**
   * Checks the provider's credential once, then returns the function that
   * runs one validated input. It throws OpenAIDecisionsError on failure.
   */
  private async itemRunner(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    signal: AbortSignal | undefined,
  ): Promise<(input: unknown) => Promise<DecisionItemResult>> {
    const run = await this.untimedItemRunner(caller, record, signal);
    // decisions_list shows timing for saved decisions only. An ad-hoc
    // definition would take a slot and evict a saved one's window.
    if (isAdHocDecisionId(record.decisionId)) return run;
    return async (input) => {
      const startedAt = this.now();
      const result = await run(input);
      this.timings.record(record.decisionId, record.version, this.now() - startedAt);
      return result;
    };
  }

  private async untimedItemRunner(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    signal: AbortSignal | undefined,
  ): Promise<(input: unknown) => Promise<DecisionItemResult>> {
    this.assertProviderEnabled(record.provider);
    if (record.provider !== "openai") {
      const provider = record.provider;
      const target = await this.options.readSystemOneTarget?.(provider);
      if (!target) {
        throw new OpenAIDecisionsError(
          "credential_missing",
          provider === "jev"
            ? "No TypeSafe Jev API key is saved. Add one in Settings → AI Providers → TypeSafe Jev."
            : "The local decision model is not set up. Configure it in Settings → AI Providers → Local decision model.",
        );
      }
      return async (input) => await this.postSystemOne(record, provider, target, input, signal);
    }
    const apiKey = (await this.options.readApiKey())?.trim();
    if (!apiKey) {
      throw new OpenAIDecisionsError(
        "credential_missing",
        "No OpenAI Decisions API key is saved. Add one in Settings → AI Providers → OpenAI Decisions.",
      );
    }
    return async (input) => await this.post(caller, record, input, apiKey, signal);
  }

  /**
   * Runs a batch with at most `concurrency` requests in flight, writing each
   * finished item into the batch by index. A failed item does not stop the
   * others, except a failure no later item can avoid (a missing or rejected
   * credential, an unavailable model) or a cancel: the rest are then
   * skipped. Finished items are kept either way.
   */
  private async runBatch(
    batch: DecisionBatchRecord,
    inputs: readonly unknown[],
    run: (input: unknown) => Promise<DecisionItemResult>,
    card: BatchCard,
    onProgress?: (message: string) => void,
  ): Promise<void> {
    const signal = batch.controller.signal;
    batch.state = "running";
    batch.startedAt = this.now();
    card.update();
    function* pending(): Generator<number> {
      for (let index = 0; index < inputs.length; index += 1) {
        if (batch.stoppedBy || signal.aborted) return;
        yield index;
      }
    }
    const mapper = new IterableMapper(pending(), async (index: number): Promise<number> => {
      try {
        this.recordItem(batch, { index, ok: true, ...batchItemData(await run(inputs[index])) });
      } catch (error) {
        // Any failure stays with its item: earlier items were sent and
        // billed, and their answers must not be lost to one bad item.
        if (!(error instanceof OpenAIDecisionsError)) {
          this.options.log?.warn("decision batch item failed unexpectedly", {
            decisionId: batch.decisionId,
            batchId: batch.batchId,
            index,
            error: error instanceof Error ? error.name : "unknown",
          });
          this.recordItem(batch, { index, ok: false, code: "internal_error", message: "The item failed unexpectedly." });
        } else {
          this.recordItem(batch, { index, ok: false, code: error.code, message: error.message });
          if (BATCH_STOPPING_CODES.has(error.code)) batch.stoppedBy ??= { code: error.code, message: error.message };
        }
      }
      card.progress();
      onProgress?.(batchCardTask(batch));
      return index;
    }, { concurrency: batch.concurrency, maxUnread: batch.concurrency * 2 });
    for await (const _index of mapper) {
      // Results are written by index; draining keeps the mapper moving.
    }
    await this.finishBatch(batch, card);
  }

  /** Skips what never ran, settles the state, and tells the thread. */
  private async finishBatch(
    batch: DecisionBatchRecord,
    card: BatchCard,
  ): Promise<void> {
    const skippedReason = batch.stoppedBy
      ? `Skipped after ${batch.stoppedBy.code}.`
      : `Skipped because ${batch.cancelReason ?? "the call was cancelled"}.`;
    for (let index = 0; index < batch.count; index += 1) {
      if (batch.results[index] === undefined) {
        this.recordItem(batch, { index, ok: false, code: "skipped", message: skippedReason });
      }
    }
    // A cancel that came after every item was answered cancelled nothing.
    batch.state = batch.stoppedBy
      ? "stopped"
      : batch.controller.signal.aborted && batch.succeeded < batch.count
        ? "cancelled"
        : "completed";
    batch.finishedAt = this.now();
    // The end line goes out even at shutdown: the file is what survives it.
    const writer = this.writers.get(batch.batchId);
    writer?.append(batchEndEntry(batch));
    await writer?.settle();
    this.writers.delete(batch.batchId);
    this.batches.evict();
    this.options.log?.info("decision batch finished", {
      decisionId: batch.decisionId,
      version: batch.version,
      provider: batch.provider,
      batchId: batch.batchId,
      items: batch.count,
      succeeded: batch.succeeded,
      concurrency: batch.concurrency,
      background: batch.background,
      state: batch.state,
      ...(batch.stoppedBy ? { stoppedBy: batch.stoppedBy.code } : {}),
    });
    await card.finish();
    const silent = this.silentBatches.delete(batch.batchId);
    if (!batch.background || silent || this.closing || !this.options.wakeThread) return;
    try {
      await this.options.wakeThread(batch.caller, { batchId: batch.batchId, text: batchWakeupText(batch) });
    } catch (error) {
      this.options.log?.warn("decision batch wake-up not delivered", {
        decisionId: batch.decisionId,
        batchId: batch.batchId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /**
   * The batch's card on its thread. It is written when the batch starts,
   * at each further tenth of its items finished, and when it ends: at most
   * 11 writes a batch, whatever its size. Writes run in order and a failed
   * write never fails the batch. Small blocking batches get no card.
   */
  private batchCard(batch: DecisionBatchRecord): BatchCard {
    const report = this.options.reportBatch;
    const shown = report !== undefined
      && (batch.background || batch.count > OPENAI_DECISION_BOUNDS.bulkMaxConcurrency);
    let chain: Promise<void> = Promise.resolve();
    let step = -1;
    const write = () => {
      if (!shown || this.closing) return;
      const finished = isFinishedBatch(batch);
      const snapshot: DecisionBatchCardReport = {
        caller: batch.caller,
        batchId: batch.batchId,
        task: batchCardTask(batch),
        message: batchCardMessage(batch),
        status: !finished
          ? "running"
          : batch.state === "completed"
            ? "success"
            : batch.state === "stopped"
              ? "failed"
              : "cancelled",
        createdAt: batch.createdAt,
        updatedAt: this.now(),
        ...(finished && batch.finishedAt !== undefined ? { completedAt: batch.finishedAt } : {}),
      };
      chain = chain
        .then(async () => await report(snapshot))
        .catch((error: unknown) => this.options.log?.warn("decision batch card not written", {
          decisionId: batch.decisionId,
          batchId: batch.batchId,
          error: error instanceof Error ? error.name : "unknown",
        }));
    };
    return {
      update: () => {
        step = 0;
        write();
      },
      progress: () => {
        const next = Math.floor((finishedItems(batch) * BATCH_CARD_STEPS) / batch.count);
        // The last step is the finish, which writes its own card.
        if (next > step && next < BATCH_CARD_STEPS) {
          step = next;
          write();
        }
      },
      finish: async () => {
        // A batch cancelled before it started never showed a card, and
        // there is nothing to retire.
        if (step >= 0) write();
        await chain;
      },
    };
  }

  private async post(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    input: unknown,
    apiKey: string,
    signal: AbortSignal | undefined,
  ): Promise<DecisionItemResult> {
    const account = this.options.readAccountSettings();
    const body = buildOpenAIDecisionsRequestBody({
      questions: record.questions,
      prefix: record.prefix,
      input,
      promptCacheKey: record.promptCacheKey,
      safetyIdentifier: sha256Hex(openAIDecisionSafetyMaterial({
        profileId: this.options.profileId(),
        backend: caller.backend,
        threadId: caller.threadId,
      })),
    });
    const result = await postOpenAIDecision({
      body,
      apiKey,
      ...(account.organizationId ? { organizationId: account.organizationId } : {}),
      ...(account.projectId ? { projectId: account.projectId } : {}),
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
    const accountKey = codexModelProviderAccountKey(OPENAI_DECISIONS_ORIGIN, apiKey);
    for (const attempt of result.attempts) {
      if (attempt.usage === undefined) continue;
      this.usage.add(
        { decisionId: record.decisionId, version: record.version },
        buildOpenAIDecisionsUsageLine({
          caller,
          decisionId: record.decisionId,
          version: record.version,
          attempt,
          accountKey,
          now: this.now(),
          fallbackId: randomUUID(),
        }),
      );
    }
    const last = result.attempts.at(-1);
    this.options.log?.[result.ok ? "info" : "warn"]("decision request finished", {
      ...logFields(record),
      status: last?.status,
      requestId: last?.requestId,
      attempts: result.attempts.length,
      ...(result.ok ? {} : { code: result.code }),
      ...usageLogFields(readOpenAIDecisionsUsage(last?.usage)),
    });
    if (!result.ok) {
      const requestNote = result.requestId ? ` Request id ${result.requestId}.` : "";
      const statusNote = result.status ? ` HTTP ${result.status}.` : "";
      throw new OpenAIDecisionsError(
        result.code,
        `${result.code}:${statusNote}${requestNote}${result.detail ? ` ${result.detail}` : ""}`.trim(),
        {
          ...(result.status ? { status: result.status } : {}),
          ...(result.requestId ? { requestId: result.requestId } : {}),
        },
      );
    }
    const { usage: rawUsage, ...response } = result.body;
    const usage = readOpenAIDecisionsUsage(rawUsage);
    const price = priceOpenAIDecisionsUsage(usage);
    return {
      decisionId: record.decisionId,
      name: record.name,
      version: record.version,
      provider: "openai" as const,
      model: typeof result.body.model === "string" ? result.body.model : undefined,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      response,
      usage: usageSummary(usage, price),
    };
  }

  private async postSystemOne(
    record: OpenAIDecisionVersionRecord,
    provider: "jev" | "local",
    target: SystemOneTarget,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<DecisionItemResult> {
    const request = buildSystemOneDecisionRequest({
      questions: record.questions,
      prefix: record.prefix,
      input,
    });
    const result = await postSystemOneDecision({
      target,
      request,
      questions: record.questions,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
    this.options.log?.[result.ok ? "info" : "warn"]("decision request finished", {
      ...logFields(record),
      ...(result.ok ? {} : { code: result.code, status: result.status }),
    });
    if (!result.ok) {
      const statusNote = result.status ? ` HTTP ${result.status}.` : "";
      throw new OpenAIDecisionsError(
        result.code,
        `${result.code}:${statusNote}${result.detail ? ` ${result.detail}` : ""}`.trim(),
        result.status ? { status: result.status } : undefined,
      );
    }
    return {
      decisionId: record.decisionId,
      name: record.name,
      version: record.version,
      provider,
      model: result.model ?? target.model,
      answers: result.answers,
      // System One reports no token usage, so PwrAgent records no spend line.
      usage: { priceStatus: "unavailable", priceUnavailableReason: "the provider reports no token usage" },
    };
  }

  private resolveTarget(
    caller: OpenAIDecisionCaller,
    args: { name?: unknown; decisionId?: unknown },
  ): OpenAIDecisionVersionRecord {
    const decisionId = args.decisionId;
    const name = args.name;
    if (decisionId !== undefined && typeof decisionId !== "string") {
      throw new OpenAIDecisionsError("invalid_input", "decisionId must be a string.");
    }
    if (name !== undefined && typeof name !== "string") {
      throw new OpenAIDecisionsError("invalid_input", "name must be a string.");
    }
    if (!decisionId && !name) {
      throw new OpenAIDecisionsError("invalid_input", "Pass name or decisionId.");
    }
    if (decisionId) {
      const active = this.options.store.getActive(decisionId);
      if (active && isVisible(active, caller)) {
        if (name && active.name !== name) {
          throw new OpenAIDecisionsError("invalid_input", "name and decisionId name different decisions.");
        }
        return active;
      }
      const first = this.options.store.getVersion(decisionId, 1);
      if (first && first.status === "deleted" && isVisible(first, caller)) {
        throw new OpenAIDecisionsError("decision_deleted", `Decision "${first.name}" was deleted.`);
      }
      throw new OpenAIDecisionsError("decision_not_found", "No visible decision has that id.");
    }
    const [match] = this.options.store.findActiveByName(name!, caller);
    if (!match) {
      if (this.options.store.hasDeletedName(name!, caller)) {
        throw new OpenAIDecisionsError("decision_deleted", `Decision "${name}" was deleted.`);
      }
      throw new OpenAIDecisionsError(
        "decision_not_found",
        `No active decision named "${name}" is visible to this thread. Call decisions_list.`,
      );
    }
    return match;
  }

  /** Refuses a call that would find this decision's queue full. */
  private assertLaneHasRoom(decisionId: string): void {
    const lane = this.lanes.get(decisionId);
    if (lane?.active && lane.waiters.length >= (this.options.queueLimit ?? 4)) {
      throw new OpenAIDecisionsError(
        "busy",
        "This decision already has one request in flight and four waiting. Try again shortly.",
      );
    }
  }

  private async inLane<T>(
    decisionId: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    let lane = this.lanes.get(decisionId);
    if (!lane) {
      lane = { active: false, waiters: [] };
      this.lanes.set(decisionId, lane);
    }
    if (lane.active) {
      this.assertLaneHasRoom(decisionId);
      // A cancelled caller leaves the queue at once instead of holding a slot.
      await new Promise<void>((resolve, reject) => {
        const waiters = lane!.waiters;
        const onAbort = () => {
          const index = waiters.indexOf(wake);
          if (index >= 0) waiters.splice(index, 1);
          reject(new OpenAIDecisionsError("upstream_error", "upstream_error: The request was cancelled."));
        };
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(wake);
      });
    }
    lane.active = true;
    try {
      return await work();
    } finally {
      const next = lane.waiters.shift();
      if (next) {
        next();
      } else {
        lane.active = false;
        this.lanes.delete(decisionId);
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** What one input's run returns, from either provider. */
type DecisionItemResult = {
  decisionId: string;
  name: string;
  version: number;
  provider: RegisteredDecisionProvider;
  model?: string;
  requestId?: string;
  response?: Record<string, unknown>;
  answers?: unknown[];
  usage: Record<string, unknown>;
};

function parseBulkInputs(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPENAI_DECISION_BOUNDS.bulkMaxItems) {
    throw new OpenAIDecisionsError(
      "invalid_input",
      `inputs must be an array of 1 to ${OPENAI_DECISION_BOUNDS.bulkMaxItems} items.`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(value)) > OPENAI_DECISION_BOUNDS.bulkMaxTotalBytes) {
    throw new OpenAIDecisionsError(
      "invalid_input",
      `inputs must total at most ${OPENAI_DECISION_BOUNDS.bulkMaxTotalBytes} bytes of compact JSON.`,
    );
  }
  return value;
}

function parseConcurrency(value: unknown, bulk: boolean): number {
  if (value === undefined) return OPENAI_DECISION_BOUNDS.bulkMaxConcurrency;
  if (!bulk) throw new OpenAIDecisionsError("invalid_input", "concurrency applies only to inputs.");
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > OPENAI_DECISION_BOUNDS.bulkMaxConcurrency) {
    throw new OpenAIDecisionsError(
      "invalid_input",
      `concurrency must be an integer from 1 to ${OPENAI_DECISION_BOUNDS.bulkMaxConcurrency}.`,
    );
  }
  return value as number;
}

const AD_HOC_DECISION_ID_PREFIX = "adhoc:";

function isAdHocDecisionId(decisionId: string): boolean {
  return decisionId.startsWith(AD_HOC_DECISION_ID_PREFIX);
}

/** A decision's observed per-request time, once it has run since PwrAgent started. */
function timingField(timing: ReturnType<DecisionItemTimings["summary"]>) {
  return timing ? { timing } : {};
}

function parseDetail(value: unknown): DecisionBatchDetail | undefined {
  if (value === undefined) return undefined;
  if (value !== "compact" && value !== "full") {
    throw new OpenAIDecisionsError("invalid_input", "detail must be compact or full.");
  }
  return value;
}

function parseBackground(value: unknown, bulk: boolean): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new OpenAIDecisionsError("invalid_input", "background must be true or false.");
  if (value && !bulk) throw new OpenAIDecisionsError("invalid_input", "background applies only to inputs.");
  return value;
}

function parseStatusFilter(value: unknown): DecisionBatchStatusFilter {
  if (value === undefined) return "all";
  if (value !== "all" && value !== "succeeded" && value !== "failed" && value !== "skipped") {
    throw new OpenAIDecisionsError("invalid_input", "status must be all, succeeded, failed, or skipped.");
  }
  return value;
}

function parseIndex(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new OpenAIDecisionsError("invalid_input", `${name} must be a non-negative integer.`);
  }
  return value as number;
}

/** One input's result with its answers in compact form and no response body. */
function compactSingleResult(result: DecisionItemResult) {
  const { index: _index, ok: _ok, ...compact } = compactBatchItem({ index: 0, ok: true, ...batchItemData(result) });
  return {
    decisionId: result.decisionId,
    name: result.name,
    version: result.version,
    provider: result.provider,
    ...(result.model ? { model: result.model } : {}),
    ...compact,
    usage: result.usage,
  };
}

/** One batch item without the fields every item shares. */
function batchItemData(result: DecisionItemResult) {
  const usage = result.provider === "openai" ? result.usage : undefined;
  return {
    ...(result.model ? { model: result.model } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...(result.response ? { response: result.response } : {}),
    ...(result.answers ? { answers: result.answers } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * One HTTP attempt's usage as a finalized ledger row. The batcher sums these
 * per thread and decision version before anything is written. The
 * provider and account are the OpenAI API project, never the Codex
 * subscription: provider `openai_decisions`, scope `monitor`, no turn id, so
 * the parent turn's `thread_usage_turns` counters and the thread's latest
 * model stay untouched. Cache-write tokens stay a subset of uncached input,
 * as everywhere else in the ledger; the regular-uncached cost excludes them.
 */
export function buildOpenAIDecisionsUsageLine(params: {
  caller: OpenAIDecisionCaller;
  decisionId: string;
  version: number;
  attempt: OpenAIDecisionsAttempt;
  accountKey: string;
  now: number;
  fallbackId: string;
}): ThreadUsageLineRecord {
  const usage = readOpenAIDecisionsUsage(params.attempt.usage);
  const price = priceOpenAIDecisionsUsage(usage);
  const sourceItemId = `${params.decisionId}:${params.version}:${params.attempt.requestId ?? params.fallbackId}`;
  const inputTokens = usage?.inputTokens ?? 0;
  const cachedTokens = usage?.cachedTokens ?? 0;
  const priced = price.status === "priced" ? price : undefined;
  return {
    usageLineId: `${OPENAI_DECISIONS_PROVIDER}:${sourceItemId}`,
    provider: OPENAI_DECISIONS_PROVIDER,
    accountKey: params.accountKey,
    backend: params.caller.backend,
    threadId: params.caller.threadId,
    parentThreadId: params.caller.threadId,
    source: "openai_decisions",
    sourceItemId,
    scope: "monitor",
    status: "finalized",
    createdAt: params.now,
    completedAt: params.now,
    ...(params.attempt.model ? { model: params.attempt.model } : {}),
    inputTokens,
    cachedInputTokens: cachedTokens,
    cacheWriteInputTokens: usage?.cacheWriteTokens ?? 0,
    uncachedInputTokens: Math.max(0, inputTokens - cachedTokens),
    outputTokens: usage?.outputTokens ?? 0,
    reasoningOutputTokens: usage?.reasoningTokens ?? 0,
    totalTokens: inputTokens + (usage?.outputTokens ?? 0),
    currency: "USD",
    priceStatus: priced ? "priced" : "unpriced",
    ...(price.status === "unpriced" ? { priceUnavailableReason: price.reason } : {}),
    pricingCatalogId: OPENAI_DECISIONS_PRICING_CATALOG_ID,
    pricingCatalogVersion: OPENAI_DECISIONS_PRICING_CATALOG_VERSION,
    pricingBasis: "decisions-output-uncharged",
    ...(priced ? { pricingRateId: priced.rateId } : {}),
    uncachedInputCostMicros: priced?.uncachedInputCostMicros ?? 0,
    cachedInputCostMicros: priced?.cachedInputCostMicros ?? 0,
    cacheWriteInputCostMicros: priced?.cacheWriteInputCostMicros ?? 0,
    outputCostMicros: 0,
    totalCostMicros: priced?.totalCostMicros ?? 0,
  };
}

function usageSummary(usage: OpenAIDecisionsUsage | undefined, price: OpenAIDecisionsPrice) {
  return {
    ...(usage ?? {}),
    ...(usage && price.status === "priced" ? { regularUncachedTokens: price.regularUncachedTokens } : {}),
    priceStatus: price.status === "priced" ? "estimated" : "unavailable",
    ...(price.status === "priced"
      ? {
          estimatedCostUsd: price.totalCostMicros / 1_000_000,
          longContext: price.longContext,
        }
      : { priceUnavailableReason: usage ? "inconsistent usage" : "usage missing" }),
    pricingBasis: "OpenAI API project, standard processing; output not charged; regional premium not selected.",
  };
}

function summarizeQuestion(question: OpenAIDecisionQuestion, includeInstructions: boolean) {
  return {
    type: question.type,
    ...(question.name !== undefined ? { name: question.name } : {}),
    ...(question.type === "choice" ? { choices: question.choices.map((choice) => choice.value) } : {}),
    ...(question.type === "score" ? { levels: question.levels.map((level) => level.label) } : {}),
    ...(includeInstructions ? { instructions: question.instructions } : {}),
  };
}

function isVisible(record: OpenAIDecisionVersionRecord, caller: OpenAIDecisionCaller): boolean {
  return record.scope === "profile"
    || (record.ownerBackend === caller.backend && record.ownerThreadId === caller.threadId);
}

function nameTaken(name: string): OpenAIDecisionsError {
  return new OpenAIDecisionsError(
    "decision_name_taken",
    `An active decision named "${name}" is already visible to this thread. Use decisions_update or another name.`,
  );
}

function promptCacheKey(
  decisionId: string,
  version: number,
  questions: readonly OpenAIDecisionQuestion[],
  prefix: string | undefined,
): string {
  return sha256Hex(openAIDecisionPromptCacheMaterial({ decisionId, version, questions, prefix })).slice(0, 64);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function logFields(record: OpenAIDecisionVersionRecord): Record<string, unknown> {
  return { decisionId: record.decisionId, version: record.version, scope: record.scope, provider: record.provider };
}

function usageLogFields(usage: OpenAIDecisionsUsage | undefined): Record<string, unknown> {
  return usage
    ? {
        inputTokens: usage.inputTokens,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
      }
    : {};
}
