import { createHash } from "node:crypto";
import {
  normalizeXaiResponse,
  resolveGrokAppServerRuntimeConfig,
  XaiResponsesClient
} from "@pwragnt/agent-core";
import type {
  FocusedDiffAnalysisRequest,
  FocusedDiffAnalysisResponse,
  FocusedDiffHunkDecision,
  FocusedDiffHunkSummary,
  FocusedDiffReasonCode
} from "@pwragnt/shared";
import {
  getFocusedDiffEligibility,
  parseUnifiedDiff,
  summarizeHunksForFocus
} from "../../shared/diff-focus";

const FOCUSED_DIFF_PROMPT_VERSION = "focused-diff-v1";
const FOCUSED_DIFF_MODEL = "grok-4.20-fast";
const FOCUSED_DIFF_TIMEOUT_MS = 5_000;
const MIN_HIDE_CONFIDENCE = 0.8;
const FOCUSED_DIFF_TEST_RESPONSE_ENV = "PWRAGNT_FOCUSED_DIFF_TEST_RESPONSE";

const FOCUSED_DIFF_REASON_CODES = [
  "comment_only",
  "formatting_only",
  "import_reorder",
  "keep",
  "mechanical_small_change",
  "repetitive_small_change",
  "uncertain"
] as const satisfies readonly FocusedDiffReasonCode[];

const HIDEABLE_REASON_CODES = new Set<FocusedDiffReasonCode>([
  "comment_only",
  "formatting_only",
  "import_reorder",
  "mechanical_small_change",
  "repetitive_small_change"
]);

const FOCUSED_DIFF_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "disposition", "reasonCode", "reason", "confidence"],
        properties: {
          index: { type: "integer", minimum: 0 },
          disposition: { type: "string", enum: ["show", "hide"] },
          reasonCode: { type: "string", enum: FOCUSED_DIFF_REASON_CODES },
          reason: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
} as const;

const FOCUSED_DIFF_SYSTEM_PROMPT = [
  "You classify unified diff hunks for a zoomed-out code review view.",
  "Hide only clearly low-signal hunks such as comment-only edits, formatting-only edits, import reorders, or repetitive tiny mechanical changes.",
  "Show hunks when they alter logic, data flow, behavior, interfaces, tests, or anything uncertain.",
  "Return JSON that matches the schema exactly."
].join("\n");

type XaiClientLike = Pick<XaiResponsesClient, "createResponse">;

type FocusedDiffServiceOptions = {
  apiKey?: string;
  baseUrl?: string;
  client?: XaiClientLike;
  model?: string;
  promptVersion?: string;
  timeoutMs?: number;
};

export class FocusedDiffService {
  private readonly cache = new Map<string, FocusedDiffAnalysisResponse>();
  private readonly configuredClient?: XaiClientLike;
  private readonly configuredApiKey?: string;
  private readonly configuredBaseUrl?: string;
  private readonly configuredModel?: string;
  private readonly promptVersion: string;
  private readonly timeoutMs: number;
  private runtimeConfig:
    | ReturnType<typeof resolveGrokAppServerRuntimeConfig>
    | undefined;
  private envClient: XaiClientLike | null | undefined;

  constructor(options: FocusedDiffServiceOptions = {}) {
    this.configuredClient = options.client;
    this.configuredApiKey = options.apiKey?.trim() || undefined;
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.configuredModel = options.model?.trim() || undefined;
    this.promptVersion = options.promptVersion?.trim() || FOCUSED_DIFF_PROMPT_VERSION;
    this.timeoutMs = options.timeoutMs ?? FOCUSED_DIFF_TIMEOUT_MS;
  }

  async analyze(
    request: FocusedDiffAnalysisRequest
  ): Promise<FocusedDiffAnalysisResponse> {
    const parsed = parseUnifiedDiff(request.diff);
    const decisions = createDefaultDecisions(parsed.hunks.length);
    const eligibility = getFocusedDiffEligibility(parsed);

    if (!eligibility.eligible) {
      return {
        mode: "full",
        source: "ineligible",
        hiddenHunkIndices: [],
        hiddenHunkCount: 0,
        decisions,
        reason: eligibility.reason
      };
    }

    const hunks =
      request.hunks.length === parsed.hunks.length
        ? request.hunks
        : summarizeHunksForFocus(parsed);
    const cacheKey = buildFocusedDiffCacheKey(
      this.promptVersion,
      request.filePath,
      request.diff
    );
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return {
        ...cached,
        source: "cache"
      };
    }

