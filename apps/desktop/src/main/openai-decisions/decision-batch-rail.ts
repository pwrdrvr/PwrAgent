import {
  DECISIONS_RAIL_PAGE_MAX_ITEMS,
  type DecisionsRailAnswer,
  type DecisionsRailBatch,
  type DecisionsRailBatchPage,
  type DecisionsRailItem,
  type DecisionsRailItemFilter,
} from "@pwragent/shared/decisions-rail";
import { isAdHocDecisionId } from "@pwragent/shared/openai-decisions";
import {
  compactBatchItem,
  isFinishedBatch,
  type DecisionBatchItem,
  type DecisionBatchRecord,
} from "./decision-batches";

/**
 * The thread's Decisions tab reads batches through these projections, from
 * memory and from result files alike, so a batch reads the same either
 * way. Nothing here writes anywhere.
 */

/** Item JSON in one Decisions tab page; a page always holds at least one item. */
export const DECISIONS_RAIL_PAGE_MAX_BYTES = 1024 * 1024;

/** A batch without its items, as of `now` on the owner's clock. */
export function railBatch(record: DecisionBatchRecord, now: number): DecisionsRailBatch {
  const finished = record.succeeded + record.failed;
  const ran = finished - record.skipped;
  const done = isFinishedBatch(record);
  const wallMs = record.startedAt === undefined
    ? undefined
    : Math.max(0, (done ? record.finishedAt ?? now : now) - record.startedAt);
  let latencySamples = 0;
  let latencyTotal = 0;
  let latencyMax = 0;
  let model: string | undefined;
  for (const item of record.results) {
    if (!item?.ok) continue;
    model ??= item.model;
    if (!isDuration(item.durationMs)) continue;
    latencySamples += 1;
    latencyTotal += item.durationMs;
    latencyMax = Math.max(latencyMax, item.durationMs);
  }
  return {
    batchId: record.batchId,
    decisionId: record.decisionId,
    name: record.name,
    version: record.version,
    adHoc: isAdHocDecisionId(record.decisionId),
    ...(record.definition
      ? { questionNames: record.definition.questions.map((question) => question.name ?? question.type) }
      : {}),
    provider: record.provider,
    ...(model ? { model } : {}),
    state: record.state,
    stopping: !done && (record.stoppedBy !== undefined || record.controller.signal.aborted),
    background: record.background,
    count: record.count,
    finished,
    succeeded: record.succeeded,
    failed: record.failed - record.skipped,
    skipped: record.skipped,
    concurrency: record.concurrency,
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(done && record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(wallMs !== undefined ? { wallMs } : {}),
    ...(wallMs !== undefined && wallMs > 0 && ran > 0 ? { itemsPerSecond: ran / (wallMs / 1000) } : {}),
    ...(latencySamples > 0
      ? {
          latency: {
            samples: latencySamples,
            meanMs: Math.round(latencyTotal / latencySamples),
            maxMs: Math.round(latencyMax),
          },
        }
      : {}),
    ...(record.stoppedBy ? { stoppedBy: { ...record.stoppedBy } } : {}),
    ...(record.cancelReason ? { cancelReason: record.cancelReason } : {}),
    hasResultsFile: Boolean(record.resultsFile),
  };
}

/**
 * Finished items in input order, from index `from`, that match `status`.
 * "failed" means items that ran and failed; skipped items have their own
 * filter, so each filter's total is the count the tab shows beside it.
 */
export function railBatchPage(
  record: DecisionBatchRecord,
  params: { status: DecisionsRailItemFilter; from: number; limit: number; now: number; maxBytes?: number },
): DecisionsRailBatchPage {
  const limit = Math.min(Math.max(1, Math.floor(params.limit)), DECISIONS_RAIL_PAGE_MAX_ITEMS);
  const maxBytes = params.maxBytes ?? DECISIONS_RAIL_PAGE_MAX_BYTES;
  const items: DecisionsRailItem[] = [];
  let bytes = 0;
  for (let index = Math.max(0, Math.floor(params.from)); index < record.count; index += 1) {
    const item = record.results[index];
    if (!item || !matchesRailFilter(item, params.status)) continue;
    const view = railItem(item);
    const size = Buffer.byteLength(JSON.stringify(view));
    if (items.length >= limit || (items.length > 0 && bytes + size > maxBytes)) {
      return { batch: railBatch(record, params.now), ...definitionField(record), items, nextFrom: index };
    }
    items.push(view);
    bytes += size;
  }
  return { batch: railBatch(record, params.now), ...definitionField(record), items };
}

function definitionField(record: DecisionBatchRecord) {
  return record.definition ? { definition: record.definition } : {};
}

export function matchesRailFilter(item: DecisionBatchItem, status: DecisionsRailItemFilter): boolean {
  switch (status) {
    case "all": return true;
    case "succeeded": return item.ok;
    case "failed": return !item.ok && item.code !== "skipped";
    case "skipped": return !item.ok && item.code === "skipped";
  }
}

export function railItem(item: DecisionBatchItem): DecisionsRailItem {
  const preview = {
    ...(item.inputPreview !== undefined ? { inputPreview: item.inputPreview } : {}),
    ...(item.inputTruncated ? { inputTruncated: true } : {}),
    ...(item.inputRedacted ? { inputRedacted: true } : {}),
    ...(isDuration(item.durationMs) ? { durationMs: Math.round(item.durationMs) } : {}),
  };
  if (!item.ok) return { index: item.index, ok: false, code: item.code, message: item.message, ...preview };
  const compact = compactBatchItem(item);
  const answers = Array.isArray(compact.answers) ? compact.answers.map(railAnswer) : undefined;
  return { index: item.index, ok: true, ...(answers ? { answers } : {}), ...preview };
}

/**
 * One answer as the tab shows it: the value the model leaned to and how
 * likely that value is. A predicate's probability is of "yes", so a
 * predicate under one half reads as "no" with the complement.
 */
export function railAnswer(answer: unknown): DecisionsRailAnswer {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return { type: "other", value: shortJson(answer) };
  }
  const value = answer as Record<string, unknown>;
  const named = typeof value.name === "string" ? { name: value.name } : {};
  switch (value.type) {
    case "predicate": {
      if (!isProbability(value.probability)) return { type: "predicate", ...named };
      const yes = value.probability >= 0.5;
      return {
        type: "predicate",
        ...named,
        value: yes ? "yes" : "no",
        probability: yes ? value.probability : 1 - value.probability,
      };
    }
    case "choice":
      return {
        type: "choice",
        ...named,
        ...(typeof value.choice === "string" ? { value: value.choice } : {}),
        ...(isProbability(value.confidence) ? { probability: value.confidence } : {}),
      };
    case "score":
      return {
        type: "score",
        ...named,
        ...(typeof value.score === "number" && Number.isFinite(value.score)
          ? { value: formatScore(value.score) }
          : typeof value.score === "string" ? { value: value.score } : {}),
        ...(isProbability(value.confidence) ? { probability: value.confidence } : {}),
      };
    case "refusal":
      return { type: "refusal", ...named };
    case "unavailable":
      return { type: "unavailable", ...named, ...(typeof value.reason === "string" ? { reason: value.reason } : {}) };
    default:
      return { type: "other", ...named, value: shortJson(answer) };
  }
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

function shortJson(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
