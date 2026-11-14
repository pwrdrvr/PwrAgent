import { createHash, randomUUID } from "node:crypto";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import {
  OPENAI_DECISIONS_ORIGIN,
  OPENAI_DECISIONS_PRICING_CATALOG_ID,
  OPENAI_DECISIONS_PRICING_CATALOG_VERSION,
  OPENAI_DECISIONS_PROVIDER,
  buildOpenAIDecisionsRequestBody,
  findCredentialProperty,
  openAIDecisionPromptCacheMaterial,
  openAIDecisionSafetyMaterial,
  parseOpenAIDecisionRegistration,
  priceOpenAIDecisionsUsage,
  readOpenAIDecisionsUsage,
  validateOpenAIDecisionInput,
  type OpenAIDecisionQuestion,
  type OpenAIDecisionsPrice,
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
  readAccountSettings: () => { organizationId?: string; projectId?: string };
  profileId: () => string;
  recordUsageLine: (line: ThreadUsageLineRecord) => Promise<void>;
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

const INVOKE_KEYS = new Set(["name", "decisionId", "version", "input"]);
const TARGET_KEYS = new Set(["name", "decisionId"]);

/**
 * Registered OpenAI Decisions. The registry is local: OpenAI has no
 * register, update, delete, or version API. Invoke replays the stored
 * questions on `POST /v1/decisions`. The key is read from the secret store
 * inside invoke and never appears in a row, a result, or a log line.
 */
export class OpenAIDecisionsService {
  private readonly lanes = new Map<string, { active: boolean; waiters: Array<() => void> }>();

  constructor(private readonly options: OpenAIDecisionsServiceOptions) {}

  register(caller: OpenAIDecisionCaller, args: Record<string, unknown>) {
    const parsed = parseOpenAIDecisionRegistration(args);
    if (!parsed.ok) throw new OpenAIDecisionsError("invalid_definition", parsed.message);
    const definition = parsed.value;
    if (this.options.store.findActiveByName(definition.name, caller).length > 0) {
      throw nameTaken(definition.name);
    }
    const decisionId = (this.options.newDecisionId ?? randomUUID)();
    const record: OpenAIDecisionVersionRecord = {
      decisionId,
      version: 1,
      name: definition.name,
      scope: definition.scope,
      ownerBackend: caller.backend,
      ...(definition.scope === "thread" ? { ownerThreadId: caller.threadId } : {}),
      status: "active",
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
    const credential = findCredentialProperty(args);
    if (credential) {
      throw new OpenAIDecisionsError(
        "invalid_input",
        `Property "${credential}" is not allowed. The host attaches the OpenAI key itself.`,
      );
    }
    if (!("input" in args)) throw new OpenAIDecisionsError("invalid_input", "input is required.");
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
    const input = validateOpenAIDecisionInput(record.inputSchema, args.input);
    if (!input.ok) throw new OpenAIDecisionsError("invalid_input", input.message);
    const apiKey = (await this.options.readApiKey())?.trim();
    if (!apiKey) {
      throw new OpenAIDecisionsError(
        "credential_missing",
        "No OpenAI Decisions API key is saved. Add one in Settings → AI Providers → OpenAI Decisions.",
      );
    }
    return await this.inLane(record.decisionId, async () =>
      await this.post(caller, record, input.value, apiKey, signal));
  }

  private async post(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    input: unknown,
    apiKey: string,
    signal: AbortSignal | undefined,
  ) {
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
      await this.recordUsage(caller, record, attempt, accountKey);
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
      model: typeof result.body.model === "string" ? result.body.model : undefined,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      response,
      usage: usageSummary(usage, price),
    };
  }

  private async recordUsage(
    caller: OpenAIDecisionCaller,
    record: OpenAIDecisionVersionRecord,
    attempt: OpenAIDecisionsAttempt,
    accountKey: string,
  ): Promise<void> {
    const line = buildOpenAIDecisionsUsageLine({
      caller,
      decisionId: record.decisionId,
      version: record.version,
      attempt,
      accountKey,
      now: this.now(),
      fallbackId: randomUUID(),
    });
    try {
      await this.options.recordUsageLine(line);
    } catch (error) {
      this.options.log?.warn("decision usage line not recorded", {
        ...logFields(record),
        error: error instanceof Error ? error.name : "unknown",
      });
    }
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

  private async inLane<T>(decisionId: string, work: () => Promise<T>): Promise<T> {
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
      await new Promise<void>((resolve) => lane!.waiters.push(resolve));
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

/**
 * One finalized ledger row for one HTTP attempt that returned usage. The
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
  return { decisionId: record.decisionId, version: record.version, scope: record.scope };
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