    const testOverride = readFocusedDiffTestOverride(parsed.hunks.length);
    if (testOverride) {
      this.cache.set(cacheKey, testOverride);
      return testOverride;
    }

    const client = this.getClient();
    if (!client) {
      return this.buildFallbackResponse(decisions, "grok_unavailable");
    }

    try {
      const response = await this.requestFocusedDiffDecision(client, request.filePath, hunks);
      const result = normalizeFocusedDiffResult(response, parsed.hunks.length);
      const analysis: FocusedDiffAnalysisResponse = {
        mode: result.hiddenHunkIndices.length > 0 ? "focused" : "fallback",
        source: "grok",
        hiddenHunkIndices: result.hiddenHunkIndices,
        hiddenHunkCount: result.hiddenHunkIndices.length,
        decisions: result.decisions,
        cachedTokens: readCachedTokenCount(response),
        ...(result.hiddenHunkIndices.length === 0 ? { reason: "no_hideable_hunks" } : {})
      };
      this.cache.set(cacheKey, analysis);
      return analysis;
    } catch (error) {
      return this.buildFallbackResponse(
        decisions,
        error instanceof Error ? error.message : "grok_request_failed"
      );
    }
  }

  private buildFallbackResponse(
    decisions: FocusedDiffHunkDecision[],
    reason: string
  ): FocusedDiffAnalysisResponse {
    return {
      mode: "fallback",
      source: "heuristic",
      hiddenHunkIndices: [],
      hiddenHunkCount: 0,
      decisions,
      reason
    };
  }

  private getClient(): XaiClientLike | null {
    if (this.configuredClient) {
      return this.configuredClient;
    }

    if (this.envClient !== undefined) {
      return this.envClient;
    }

    const runtimeConfig = this.getRuntimeConfig();
    const apiKey = this.configuredApiKey ?? runtimeConfig.apiKey;
    if (!apiKey) {
      this.envClient = null;
      return this.envClient;
    }

    this.envClient = new XaiResponsesClient({
      apiKey,
      baseUrl: this.configuredBaseUrl ?? runtimeConfig.baseUrl,
      model: this.getModel()
    });

    return this.envClient;
  }

  private getRuntimeConfig(): ReturnType<typeof resolveGrokAppServerRuntimeConfig> {
    if (this.runtimeConfig) {
      return this.runtimeConfig;
    }

    this.runtimeConfig = resolveGrokAppServerRuntimeConfig();
    return this.runtimeConfig;
  }

  private getModel(): string {
    return this.configuredModel ?? this.getRuntimeConfig().model ?? FOCUSED_DIFF_MODEL;
  }

  private async requestFocusedDiffDecision(
    client: XaiClientLike,
    filePath: string | undefined,
    hunks: FocusedDiffHunkSummary[]
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      return await client.createResponse({
        model: this.getModel(),
        promptCacheKey: this.promptVersion,
        headers: {
          "x-grok-conv-id": this.promptVersion
        },
        signal: controller.signal,
        text: {
          format: {
            type: "json_schema",
            name: "focused_diff_hunk_decisions",
            schema: FOCUSED_DIFF_RESPONSE_SCHEMA,
            strict: true
          }
        },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: FOCUSED_DIFF_SYSTEM_PROMPT }]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  filePath,
                  hunks
                })
              }
            ]
          }
        ]
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeFocusedDiffResult(
  response: unknown,
  hunkCount: number
): { decisions: FocusedDiffHunkDecision[]; hiddenHunkIndices: number[] } {
  const rawText = normalizeXaiResponse(response).assistantText;
  if (!rawText) {
    throw new Error("grok returned no structured diff decisions");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `invalid structured diff response: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid structured diff response: decisions payload must be an object");
  }

  const record = parsed as { decisions?: unknown };
  if (!Array.isArray(record.decisions)) {
    throw new Error("invalid structured diff response: decisions must be an array");
  }

  const decisions = createDefaultDecisions(hunkCount);
  for (const item of record.decisions) {
    const normalized = normalizeModelDecision(item, hunkCount);
    if (!normalized) {
      continue;
    }
    decisions[normalized.index] = normalized;
  }

  const hiddenHunkIndices = decisions
    .filter((decision) => decision.disposition === "hide")
    .map((decision) => decision.index);

  return {
    decisions,
    hiddenHunkIndices
  };
}

function normalizeModelDecision(
  value: unknown,
  hunkCount: number
): FocusedDiffHunkDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const index = typeof record.index === "number" ? record.index : Number.NaN;
  if (!Number.isInteger(index) || index < 0 || index >= hunkCount) {
    return null;
  }

  const reasonCode = asFocusedReasonCode(record.reasonCode);
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const confidence = clampConfidence(record.confidence);
  const requestedDisposition = record.disposition === "hide" ? "hide" : "show";
  const canHide =
    requestedDisposition === "hide" &&
    confidence >= MIN_HIDE_CONFIDENCE &&
    HIDEABLE_REASON_CODES.has(reasonCode);

  return {
    index,
    disposition: canHide ? "hide" : "show",
    reasonCode: canHide ? reasonCode : "keep",
    reason: reason || "Keep visible",
    confidence
  };
}

function createDefaultDecisions(hunkCount: number): FocusedDiffHunkDecision[] {
  return Array.from({ length: hunkCount }, (_value, index) => ({
    index,
    disposition: "show",
    reasonCode: "keep",
    reason: "Keep visible",
    confidence: 1
  }));
}

function readFocusedDiffTestOverride(
  hunkCount: number
): FocusedDiffAnalysisResponse | null {
  const rawValue = process.env[FOCUSED_DIFF_TEST_RESPONSE_ENV]?.trim();
  if (!rawValue) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `${FOCUSED_DIFF_TEST_RESPONSE_ENV} must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${FOCUSED_DIFF_TEST_RESPONSE_ENV} must decode to an object`);
  }

  const record = parsed as {
    hiddenHunkIndices?: unknown;
    reason?: unknown;
  };
  const hiddenHunkIndices = Array.isArray(record.hiddenHunkIndices)
    ? record.hiddenHunkIndices.filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value < hunkCount
      )
    : [];
  const hiddenHunkIndexSet = new Set(hiddenHunkIndices);
  const decisions: FocusedDiffHunkDecision[] = createDefaultDecisions(hunkCount).map(
    (decision): FocusedDiffHunkDecision =>
      hiddenHunkIndexSet.has(decision.index)
        ? {
            ...decision,
            disposition: "hide",
            reasonCode: "comment_only",
            reason: "Hidden by focused diff test override",
            confidence: 1
          }
        : decision
  );

  return {
    mode: hiddenHunkIndices.length > 0 ? "focused" : "fallback",
    source: "heuristic",
    hiddenHunkIndices,
    hiddenHunkCount: hiddenHunkIndices.length,
    decisions,
    ...(typeof record.reason === "string" && record.reason.trim()
      ? { reason: record.reason.trim() }
      : {})
  };
}

function buildFocusedDiffCacheKey(
  promptVersion: string,
  filePath: string | undefined,
  diff: string
): string {
  return createHash("sha256")
    .update(promptVersion)
    .update("\u0000")
    .update(filePath ?? "")
    .update("\u0000")
    .update(diff)
    .digest("hex");
}

function asFocusedReasonCode(value: unknown): FocusedDiffReasonCode {
  if (typeof value === "string" && FOCUSED_DIFF_REASON_CODES.includes(value as never)) {
    return value as FocusedDiffReasonCode;
  }

  return "uncertain";
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function readCachedTokenCount(response: unknown): number | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return undefined;
  }

  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }

  const inputTokensDetails = (usage as { input_tokens_details?: unknown }).input_tokens_details;
  if (
    !inputTokensDetails ||
    typeof inputTokensDetails !== "object" ||
    Array.isArray(inputTokensDetails)
  ) {
    return undefined;
  }

  const cachedTokens = (inputTokensDetails as { cached_tokens?: unknown }).cached_tokens;
  return typeof cachedTokens === "number" ? cachedTokens : undefined;
}
