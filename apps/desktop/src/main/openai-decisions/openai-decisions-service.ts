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
  | "credential_rejected"
  | "model_unavailable"
  | "rate_limited"
  | "overloaded"
  | "busy"
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
};

const INVOKE_KEYS = new Set(["name", "decisionId", "version", "input", "inputs", "concurrency", "definition"]);
/** A failure every later item in a batch would repeat. */
const BATCH_STOPPING_CODES = new Set(["credential_missing", "credential_rejected", "model_unavailable"]);
const TARGET_KEYS = new Set(["name", "decisionId"]);

/**
 * Registered OpenAI Decisions. The registry is local: OpenAI has no
 * register, update, delete, or version API. Invoke replays the stored
 * questions on `POST /v1/decisions`. The key is read from the secret store
 * inside invoke and never appears in a row, a result, or a log line.
 */
export class OpenAIDecisionsService {
  private readonly lanes = new Map<string, { active: boolean; waiters: Array<() => void> }>();
  private readonly usage: OpenAIDecisionsUsageBatcher;

  constructor(private readonly options: OpenAIDecisionsServiceOptions) {
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

  async invoke(caller: OpenAIDecisionCaller, args: Record<string, unknown>, signal?: AbortSignal) {
    for (const key of Object.keys(args)) {
      if (!INVOKE_KEYS.has(key)) throw new OpenAIDecisionsError("invalid_input", `Unknown property "${key}".`);
    }
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
    const run = await this.itemRunner(caller, record, signal);
    return await this.inLane(record.decisionId, signal, async () => {
      if (!bulk) return await run(validated[0]);
      return await this.runBatch(record, validated, concurrency, run, signal);
    });
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
    const decisionId = `adhoc:${sha256Hex(canonicalJson({
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

  /**
   * Checks the provider's credential once, then returns the function that
   * runs one validated input. It throws OpenAIDecisionsError on failure.
   */
  private async itemRunner(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    signal: AbortSignal | undefined,
  ): Promise<(input: unknown) => Promise<DecisionItemResult>> {
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
   * Runs a batch with at most `concurrency` requests in flight. Results come
   * back in input order. A failed item does not stop the others, except a
   * failure no later item can avoid (a missing or rejected credential, an
   * unavailable model) or a cancelled call: the rest are then skipped.
   */
  private async runBatch(
    record: OpenAIDecisionVersionRecord,
    inputs: readonly unknown[],
    concurrency: number,
    run: (input: unknown) => Promise<DecisionItemResult>,
    signal: AbortSignal | undefined,
  ) {
    let stopped: { code: string; message: string } | undefined;
    const results: BatchItemResult[] = new Array(inputs.length);
    function* pending(): Generator<number> {
      for (let index = 0; index < inputs.length; index += 1) {
        if (stopped || signal?.aborted) return;
        yield index;
      }
    }
    const mapper = new IterableMapper(pending(), async (index: number): Promise<number> => {
      try {
        results[index] = { index, ok: true, ...batchItemData(await run(inputs[index])) };
      } catch (error) {
        // Any failure stays with its item: earlier items were sent and
        // billed, and their answers must not be lost to one bad item.
        if (!(error instanceof OpenAIDecisionsError)) {
          this.options.log?.warn("decision batch item failed unexpectedly", {
            ...logFields(record),
            index,
            error: error instanceof Error ? error.name : "unknown",
          });
          results[index] = { index, ok: false, code: "internal_error", message: "The item failed unexpectedly." };
          return index;
        }
        results[index] = { index, ok: false, code: error.code, message: error.message };
        if (BATCH_STOPPING_CODES.has(error.code)) stopped ??= { code: error.code, message: error.message };
      }
      return index;
    }, { concurrency, maxUnread: concurrency * 2 });
    for await (const _index of mapper) {
      // Results are written by index; draining keeps the mapper moving.
    }
    const skippedReason = stopped
      ? `Skipped after ${stopped.code}.`
      : "Skipped because the call was cancelled.";
    for (let index = 0; index < inputs.length; index += 1) {
      results[index] ??= { index, ok: false, code: "skipped", message: skippedReason };
    }
    const succeeded = results.filter((result) => result.ok).length;
    this.options.log?.info("decision batch finished", {
      ...logFields(record),
      items: inputs.length,
      succeeded,
      concurrency,
      ...(stopped ? { stoppedBy: stopped.code } : {}),
    });
    return {
      decisionId: record.decisionId,
      name: record.name,
      version: record.version,
      provider: record.provider,
      count: inputs.length,
      succeeded,
      failed: inputs.length - succeeded,
      ...(stopped ? { stoppedBy: stopped } : {}),
      results,
      usage: batchUsage(results),
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
      if (lane.waiters.length >= (this.options.queueLimit ?? 4)) {
        throw new OpenAIDecisionsError(
          "busy",
          "This decision already has one request in flight and four waiting. Try again shortly.",
        );
      }
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

type BatchItemResult =
  | ({ index: number; ok: true } & Partial<Pick<DecisionItemResult, "model" | "requestId" | "response" | "answers">> & {
      usage?: Record<string, unknown>;
    })
  | { index: number; ok: false; code: string; message: string };

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

/** Token and price totals across a batch's OpenAI items. */
function batchUsage(results: readonly BatchItemResult[]) {
  const totals = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let costUsd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const result of results) {
    if (!result.ok || !result.usage) continue;
    const usage = result.usage;
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      if (typeof usage[key] === "number") totals[key] += usage[key] as number;
    }
    if (usage.priceStatus === "estimated" && typeof usage.estimatedCostUsd === "number") {
      priced += 1;
      costUsd += usage.estimatedCostUsd;
    } else {
      unpriced += 1;
    }
  }
  if (priced === 0 && unpriced === 0) {
    return { priceStatus: "unavailable", priceUnavailableReason: "the provider reports no token usage" };
  }
  return {
    ...totals,
    priceStatus: unpriced === 0 ? "estimated" : priced === 0 ? "unavailable" : "partial",
    estimatedCostUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    pricedItems: priced,
    unpricedItems: unpriced,
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
