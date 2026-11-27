import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import type { DecisionProvidersReadiness } from "@pwragent/shared/decision-models";
import type { ResearchDecisionBatchSummary, ResearchDecisionsSnapshot, ResearchThread } from "@pwragent/shared/research";
import type {
  DecisionsRailBatch,
  DecisionsRailBatchActionResult,
  DecisionsRailBatchPage,
  DecisionsRailDecision,
  DecisionsRailItem,
  DecisionsRailItemFilter,
  DecisionsRailActiveBatches,
  DecisionsRailSnapshot,
  DecisionsProfileDecision,
  DecisionsProfileDeleteResult,
} from "@pwragent/shared/decisions-rail";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { PWRAGENT_MCP_HTTP_MAX_REQUEST_BYTES } from "@pwragent/shared/contracts/agent-tools";
import { decisionImageCapabilities } from "@pwragent/shared/decision-models";
import {
  DECISION_IMAGE_SCHEMA_KEY,
  OPENAI_DECISIONS_ORIGIN,
  OPENAI_DECISIONS_PRICING_CATALOG_ID,
  OPENAI_DECISIONS_PRICING_CATALOG_VERSION,
  OPENAI_DECISIONS_PROVIDER,
  OPENAI_DECISION_BOUNDS,
  buildOpenAIDecisionsRequestBody,
  canonicalJson,
  AD_HOC_DECISION_ID_PREFIX,
  isAdHocDecisionId,
  isRegisteredDecisionProvider,
  parseOpenAIDecisionAdHocDefinition,
  openAIDecisionPromptCacheMaterial,
  openAIDecisionSafetyMaterial,
  parseOpenAIDecisionRegistration,
  priceOpenAIDecisionsUsage,
  readOpenAIDecisionsUsage,
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
  OPERATOR_STOP_CODE,
  batchDefinition,
  batchProgressLine,
  batchWakeupText,
  compactBatchItem,
  decisionInputPreview,
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
import { railBatch, railBatchPage } from "./decision-batch-rail";
import {
  DecisionFileError,
  formatBatchOutputFile,
  formatSingleOutputFile,
  readDecisionInputsFile,
  resolveWritableDecisionOutputFile,
  writeDecisionOutputFile,
  type DecisionFileAccess,
} from "./decision-io-files";
import type { SystemOneTarget } from "../decision/system-one";
import { imageCodec } from "../owner-host";
import { decisionImageReferences, hasDecisionImageParts, prepareDecisionInput, type PreparedDecisionInput } from "./decision-images";
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
  | "file_not_found"
  | "file_access_denied"
  | "invalid_image"
  | "images_unsupported"
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

/**
 * A batch moved: it started (or is waiting for its lane), finished another
 * tenth of its items, or ended. The caller is the thread. Windows read the
 * batch itself from the service; this only says to read again.
 */
export type DecisionBatchUpdate = {
  caller: DecisionBatchCaller;
  batchId: string;
  status: "running" | "success" | "failed" | "cancelled";
  /** Items with an outcome so far, skipped ones included. */
  finished: number;
  count: number;
};

export type DecisionResearchRunParticipant = {
  thread: DecisionBatchCaller;
  role: "coordinator" | "worker";
  approachId?: string;
  approachTitle?: string;
};

export type DecisionResearchRunMembership = {
  runId: string;
  status: string;
  createdAt: number;
  isCoordinator: boolean;
};

export type DecisionResearchRunContext = {
  runId: string;
  createdAt: number;
  status: string;
  isCoordinator: boolean;
  participants: readonly DecisionResearchRunParticipant[];
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
  /** Settings model id, available without reading credentials. */
  readProviderModel?: (provider: RegisteredDecisionProvider) => string | undefined;
  decodeImage?: typeof imageCodec.createFromBuffer;
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
  /** Tells the calling thread's windows a batch moved. Nothing is written. */
  announceBatch?: (update: DecisionBatchUpdate) => Promise<void>;
  /** Starts or queues a turn on the thread whose background batch ended. */
  wakeThread?: (caller: DecisionBatchCaller, wake: { batchId: string; text: string }) => Promise<void>;
  /**
   * The thread's directory for batch result files. Each batch is appended
   * there as JSONL; without it, batches live in memory only.
   */
  batchResultsDirectory?: (caller: DecisionBatchCaller) => string;
  /**
   * Local filesystem access policy for `inputsFile` and `outputFile` on
   * `decisions_invoke`. Resolved per call so workspace changes take effect
   * immediately.
   */
  resolveCallerFileAccess?: (caller: DecisionBatchCaller) => Promise<DecisionFileAccess>;
  /** Research runs this thread belongs to, newest first. */
  resolveCallerResearchRuns?: (caller: DecisionBatchCaller) => readonly DecisionResearchRunMembership[];
  /** Participant details for a research run when the caller is a member; undefined otherwise. */
  resolveResearchRunContext?: (caller: DecisionBatchCaller, runId: string) => DecisionResearchRunContext | undefined;
  /** Called when a background batch settles; `woken` is false when no wake-up turn was delivered. */
  onBackgroundBatchSettled?: (caller: DecisionBatchCaller, woken: boolean) => void;
  newBatchId?: () => string;
};

const INVOKE_KEYS = new Set([
  "name",
  "decisionId",
  "version",
  "researchRunId",
  "input",
  "inputs",
  "inputsFile",
  "outputFile",
  "inlineResults",
  "concurrency",
  "definition",
  "detail",
  "background",
]);
const BATCH_RESULTS_KEYS = new Set(["batchId", "researchRunId", "status", "from", "limit", "detail"]);
/** A failure every later item in a batch would repeat. */
const BATCH_STOPPING_CODES = new Set(["credential_missing", "provider_disabled", "credential_rejected", "model_unavailable"]);
/** Each provider's name on its Settings → AI Providers screen. */
const PROVIDER_SETTINGS_NAMES: Record<RegisteredDecisionProvider, string> = {
  openai: "OpenAI Decisions",
  jev: "TypeSafe Jev",
  local: "Local decision model",
};
const TARGET_KEYS = new Set(["name", "decisionId", "researchRunId"]);
/** Result-file summaries the Decisions tab keeps parsed, across threads. */
const RAIL_FILE_SUMMARY_LIMIT = 200;
/**
 * A batch its thread hears about: a background one, or one bigger than a
 * single wave of requests. A small blocking batch ends inside its tool call.
 */
function isAnnouncedBatch(batch: Pick<DecisionBatchRecord, "background" | "count">): boolean {
  return batch.background || batch.count > OPENAI_DECISION_BOUNDS.bulkMaxConcurrency;
}

/** A batch is announced again at each further tenth of its items. */
const BATCH_ANNOUNCE_STEPS = 10;

/** Announces a batch: on start (or while it waits), on progress, and at its end. */
type BatchAnnouncer = {
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
  /** Background batches currently delivering their completion wake-up turn. */
  private readonly pendingWakeups = new Map<string, { caller: DecisionBatchCaller; researchRunId?: string }>();
  /** Each running batch's result file writer. */
  private readonly writers = new Map<string, DecisionBatchFileWriter>();
  /**
   * Finished batches the Decisions tab read from result files, by file,
   * so polling the tab stats files instead of parsing them again.
   */
  private readonly railFileSummaries = new Map<
    string,
    { mtimeMs: number; size: number; batch: DecisionsRailBatch; researchRunId?: string; resultsFile: string }
  >();
  /** The last result file the tab paged through, parsed. */
  private railFileRecord: { file: string; mtimeMs: number; size: number; record: DecisionBatchRecord } | undefined;
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
    if (hasDecisionImageParts(args.prefix)) {
      this.assertDefinitionImages(await this.registrationProvider(args.provider), args);
    }
    const parsed = parseOpenAIDecisionRegistration(args);
    if (!parsed.ok) throw new OpenAIDecisionsError("invalid_definition", parsed.message);
    const definition = parsed.value;
    let researchRunId: string | undefined;
    if (definition.scope === "research_run") {
      researchRunId = this.resolveRegistrationResearchRunId(caller, definition.researchRunId);
    }
    const scopeCaller: OpenAIDecisionCaller = {
      backend: caller.backend,
      threadId: caller.threadId,
      ...(researchRunId ? { researchRunIds: [researchRunId] } : {}),
    };
    const existing = this.options.store.findActiveByName(definition.name, scopeCaller);
    const sameScopeCollision = existing.some((record) => {
      if (record.scope !== definition.scope) return false;
      if (definition.scope === "research_run") return record.researchRunId === researchRunId;
      if (definition.scope === "thread") {
        return record.ownerBackend === caller.backend && record.ownerThreadId === caller.threadId;
      }
      return true;
    });
    if (sameScopeCollision) {
      throw nameTaken(definition.name);
    }
    const provider = definition.provider
      ?? await this.options.resolveDefaultProvider?.()
      ?? "openai";
    this.assertDefinitionImages(provider, args);
    this.assertProviderEnabled(provider);
    const decisionId = (this.options.newDecisionId ?? randomUUID)();
    const record: OpenAIDecisionVersionRecord = {
      decisionId,
      version: 1,
      name: definition.name,
      scope: definition.scope,
      ownerBackend: caller.backend,
      ...(definition.scope !== "profile" ? { ownerThreadId: caller.threadId } : {}),
      ...(researchRunId ? { researchRunId } : {}),
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
      ...(record.researchRunId ? { researchRunId: record.researchRunId } : {}),
      provider,
      inputSchema: record.inputSchema,
      questions: record.questions,
    };
  }

  list(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    for (const key of Object.keys(args)) {
      if (key !== "includeInstructions" && key !== "researchRunId") {
        throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
      }
    }
    if (args.includeInstructions !== undefined && typeof args.includeInstructions !== "boolean") {
      throw new OpenAIDecisionsError("invalid_input", "includeInstructions must be true or false.");
    }
    const filterRunId = parseOptionalResearchRunId(args.researchRunId);
    const includeInstructions = args.includeInstructions === true;
    let records: OpenAIDecisionVersionRecord[];
    if (filterRunId !== undefined) {
      this.requireResearchRunContext(caller, filterRunId, "decision_not_found");
      records = this.options.store.listActiveForResearchRun
        ? this.options.store.listActiveForResearchRun(filterRunId)
        : this.options.store.listVisible({ ...caller, researchRunIds: [filterRunId] })
          .filter((record) => record.scope === "research_run" && record.researchRunId === filterRunId);
    } else {
      records = this.options.store.listVisible(this.callerWithResearchRuns(caller));
    }
    return {
      decisions: records.map((record) => ({
        decisionId: record.decisionId,
        name: record.name,
        version: record.version,
        scope: record.scope,
        ...(record.researchRunId ? { researchRunId: record.researchRunId } : {}),
        provider: record.provider,
        inputCapabilities: {
          images: this.imageCapabilities(record.provider),
          maxHttpMcpRequestBytes: PWRAGENT_MCP_HTTP_MAX_REQUEST_BYTES,
          maxBatchInputsJsonBytes: OPENAI_DECISION_BOUNDS.bulkMaxTotalBytes,
        },
        ...(this.options.isProviderEnabled?.(record.provider) === false ? { providerDisabled: true } : {}),
        questions: record.questions.map((question) => summarizeQuestion(question, includeInstructions)),
        inputSchema: record.inputSchema,
        hasPrefix: record.prefix !== undefined,
        ...(includeInstructions && record.prefix !== undefined ? { prefix: record.prefix } : {}),
        ...timingField(this.timings.summary(record.decisionId, record.version)),
      })),
    };
  }

  update(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    const requestedRunId = parseOptionalResearchRunId(args.researchRunId);
    const enriched = this.callerWithResearchRuns(caller, requestedRunId, "decision_not_found");
    if (hasDecisionImageParts(args.prefix)) {
      const current = this.resolveTarget(enriched, args, requestedRunId);
      this.assertDefinitionImages(isRegisteredDecisionProvider(args.provider) ? args.provider : current.provider, args);
    }
    const parsed = parseOpenAIDecisionRegistration(args, { extraKeys: ["decisionId"] });
    if (!parsed.ok) throw new OpenAIDecisionsError("invalid_definition", parsed.message);
    const current = this.resolveTarget(enriched, {
      decisionId: args.decisionId,
      name: parsed.value.name,
    }, requestedRunId);
    if (current.name !== parsed.value.name) {
      throw new OpenAIDecisionsError("invalid_definition", "Update cannot rename a decision.");
    }
    if (args.scope !== undefined && args.scope !== current.scope) {
      throw new OpenAIDecisionsError("invalid_definition", "Update cannot change a decision's scope.");
    }
    if (requestedRunId !== undefined && current.researchRunId !== requestedRunId) {
      throw new OpenAIDecisionsError("invalid_definition", "Update cannot change a decision's researchRunId.");
    }
    this.assertCanMutateResearchDecision(caller, current, "invalid_definition", "update");
    const version = current.version + 1;
    const definition = parsed.value;
    const provider = definition.provider ?? current.provider;
    this.assertDefinitionImages(provider, args);
    // Editing a decision whose provider is off is allowed; moving one onto
    // a provider that is off is not.
    if (definition.provider !== undefined && definition.provider !== current.provider) {
      this.assertProviderEnabled(definition.provider);
    }
    const record: OpenAIDecisionVersionRecord = {
      ...current,
      version,
      status: "active",
      provider,
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
      ...(record.researchRunId ? { researchRunId: record.researchRunId } : {}),
      provider: record.provider,
      inputSchema: record.inputSchema,
    };
  }

  delete(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    for (const key of Object.keys(args)) {
      if (!TARGET_KEYS.has(key)) throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
    }
    const requestedRunId = parseOptionalResearchRunId(args.researchRunId);
    const enriched = this.callerWithResearchRuns(caller, requestedRunId, "decision_not_found");
    const current = this.resolveTarget(enriched, args, requestedRunId);
    this.assertCanMutateResearchDecision(caller, current, "invalid_input", "delete");
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
    const hasInputs = args.inputs !== undefined;
    const hasInputsFile = args.inputsFile !== undefined;
    const single = "input" in args;
    const sourceCount = Number(hasInputs) + Number(hasInputsFile) + Number(single);
    if (sourceCount > 1) {
      throw new OpenAIDecisionsError("invalid_input", "Pass input, inputs, or inputsFile, not more than one.");
    }
    if (sourceCount === 0) {
      throw new OpenAIDecisionsError("invalid_input", "Pass input for one item, or inputs or inputsFile for a batch.");
    }
    const bulk = hasInputs || hasInputsFile;
    const hasOutputFile = args.outputFile !== undefined;
    const inlineResults = parseInlineResults(args.inlineResults, hasOutputFile, bulk);
    const concurrency = parseConcurrency(args.concurrency, bulk);
    const detail = parseDetail(args.detail) ?? (bulk ? "compact" : "full");
    const background = parseBackground(args.background, bulk);
    const requestedRunId = parseOptionalResearchRunId(args.researchRunId);
    const enrichedCaller = this.callerWithResearchRuns(caller, requestedRunId, "decision_not_found");
    const { record, schema } = args.definition !== undefined
      ? await this.adHocRecord(caller, args)
      : this.registeredRecord(enrichedCaller, args, requestedRunId);
    const batchResearchRunId = record.scope === "research_run"
      ? record.researchRunId
      : requestedRunId ?? this.soleActiveResearchRunId(caller);
    const fileAccess = hasInputsFile || hasOutputFile
      ? await this.options.resolveCallerFileAccess?.(caller)
      : undefined;
    const outputFile = hasOutputFile
      ? await this.validateOutputFile(args.outputFile, fileAccess)
      : undefined;
    const inputs = hasInputsFile
      ? parseBulkInputs(await this.loadInputsFile(args.inputsFile, fileAccess))
      : hasInputs
        ? parseBulkInputs(args.inputs)
        : [args.input];
    // Every input is checked before the key is read or any request is sent.
    const capability = this.imageCapabilities(record.provider);
    const validated = inputs.map((input, index) => {
      const result = prepareDecisionInput(input, schema, capability, unsupportedImagesMessage(record.provider));
      if (!result.ok) {
        const error = new OpenAIDecisionsError(
          result.code,
          bulk ? `inputs[${index}]: ${result.message}` : result.message,
        );
        if (!bulk || result.code === "invalid_input") throw error;
        return error;
      }
      return result.value;
    });
    if (!bulk) {
      const input = validated[0] as PreparedDecisionInput;
      await this.imageReferences(input, false);
      const run = await this.itemRunner(caller, record, signal);
      const raw = await this.inLane(record.decisionId, signal, async () => await run(input));
      return await this.finishSingleInvoke(raw, detail, outputFile, inlineResults, fileAccess);
    }
    if (background && this.batches.unfinishedBackground(caller) >= DECISION_BATCH_LIMITS.backgroundPerThread) {
      throw new OpenAIDecisionsError(
        "busy",
        `This thread already has ${DECISION_BATCH_LIMITS.backgroundPerThread} background batches running. Wait for one to finish or cancel one with decisions_batch_cancel.`,
      );
    }
    const batch = this.newBatch(
      caller,
      record,
      validated.length,
      concurrency,
      background,
      outputFile,
      detail,
      batchResearchRunId,
    );
    const run = validated.some((input) => !(input instanceof OpenAIDecisionsError))
      ? await this.itemRunner(caller, record, batch.controller.signal)
      : undefined;
    // A full queue is refused as busy, as before batches had ids. Nothing
    // awaits between this check and inLane's own, so they cannot disagree.
    this.assertLaneHasRoom(record.decisionId);
    this.batches.add(batch);
    this.openBatchFile(batch);
    const announcer = this.batchAnnouncer(batch);
    // A batch that must wait for its lane shows as waiting, so the
    // operator can see it and stop it.
    if (this.lanes.get(batch.decisionId)?.active) announcer.update();
    if (background) {
      const done = this.inLane(batch.decisionId, batch.controller.signal, async () =>
        await this.runBatch(batch, validated, run, announcer))
        .catch((error: unknown) => this.finishUnstarted(batch, announcer, error));
      this.runs.set(batch.batchId, done);
      void done.finally(() => this.runs.delete(batch.batchId));
      return {
        ...summarizeBatch(batch),
        next: batch.outputFile
          ? "Running in the background. End your turn: PwrAgent writes outputFile and starts a turn on this thread when the batch ends. Read answers any time with decisions_batch_results."
          : "Running in the background. End your turn: PwrAgent starts a turn on this thread when the batch ends. Read answers any time with decisions_batch_results.",
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
        await this.runBatch(batch, validated, run, announcer, onProgress))
        .catch((error: unknown) => this.finishUnstarted(batch, announcer, error));
      this.runs.set(batch.batchId, done);
      await done;
    } finally {
      this.runs.delete(batch.batchId);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!inlineResults) {
      return {
        ...summarizeBatch(batch),
        detail,
      };
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
   * Reads a batch this thread started, or one run by a member of a research run
   * this thread belongs to. Without batchId, lists this thread's batches (or
   * every member's batches for researchRunId), newest first.
   */
  async batchResults(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    for (const key of Object.keys(args)) {
      if (!BATCH_RESULTS_KEYS.has(key)) throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
    }
    const researchRunId = parseOptionalResearchRunId(args.researchRunId);
    if (args.batchId === undefined) {
      for (const key of ["status", "from", "limit", "detail"] as const) {
        if (args[key] !== undefined) {
          throw new OpenAIDecisionsError("invalid_input", `${key} needs a batchId.`);
        }
      }
      if (researchRunId !== undefined) {
        const ctx = this.requireResearchRunContext(caller, researchRunId, "batch_not_found");
        const entries = await this.listResearchRunBatches(ctx);
        return {
          researchRunId,
          batches: entries.map(({ batch, participant }) => ({
            ...summarizeBatch(batch),
            caller: { ...batch.caller },
            role: participant.role,
            ...(participant.approachId ? { approachId: participant.approachId } : {}),
            ...(participant.approachTitle ? { approachTitle: participant.approachTitle } : {}),
          })),
        };
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
    const resolved = await this.accessibleBatch(caller, args.batchId, researchRunId);
    const page = pageBatchResults(resolved.batch, { from, limit, status, detail });
    return {
      ...summarizeBatch(resolved.batch),
      ...(resolved.participant
        ? {
            caller: { ...resolved.batch.caller },
            role: resolved.participant.role,
            ...(resolved.participant.approachId ? { approachId: resolved.participant.approachId } : {}),
            ...(resolved.participant.approachTitle ? { approachTitle: resolved.participant.approachTitle } : {}),
          }
        : {}),
      detail,
      status,
      from,
      results: page.results,
      ...(page.nextFrom !== undefined ? { nextFrom: page.nextFrom } : {}),
    };
  }

  /**
   * Cancels a batch this thread started, or (when researchRunId is passed by
   * the run's coordinator) a worker's batch in that run. Requests in flight are
   * aborted and unsent items are skipped; finished items stay readable. No
   * wake-up turn follows.
   */
  async cancelBatch(
    caller: OpenAIDecisionCaller,
    args: Record<string, unknown>,
    reason = "cancelled with decisions_batch_cancel",
  ) {
    for (const key of Object.keys(args)) {
      if (key !== "batchId" && key !== "researchRunId") {
        throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
      }
    }
    const researchRunId = parseOptionalResearchRunId(args.researchRunId);
    let batch: DecisionBatchRecord;
    if (researchRunId !== undefined) {
      const ctx = this.requireResearchRunContext(caller, researchRunId, "batch_not_found");
      if (!ctx.isCoordinator) {
        throw new OpenAIDecisionsError("invalid_input", "Only the research run coordinator may cancel another member's batch.");
      }
      batch = (await this.findResearchRunBatch(ctx, args.batchId)).batch;
    } else {
      batch = await this.ownBatch(caller, args.batchId);
    }
    if (isFinishedBatch(batch)) return { ...summarizeBatch(batch), alreadyFinished: true };
    batch.cancelReason ??= reason;
    this.silentBatches.add(batch.batchId);
    batch.controller.abort();
    await this.runs.get(batch.batchId);
    return summarizeBatch(batch);
  }

  /**
   * Cancels every running or queued decision batch owned by `caller` (blocking
   * and background), aborting in-flight provider requests and suppressing
   * background wake-ups. Used when a Research run or worker stops or times out.
   */
  async cancelThreadBatches(
    caller: DecisionBatchCaller,
    reason: string,
    options?: { researchRunId?: string },
  ): Promise<number> {
    const targets = this.batches.list(caller).filter((batch) =>
      !isFinishedBatch(batch)
      && (options?.researchRunId === undefined || batch.researchRunId === options.researchRunId),
    );
    if (targets.length === 0) return 0;
    for (const batch of targets) {
      batch.cancelReason ??= reason;
      this.silentBatches.add(batch.batchId);
      batch.controller.abort();
    }
    await Promise.all(targets.map((batch) => this.runs.get(batch.batchId)));
    return targets.length;
  }

  /**
   * Whether `caller` currently has an in-flight background batch (queued,
   * running, or delivering its completion wake-up turn).
   */
  hasActiveBackgroundBatch(caller: DecisionBatchCaller, researchRunId?: string): boolean {
    const matchesRun = (batchRunId: string | undefined) =>
      researchRunId === undefined || batchRunId === undefined || batchRunId === researchRunId;
    if (this.batches.list(caller).some((batch) =>
      batch.background && !isFinishedBatch(batch) && matchesRun(batch.researchRunId),
    )) {
      return true;
    }
    for (const pending of this.pendingWakeups.values()) {
      if (
        pending.caller.backend === caller.backend
        && pending.caller.threadId === caller.threadId
        && matchesRun(pending.researchRunId)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * The Decisions tab: decisions visible to the thread, with each
   * provider's on/off state and observed timing, and the thread's batches,
   * newest first: running ones from memory, finished ones from memory or
   * their result files.
   */
  async railSnapshot(caller: OpenAIDecisionCaller): Promise<DecisionsRailSnapshot> {
    const now = this.now();
    const enriched = this.callerWithResearchRuns(caller);
    const decisions = this.options.store.listVisible(enriched).map((record) => this.railDecision(record));
    return { decisions, batches: await this.railBatches(caller, now), now };
  }

  /**
   * The Research tracker's Decisions view: run-scoped decisions for `ctx.runId`
   * and every batch run across the run's coordinator and workers, newest first.
   */
  async researchRunDecisionsSnapshot(
    ctx: DecisionResearchRunContext,
    readiness: DecisionProvidersReadiness,
  ): Promise<ResearchDecisionsSnapshot> {
    const now = this.now();
    const runRecords = this.options.store.listActiveForResearchRun
      ? this.options.store.listActiveForResearchRun(ctx.runId)
      : [];
    const decisions = runRecords.map((record) => this.railDecision(record));
    const batches = await this.listResearchRunRailBatches(ctx, now);
    return { runId: ctx.runId, readiness, decisions, batches, now };
  }

  /** One page of a batch belonging to a member of `ctx`. */
  async researchRunBatchPage(
    ctx: DecisionResearchRunContext,
    params: { batchId: string; status: DecisionsRailItemFilter; from: number; limit: number },
  ): Promise<DecisionsRailBatchPage> {
    if (typeof params.batchId !== "string" || params.batchId.length === 0) {
      throw new OpenAIDecisionsError("invalid_input", "batchId must be a string.");
    }
    for (const participant of ctx.participants) {
      const record = this.batches.get(participant.thread, params.batchId)
        ?? await this.railFileRecordFor(participant.thread, params.batchId);
      if (record && batchBelongsToResearchRun(record, participant, ctx)) {
        return railBatchPage(record, { status: params.status, from: params.from, limit: params.limit, now: this.now() });
      }
    }
    throw new OpenAIDecisionsError("batch_not_found", "This research run has no batch with that id.");
  }

  /** Operator Stop or Cancel on a batch owned by any participant of `ctx`. */
  async researchRunBatchAction(
    ctx: DecisionResearchRunContext,
    batchId: string,
    action: "stop" | "cancel",
  ): Promise<DecisionsRailBatchActionResult> {
    for (const participant of ctx.participants) {
      const batch = this.batches.get(participant.thread, batchId);
      if (batch && batchBelongsToResearchRun(batch, participant, ctx)) {
        return await this.operatorBatchAction(participant.thread, batchId, action);
      }
    }
    return { outcome: "not_running" };
  }

  /** Result file path for a batch owned by any participant of `ctx`. */
  async researchRunResultsFile(
    ctx: DecisionResearchRunContext,
    batchId: string,
  ): Promise<string | undefined> {
    if (!isDecisionBatchId(batchId)) return undefined;
    for (const participant of ctx.participants) {
      const inMemory = this.batches.get(participant.thread, batchId);
      if (inMemory && batchBelongsToResearchRun(inMemory, participant, ctx)) return inMemory.resultsFile;
      const directory = this.options.batchResultsDirectory?.(participant.thread);
      if (!directory) continue;
      const file = decisionBatchFilePath(directory, batchId);
      const entry = await this.railFileSummaryEntry(participant.thread, file);
      if (entry && batchBelongsToResearchRun({ createdAt: entry.batch.createdAt, researchRunId: entry.researchRunId }, participant, ctx)) {
        return entry.resultsFile;
      }
    }
    return undefined;
  }

  /**
   * The strip above the composer: the thread's announced batches still in
   * memory that are running, waiting, or stopped by an error. An
   * operator's Stop, a Cancel, or a clean finish leaves the strip. Memory
   * only: no result file and no database read.
   */
  railActiveBatches(caller: OpenAIDecisionCaller): DecisionsRailActiveBatches {
    const now = this.now();
    const batches = this.batches.list(caller)
      .filter((batch) => isAnnouncedBatch(batch)
        && (!isFinishedBatch(batch)
          || (batch.state === "stopped" && batch.stoppedBy?.code !== OPERATOR_STOP_CODE)))
      .map((batch) => railBatch(batch, now));
    return { batches, now };
  }

  /**
   * Settings → AI Providers → Decisions: every active profile-scope
   * decision, by name. They outlive the thread that registered them, so
   * the operator needs a place to see them that no thread owns.
   */
  profileDecisions(): DecisionsProfileDecision[] {
    return this.options.store.listActiveProfile().map((record) => ({
      ...this.railDecision(record),
      createdAt: record.createdAt,
    }));
  }

  /**
   * The operator's Delete in Settings. Only an active profile-scope
   * decision: a thread's own decisions belong to that thread, and Settings
   * never lists them. Like decisions_delete, batches already running on it
   * finish; later calls by name or id fail.
   */
  deleteProfileDecision(decisionId: string): DecisionsProfileDeleteResult {
    const current = this.options.store.getActive(decisionId);
    if (!current || current.scope !== "profile") return { outcome: "not_found" };
    if (!this.options.store.softDelete(decisionId)) return { outcome: "not_found" };
    this.options.log?.info("deleted decision from settings", logFields(current));
    return { outcome: "deleted" };
  }

  /** One page of a batch's finished items for the Decisions tab. */
  async railBatchPage(
    caller: OpenAIDecisionCaller,
    params: { batchId: string; status: DecisionsRailItemFilter; from: number; limit: number },
  ): Promise<DecisionsRailBatchPage> {
    const record = this.batches.get(caller, params.batchId) ?? await this.railFileRecordFor(caller, params.batchId);
    if (!record) {
      throw new OpenAIDecisionsError("batch_not_found", "This thread has no batch with that id.");
    }
    return railBatchPage(record, { status: params.status, from: params.from, limit: params.limit, now: this.now() });
  }

  /**
   * The operator's Stop or Cancel, from the Decisions tab or the strip
   * above the composer. Stop starts no more items and lets the requests in
   * flight finish, so answers already paid for are kept; Cancel aborts
   * those requests too. A batch still waiting for its lane has nothing in
   * flight, so Stop cancels it. Neither wakes the thread, except that Stop
   * on a batch an error is already stopping leaves that error's wake-up.
   */
  async operatorBatchAction(
    caller: OpenAIDecisionCaller,
    batchId: string,
    action: "stop" | "cancel",
  ): Promise<DecisionsRailBatchActionResult> {
    const batch = this.batches.get(caller, batchId);
    if (!batch || isFinishedBatch(batch)) return { outcome: "not_running" };
    if (action === "cancel" || batch.state === "queued") {
      this.silentBatches.add(batch.batchId);
      batch.cancelReason ??= "cancelled from the thread";
      batch.controller.abort();
      await this.runs.get(batch.batchId);
      return { outcome: "cancelled" };
    }
    // A batch an error is already stopping keeps that cause and its
    // wake-up: the agent waiting on it needs to hear why it ended.
    if (batch.stoppedBy) return { outcome: "stopped" };
    batch.stoppedBy = { code: OPERATOR_STOP_CODE, message: "Stopped from the thread." };
    this.silentBatches.add(batch.batchId);
    return { outcome: "stopped" };
  }

  /** The batch's result file, when it has one, for the tab's Open results file. */
  async railResultsFile(caller: OpenAIDecisionCaller, batchId: string): Promise<string | undefined> {
    const inMemory = this.batches.get(caller, batchId);
    if (inMemory) return inMemory.resultsFile;
    const directory = this.options.batchResultsDirectory?.(caller);
    if (!directory || !isDecisionBatchId(batchId)) return undefined;
    const file = decisionBatchFilePath(directory, batchId);
    return await stat(file).then((info) => info.isFile() ? file : undefined, () => undefined);
  }

  /**
   * At owner shutdown: cancels running batches without an announcement or wake-up
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

  /** A stored decision version as the Decisions tab and Settings show it. */
  private railDecision(record: OpenAIDecisionVersionRecord): DecisionsRailDecision {
    return {
      decisionId: record.decisionId,
      name: record.name,
      version: record.version,
      scope: record.scope,
      ...(record.researchRunId ? { researchRunId: record.researchRunId } : {}),
      provider: record.provider,
      providerDisabled: this.options.isProviderEnabled?.(record.provider) === false,
      questions: record.questions.map((question) => summarizeQuestion(question, false)),
      inputSchema: record.inputSchema,
      ...timingField(this.timings.summary(record.decisionId, record.version)),
    };
  }

  private resolveRegistrationResearchRunId(caller: DecisionBatchCaller, explicitRunId: string | undefined): string {
    if (explicitRunId !== undefined) {
      this.requireResearchRunContext(caller, explicitRunId, "invalid_definition");
      return explicitRunId;
    }
    const active = (this.options.resolveCallerResearchRuns?.(caller) ?? [])
      .filter((run) => run.status === "running" || run.status === "stopping");
    if (active.length === 1) return active[0]!.runId;
    if (active.length === 0) {
      throw new OpenAIDecisionsError(
        "invalid_definition",
        "scope \"research_run\" requires researchRunId or an active research run for this thread.",
      );
    }
    throw new OpenAIDecisionsError(
      "invalid_definition",
      "This thread belongs to multiple active research runs. Pass researchRunId.",
    );
  }

  private soleActiveResearchRunId(caller: DecisionBatchCaller): string | undefined {
    const active = (this.options.resolveCallerResearchRuns?.(caller) ?? [])
      .filter((run) => run.status === "running" || run.status === "stopping");
    return active.length === 1 ? active[0]!.runId : undefined;
  }

  private callerWithResearchRuns(
    caller: OpenAIDecisionCaller,
    explicitRunId?: string,
    missingCode: OpenAIDecisionsErrorCode = "decision_not_found",
  ): OpenAIDecisionCaller {
    if (explicitRunId !== undefined) {
      this.requireResearchRunContext(caller, explicitRunId, missingCode);
      return { backend: caller.backend, threadId: caller.threadId, researchRunIds: [explicitRunId] };
    }
    const memberships = this.options.resolveCallerResearchRuns?.(caller) ?? [];
    if (memberships.length === 0) return { backend: caller.backend, threadId: caller.threadId };
    const ordered = [...memberships].sort((left, right) => {
      const leftActive = left.status === "running" || left.status === "stopping" ? 0 : 1;
      const rightActive = right.status === "running" || right.status === "stopping" ? 0 : 1;
      return leftActive - rightActive || right.createdAt - left.createdAt;
    });
    return {
      backend: caller.backend,
      threadId: caller.threadId,
      researchRunIds: ordered.map((run) => run.runId),
    };
  }

  private requireResearchRunContext(
    caller: DecisionBatchCaller,
    runId: string,
    code: OpenAIDecisionsErrorCode,
  ): DecisionResearchRunContext {
    const ctx = this.options.resolveResearchRunContext?.(caller, runId);
    if (!ctx) {
      throw new OpenAIDecisionsError(code, "This thread is not a member of that research run.");
    }
    return ctx;
  }

  private assertCanMutateResearchDecision(
    caller: DecisionBatchCaller,
    record: OpenAIDecisionVersionRecord,
    code: OpenAIDecisionsErrorCode,
    verb: "update" | "delete",
  ): void {
    if (record.scope !== "research_run" || !record.researchRunId) return;
    if (record.ownerBackend === caller.backend && record.ownerThreadId === caller.threadId) return;
    const ctx = this.options.resolveResearchRunContext?.(caller, record.researchRunId);
    if (ctx?.isCoordinator) return;
    throw new OpenAIDecisionsError(
      code,
      `Only the registering thread or the research run coordinator may ${verb} this research_run decision.`,
    );
  }

  private async listResearchRunBatches(
    ctx: DecisionResearchRunContext,
  ): Promise<Array<{ batch: DecisionBatchRecord; participant: DecisionResearchRunParticipant }>> {
    const seen = new Set<string>();
    const perParticipant = await Promise.all(ctx.participants.map(async (participant) => {
      const batches = await this.listBatches(participant.thread);
      return batches
        .filter((batch) => batchBelongsToResearchRun(batch, participant, ctx))
        .map((batch) => ({ batch, participant }));
    }));
    const combined: Array<{ batch: DecisionBatchRecord; participant: DecisionResearchRunParticipant }> = [];
    for (const list of perParticipant) {
      for (const entry of list) {
        if (seen.has(entry.batch.batchId)) continue;
        seen.add(entry.batch.batchId);
        combined.push(entry);
      }
    }
    return combined.sort((left, right) => right.batch.createdAt - left.batch.createdAt);
  }

  private async findResearchRunBatch(
    ctx: DecisionResearchRunContext,
    batchId: unknown,
  ): Promise<{ batch: DecisionBatchRecord; participant: DecisionResearchRunParticipant }> {
    if (typeof batchId !== "string" || batchId.length === 0) {
      throw new OpenAIDecisionsError("invalid_input", "batchId must be a string.");
    }
    for (const participant of ctx.participants) {
      const batch = this.batches.get(participant.thread, batchId) ?? await this.readBatchFile(participant.thread, batchId);
      if (batch && batchBelongsToResearchRun(batch, participant, ctx)) {
        return { batch, participant };
      }
    }
    throw new OpenAIDecisionsError("batch_not_found", "This research run has no batch with that id.");
  }

  private async accessibleBatch(
    caller: OpenAIDecisionCaller,
    batchId: unknown,
    researchRunId?: string,
  ): Promise<{ batch: DecisionBatchRecord; participant?: DecisionResearchRunParticipant }> {
    if (typeof batchId !== "string" || batchId.length === 0) {
      throw new OpenAIDecisionsError("invalid_input", "batchId must be a string.");
    }
    if (researchRunId !== undefined) {
      const ctx = this.requireResearchRunContext(caller, researchRunId, "batch_not_found");
      return await this.findResearchRunBatch(ctx, batchId);
    }
    const own = this.batches.get(caller, batchId) ?? await this.readBatchFile(caller, batchId);
    if (own) return { batch: own };
    for (const membership of this.options.resolveCallerResearchRuns?.(caller) ?? []) {
      const ctx = this.options.resolveResearchRunContext?.(caller, membership.runId);
      if (!ctx) continue;
      for (const participant of ctx.participants) {
        const batch = this.batches.get(participant.thread, batchId) ?? await this.readBatchFile(participant.thread, batchId);
        if (batch && batchBelongsToResearchRun(batch, participant, ctx)) {
          return { batch, participant };
        }
      }
    }
    throw new OpenAIDecisionsError(
      "batch_not_found",
      "This thread has no batch with that id. Result files keep the latest 20 batches per thread. Call decisions_batch_results without batchId to list them.",
    );
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

  /**
   * The thread's batches for the tab. Files are listed before memory is
   * read: a batch that starts in between is then in memory, and one that
   * leaves memory in between had already written its end line.
   */
  private async railBatches(caller: OpenAIDecisionCaller, now: number): Promise<DecisionsRailBatch[]> {
    const directory = this.options.batchResultsDirectory?.(caller);
    const fileIds = directory ? await listDecisionBatchFileIds(directory) : [];
    const inMemory = this.batches.list(caller);
    const known = new Set(inMemory.map((batch) => batch.batchId));
    const onDisk = directory
      ? await Promise.all(fileIds
        .filter((batchId) => !known.has(batchId))
        .map(async (batchId) => await this.railFileSummary(caller, decisionBatchFilePath(directory, batchId))))
      : [];
    return [
      ...inMemory.map((batch) => railBatch(batch, now)),
      ...onDisk.filter((batch): batch is DecisionsRailBatch => batch !== undefined),
    ].sort((left, right) => right.createdAt - left.createdAt);
  }

  /** Cached participant batches for the Research Decisions tab, newest first. */
  private async listResearchRunRailBatches(
    ctx: DecisionResearchRunContext,
    now: number,
  ): Promise<ResearchDecisionBatchSummary[]> {
    const seen = new Set<string>();
    const perParticipant = await Promise.all(ctx.participants.map(async (participant) => {
      const directory = this.options.batchResultsDirectory?.(participant.thread);
      const fileIds = directory ? await listDecisionBatchFileIds(directory) : [];
      const inMemory = this.batches.list(participant.thread);
      const known = new Set(inMemory.map((batch) => batch.batchId));
      const caller = {
        backend: participant.thread.backend as ResearchThread["backend"],
        threadId: participant.thread.threadId,
      };
      const meta = {
        caller,
        role: participant.role,
        ...(participant.approachId ? { approachId: participant.approachId } : {}),
        ...(participant.approachTitle ? { approachTitle: participant.approachTitle } : {}),
      };
      const live: ResearchDecisionBatchSummary[] = inMemory
        .filter((batch) => batchBelongsToResearchRun(batch, participant, ctx))
        .map((batch) => ({ ...railBatch(batch, now), ...meta }));
      const onDisk = directory
        ? await Promise.all(fileIds
          .filter((batchId) => !known.has(batchId))
          .map(async (batchId) => {
            const entry = await this.railFileSummaryEntry(participant.thread, decisionBatchFilePath(directory, batchId));
            if (!entry) return undefined;
            if (!batchBelongsToResearchRun({ createdAt: entry.batch.createdAt, researchRunId: entry.researchRunId }, participant, ctx)) {
              return undefined;
            }
            return { ...entry.batch, ...meta };
          }))
        : [];
      return [...live, ...onDisk.filter((item): item is ResearchDecisionBatchSummary => item !== undefined)];
    }));
    const combined: ResearchDecisionBatchSummary[] = [];
    for (const list of perParticipant) {
      for (const entry of list) {
        if (seen.has(entry.batchId)) continue;
        seen.add(entry.batchId);
        combined.push(entry);
      }
    }
    return combined.sort((left, right) => right.createdAt - left.createdAt);
  }

  private async railFileSummary(caller: OpenAIDecisionCaller, file: string): Promise<DecisionsRailBatch | undefined> {
    return (await this.railFileSummaryEntry(caller, file))?.batch;
  }

  private async railFileSummaryEntry(
    caller: OpenAIDecisionCaller,
    file: string,
  ): Promise<{ mtimeMs: number; size: number; batch: DecisionsRailBatch; researchRunId?: string; resultsFile: string } | undefined> {
    const info = await stat(file).catch(() => undefined);
    if (!info) return undefined;
    const cached = this.railFileSummaries.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    const record = await readDecisionBatchFile(file, caller);
    if (!record) return undefined;
    const entry = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      batch: railBatch(record, this.now()),
      ...(record.researchRunId ? { researchRunId: record.researchRunId } : {}),
      resultsFile: record.resultsFile ?? file,
    };
    this.railFileSummaries.delete(file);
    this.railFileSummaries.set(file, entry);
    // Result files keep 20 batches per thread; this bounds the cache across threads.
    while (this.railFileSummaries.size > RAIL_FILE_SUMMARY_LIMIT) {
      const oldest = this.railFileSummaries.keys().next().value;
      if (oldest === undefined) break;
      this.railFileSummaries.delete(oldest);
    }
    return entry;
  }

  private async railFileRecordFor(caller: OpenAIDecisionCaller, batchId: string) {
    const directory = this.options.batchResultsDirectory?.(caller);
    if (!directory || !isDecisionBatchId(batchId)) return undefined;
    const file = decisionBatchFilePath(directory, batchId);
    const info = await stat(file).catch(() => undefined);
    if (!info) return undefined;
    const cached = this.railFileRecord;
    if (cached && cached.file === file && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.record;
    }
    const record = await readDecisionBatchFile(file, caller);
    this.railFileRecord = record ? { file, mtimeMs: info.mtimeMs, size: info.size, record } : undefined;
    return record;
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
    outputFile?: string,
    outputDetail?: DecisionBatchDetail,
    researchRunId?: string,
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
      ...(outputFile ? { outputFile, outputDetail: outputDetail ?? "compact" } : {}),
      ...(researchRunId ? { researchRunId } : {}),
      definition: batchDefinition(record.questions, record.prefix),
    };
  }

  private async loadInputsFile(rawPath: unknown, access: DecisionFileAccess | undefined): Promise<unknown[]> {
    try {
      return await readDecisionInputsFile(rawPath, access);
    } catch (error) {
      if (error instanceof DecisionFileError) {
        throw new OpenAIDecisionsError(error.code, error.message);
      }
      throw error;
    }
  }

  private async validateOutputFile(rawPath: unknown, access: DecisionFileAccess | undefined): Promise<string> {
    try {
      return await resolveWritableDecisionOutputFile(rawPath, access);
    } catch (error) {
      if (error instanceof DecisionFileError) {
        throw new OpenAIDecisionsError(error.code, error.message);
      }
      throw error;
    }
  }

  private async finishSingleInvoke(
    raw: DecisionItemResult,
    detail: DecisionBatchDetail,
    outputFile: string | undefined,
    inlineResults: boolean,
    access: DecisionFileAccess | undefined,
  ): Promise<Record<string, unknown>> {
    const formatted = detail === "compact" ? compactSingleResult(raw) : raw;
    if (!outputFile) return formatted;
    let writtenPath: string;
    try {
      writtenPath = await writeDecisionOutputFile(outputFile, formatSingleOutputFile(formatted), access);
    } catch (error) {
      if (error instanceof DecisionFileError) {
        throw new OpenAIDecisionsError(error.code, error.message);
      }
      throw new OpenAIDecisionsError("invalid_input", "Could not write outputFile.");
    }
    if (!inlineResults) {
      return {
        decisionId: raw.decisionId,
        name: raw.name,
        version: raw.version,
        provider: raw.provider,
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.requestId ? { requestId: raw.requestId } : {}),
        detail,
        usage: raw.usage,
        outputFile: writtenPath,
      };
    }
    return { ...formatted, outputFile: writtenPath };
  }

  private async writeBatchOutputFile(batch: DecisionBatchRecord): Promise<void> {
    if (!batch.outputFile) return;
    try {
      const access = await this.options.resolveCallerFileAccess?.(batch.caller);
      const content = formatBatchOutputFile(batch, batch.outputDetail ?? "compact", batch.outputFile);
      batch.outputFile = await writeDecisionOutputFile(batch.outputFile, content, access);
    } catch (error) {
      batch.outputFileError = error instanceof Error ? error.message : "Could not write outputFile.";
      this.options.log?.warn("decision batch output file not written", {
        decisionId: batch.decisionId,
        batchId: batch.batchId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /**
   * A batch cancelled while it waited for its lane, so nothing was sent,
   * or one that failed unexpectedly. Either way it ends cancelled, and
   * whatever finished stays readable.
   */
  private async finishUnstarted(batch: DecisionBatchRecord, announcer: BatchAnnouncer, error: unknown): Promise<void> {
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
    await this.finishBatch(batch, announcer);
  }

  /** The stored version a call names: latest active, or a pinned version. */
  private registeredRecord(caller: OpenAIDecisionCaller, args: Record<string, unknown>, requestedRunId?: string) {
    if (
      args.version !== undefined
      && (!Number.isInteger(args.version) || (args.version as number) < 1)
    ) {
      throw new OpenAIDecisionsError("invalid_input", "version must be a positive integer.");
    }
    const latest = this.resolveTarget(caller, args, requestedRunId);
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
    const raw = args.definition as Record<string, unknown> | undefined;
    if (raw && hasDecisionImageParts(raw.prefix)) {
      this.assertDefinitionImages(await this.registrationProvider(raw.provider), raw);
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

  private async registrationProvider(value: unknown): Promise<RegisteredDecisionProvider> {
    return isRegisteredDecisionProvider(value) ? value : await this.options.resolveDefaultProvider?.() ?? "openai";
  }

  private imageCapabilities(provider: RegisteredDecisionProvider) {
    return decisionImageCapabilities(provider, this.options.readProviderModel?.(provider));
  }

  private assertDefinitionImages(provider: RegisteredDecisionProvider, args: Record<string, unknown>): void {
    const schema = args.inputSchema as OpenAIDecisionInputSchema | undefined;
    if ((hasDecisionImageParts(args.prefix) || schema?.[DECISION_IMAGE_SCHEMA_KEY] === true)
      && !this.imageCapabilities(provider).supported) {
      throw new OpenAIDecisionsError("images_unsupported", unsupportedImagesMessage(provider));
    }
  }

  private async imageReferences(input: PreparedDecisionInput, thumbnail: boolean) {
    if (input.images.length === 0) return undefined;
    const decode = this.options.decodeImage ?? ((buffer: Buffer) => imageCodec.createFromBuffer(buffer));
    const references = await decisionImageReferences(input.images, decode, thumbnail);
    if (!references) throw new OpenAIDecisionsError("invalid_image", "An input image could not be decoded.");
    return references;
  }

  /**
   * Checks the provider's credential once, then returns the function that
   * runs one validated input. It throws OpenAIDecisionsError on failure.
   */
  private async itemRunner(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    signal: AbortSignal | undefined,
  ): Promise<RunDecisionItem> {
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
  ): Promise<RunDecisionItem> {
    const run = await this.ungatedItemRunner(caller, record, signal);
    // Checked again per item: turning a provider off stops a batch that is
    // running and a call waiting in its lane. The error stops the batch.
    return async (input) => {
      this.assertProviderEnabled(record.provider);
      return await run(input);
    };
  }

  private async ungatedItemRunner(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    signal: AbortSignal | undefined,
  ): Promise<RunDecisionItem> {
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
      return async (input) => {
        if (input.images.length > 0 && !decisionImageCapabilities(provider, target.model).supported) {
          throw new OpenAIDecisionsError("images_unsupported", unsupportedImagesMessage(provider));
        }
        return await this.postSystemOne(record, provider, target, input, signal);
      };
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
    inputs: readonly (PreparedDecisionInput | OpenAIDecisionsError)[],
    run: RunDecisionItem | undefined,
    announcer: BatchAnnouncer,
    onProgress?: (message: string) => void,
  ): Promise<void> {
    const signal = batch.controller.signal;
    batch.state = "running";
    batch.startedAt = this.now();
    announcer.update();
    function* pending(): Generator<number> {
      for (let index = 0; index < inputs.length; index += 1) {
        if (batch.stoppedBy || signal.aborted) return;
        yield index;
      }
    }
    const mapper = new IterableMapper(pending(), async (index: number): Promise<number> => {
      const startedAt = this.now();
      // A preview of the input and the item's time, for the Decisions tab.
      const input = inputs[index]!;
      const preview = input instanceof OpenAIDecisionsError ? {} : decisionInputPreview(input.value);
      let inputImages: DecisionsRailItem["inputImages"];
      const rail = () => ({
        ...preview,
        ...(inputImages ? { inputImages } : {}),
        durationMs: Math.max(0, this.now() - startedAt),
      });
      try {
        if (input instanceof OpenAIDecisionsError) throw input;
        inputImages = await this.imageReferences(input, true);
        if (!run) throw new Error("No runner for a valid decision input.");
        const result = await run(input);
        this.recordItem(batch, { index, ok: true, ...batchItemData(result), ...rail() });
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
          this.recordItem(batch, {
            index,
            ok: false,
            code: "internal_error",
            message: "The item failed unexpectedly.",
            ...rail(),
          });
        } else {
          this.recordItem(batch, { index, ok: false, code: error.code, message: error.message, ...rail() });
          if (BATCH_STOPPING_CODES.has(error.code)) batch.stoppedBy ??= { code: error.code, message: error.message };
        }
      }
      announcer.progress();
      onProgress?.(batchProgressLine(batch));
      return index;
    }, { concurrency: batch.concurrency, maxUnread: batch.concurrency * 2 });
    for await (const _index of mapper) {
      // Results are written by index; draining keeps the mapper moving.
    }
    await this.finishBatch(batch, announcer);
  }

  /** Skips what never ran, settles the state, and tells the thread. */
  private async finishBatch(
    batch: DecisionBatchRecord,
    announcer: BatchAnnouncer,
  ): Promise<void> {
    // A Stop that came after every item started stopped nothing: the batch
    // completed, and a background one still wakes its thread.
    if (batch.stoppedBy?.code === OPERATOR_STOP_CODE && batch.results.every((item) => item !== undefined)) {
      delete batch.stoppedBy;
      this.silentBatches.delete(batch.batchId);
    }
    const skippedReason = batch.stoppedBy
      ? `Skipped after ${batch.stoppedBy.code}.`
      : `Skipped because ${batch.cancelReason ?? "the call was cancelled"}.`;
    for (let index = 0; index < batch.count; index += 1) {
      if (batch.results[index] === undefined) {
        this.recordItem(batch, { index, ok: false, code: "skipped", message: skippedReason });
      }
    }
    const willWake = batch.background
      && !this.silentBatches.has(batch.batchId)
      && !this.closing
      && this.options.wakeThread !== undefined;
    if (willWake) {
      this.pendingWakeups.set(batch.batchId, {
        caller: batch.caller,
        ...(batch.researchRunId ? { researchRunId: batch.researchRunId } : {}),
      });
    }
    // A cancel that came after every item was answered cancelled nothing.
    batch.state = batch.stoppedBy
      ? "stopped"
      : batch.controller.signal.aborted && batch.succeeded < batch.count
        ? "cancelled"
        : "completed";
    batch.finishedAt = this.now();
    // Write caller outputFile before settling the end line so resultsFile
    // persists both outputFile and any outputFileError across eviction/restart.
    await this.writeBatchOutputFile(batch);
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
    await announcer.finish();
    const silent = this.silentBatches.delete(batch.batchId);
    if (!batch.background) return;
    if (silent || this.closing || !this.options.wakeThread) {
      this.pendingWakeups.delete(batch.batchId);
      if (!this.closing) this.options.onBackgroundBatchSettled?.(batch.caller, false);
      return;
    }
    let woken = false;
    try {
      await this.options.wakeThread(batch.caller, { batchId: batch.batchId, text: batchWakeupText(batch) });
      woken = true;
    } catch (error) {
      this.options.log?.warn("decision batch wake-up not delivered", {
        decisionId: batch.decisionId,
        batchId: batch.batchId,
        error: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      this.pendingWakeups.delete(batch.batchId);
    }
    this.options.onBackgroundBatchSettled?.(batch.caller, woken);
  }

  /**
   * Tells the batch's thread it moved: when it starts, at each further
   * tenth of its items finished, and when it ends, at most 11 times a
   * batch whatever its size. Nothing is written; the Decisions tab and the
   * strip above the composer read the batch itself. Announcements run in
   * order and a failed one never fails the batch. Small blocking batches,
   * which end inside their tool call, are not announced.
   */
  private batchAnnouncer(batch: DecisionBatchRecord): BatchAnnouncer {
    const announce = this.options.announceBatch;
    const announced = announce !== undefined && isAnnouncedBatch(batch);
    let chain: Promise<void> = Promise.resolve();
    let step = -1;
    const write = () => {
      if (!announced || this.closing) return;
      const update: DecisionBatchUpdate = {
        caller: batch.caller,
        batchId: batch.batchId,
        status: !isFinishedBatch(batch)
          ? "running"
          : batch.state === "completed"
            ? "success"
            // An operator's Stop is not a failure; an error's is.
            : batch.state === "stopped" && batch.stoppedBy?.code !== OPERATOR_STOP_CODE
              ? "failed"
              : "cancelled",
        finished: finishedItems(batch),
        count: batch.count,
      };
      chain = chain
        .then(async () => await announce(update))
        .catch((error: unknown) => this.options.log?.warn("decision batch update not announced", {
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
        const next = Math.floor((finishedItems(batch) * BATCH_ANNOUNCE_STEPS) / batch.count);
        // The last step is the finish, which announces itself.
        if (next > step && next < BATCH_ANNOUNCE_STEPS) {
          step = next;
          write();
        }
      },
      finish: async () => {
        // A batch cancelled before it started was never announced, and
        // nothing is waiting to hear that it ended.
        if (step >= 0) write();
        await chain;
      },
    };
  }

  private async post(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    input: PreparedDecisionInput,
    apiKey: string,
    signal: AbortSignal | undefined,
  ): Promise<DecisionItemResult> {
    const account = this.options.readAccountSettings();
    const body = buildOpenAIDecisionsRequestBody({
      questions: record.questions,
      prefix: record.prefix,
      input: input.value,
      images: input.images,
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
        `${result.code}:${statusNote}${requestNote}${result.detail && !input.images.length ? ` ${result.detail}` : ""}`.trim(),
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
    input: PreparedDecisionInput,
    signal: AbortSignal | undefined,
  ): Promise<DecisionItemResult> {
    const request = buildSystemOneDecisionRequest({
      questions: record.questions,
      prefix: record.prefix,
      input: input.value,
      media: { provider, images: input.images },
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
        `${result.code}:${statusNote}${result.detail && !input.images.length ? ` ${result.detail}` : ""}`.trim(),
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
    requestedRunId?: string,
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
    const matchesRequestedRun = (record: OpenAIDecisionVersionRecord): boolean =>
      requestedRunId === undefined
      || (record.scope === "research_run" && record.researchRunId === requestedRunId);
    if (decisionId) {
      const active = this.options.store.getActive(decisionId);
      if (active && isVisible(active, caller) && matchesRequestedRun(active)) {
        if (name && active.name !== name) {
          throw new OpenAIDecisionsError("invalid_input", "name and decisionId name different decisions.");
        }
        return active;
      }
      const first = this.options.store.getVersion(decisionId, 1);
      if (first && first.status === "deleted" && isVisible(first, caller) && matchesRequestedRun(first)) {
        throw new OpenAIDecisionsError("decision_deleted", `Decision "${first.name}" was deleted.`);
      }
      throw new OpenAIDecisionsError(
        "decision_not_found",
        requestedRunId !== undefined
          ? `No active decision with that id exists in research run "${requestedRunId}".`
          : "No visible decision has that id.",
      );
    }
    const matches = this.options.store.findActiveByName(name!, caller);
    const match = requestedRunId !== undefined
      ? matches.find(matchesRequestedRun)
      : matches[0];
    if (!match) {
      if (requestedRunId === undefined && this.options.store.hasDeletedName(name!, caller)) {
        throw new OpenAIDecisionsError("decision_deleted", `Decision "${name}" was deleted.`);
      }
      throw new OpenAIDecisionsError(
        "decision_not_found",
        requestedRunId !== undefined
          ? `No active decision named "${name}" exists in research run "${requestedRunId}". Call decisions_list.`
          : `No active decision named "${name}" is visible to this thread. Call decisions_list.`,
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
type RunDecisionItem = (input: PreparedDecisionInput) => Promise<DecisionItemResult>;

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

function unsupportedImagesMessage(provider: RegisteredDecisionProvider): string {
  return `The ${provider} provider's configured model does not accept images in PwrAgent. Use OpenAI Decisions or select a Clef model for the local provider.`;
}

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
  if (!bulk) throw new OpenAIDecisionsError("invalid_input", "concurrency applies only to inputs or inputsFile.");
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > OPENAI_DECISION_BOUNDS.bulkMaxConcurrency) {
    throw new OpenAIDecisionsError(
      "invalid_input",
      `concurrency must be an integer from 1 to ${OPENAI_DECISION_BOUNDS.bulkMaxConcurrency}.`,
    );
  }
  return value as number;
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
  if (value && !bulk) throw new OpenAIDecisionsError("invalid_input", "background applies only to inputs or inputsFile.");
  return value;
}

function parseInlineResults(value: unknown, hasOutputFile: boolean, bulk: boolean): boolean {
  if (value === undefined) return !hasOutputFile;
  if (typeof value !== "boolean") {
    throw new OpenAIDecisionsError("invalid_input", "inlineResults must be true or false.");
  }
  if (!value && !bulk && !hasOutputFile) {
    throw new OpenAIDecisionsError("invalid_input", "inlineResults: false requires outputFile for a single input.");
  }
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

function parseOptionalResearchRunId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 300 || /\s/.test(value)) {
    throw new OpenAIDecisionsError("invalid_input", "researchRunId must be a non-empty id without whitespace.");
  }
  return value;
}

function batchBelongsToResearchRun(
  batch: Pick<DecisionBatchRecord, "createdAt" | "researchRunId">,
  participant: DecisionResearchRunParticipant,
  ctx: Pick<DecisionResearchRunContext, "runId" | "createdAt">,
): boolean {
  if (batch.researchRunId !== undefined) return batch.researchRunId === ctx.runId;
  return participant.role === "worker";
}

function isVisible(record: OpenAIDecisionVersionRecord, caller: OpenAIDecisionCaller): boolean {
  if (record.scope === "profile") return true;
  if (record.scope === "research_run") {
    return Boolean(record.researchRunId && caller.researchRunIds?.includes(record.researchRunId));
  }
  return record.ownerBackend === caller.backend && record.ownerThreadId === caller.threadId;
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
