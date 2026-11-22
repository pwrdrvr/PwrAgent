import {
  DECISIONS_OPERATOR_STOP_CODE,
  type DecisionsRailAnswer,
  type DecisionsRailBatch,
  type DecisionsRailDecision,
  type DecisionsRailProvider,
  type DecisionsRailQuestion,
  type DecisionsRailSnapshot,
} from "@pwragent/shared/decisions-rail";
import type { RailChipTone } from "./RailStatusChip";

/** The Decisions tab's words and numbers. Pure, so the node test project covers it. */

const PROVIDER_LABELS: Record<DecisionsRailProvider, string> = {
  openai: "OpenAI",
  jev: "Jev",
  local: "Local model",
};

export function decisionProviderLabel(provider: DecisionsRailProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** The provider's name on its Settings → AI Providers screen. */
export function decisionProviderSettingsName(provider: DecisionsRailProvider): string {
  return provider === "openai"
    ? "OpenAI Decisions"
    : provider === "jev"
      ? "TypeSafe Jev"
      : "Local decision model";
}

/**
 * What a batch card and its dialog call the batch. An ad hoc definition is
 * never stored, so its placeholder name and version mean nothing to the
 * operator: it reads as "Ad hoc" and shows no version.
 */
export function decisionBatchTitle(batch: Pick<DecisionsRailBatch, "adHoc" | "name">): string {
  return batch.adHoc ? "Ad hoc" : batch.name;
}

/** The version tag beside a batch's title, or undefined for an ad hoc batch. */
export function decisionBatchVersionTag(batch: Pick<DecisionsRailBatch, "adHoc" | "version">): string | undefined {
  return batch.adHoc ? undefined : `v${batch.version}`;
}

/** "Asks preferred_caption", "Asks kind, severity". Undefined when the batch did not keep its questions. */
export function decisionBatchAsksLine(batch: Pick<DecisionsRailBatch, "questionNames">): string | undefined {
  const names = batch.questionNames;
  if (!names || names.length === 0) return undefined;
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `Asks ${shown} and ${names.length - 3} more` : `Asks ${shown}`;
}

/** An answer under this probability is drawn as one to check first. */
export const DECISION_LOW_CONFIDENCE = 0.7;

/** 380 ms, 9.2 s, 2m 41s, 1h 4m. */
export function formatDecisionDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const seconds = Math.round(ms / 100) / 10;
    return seconds < 60 ? `${seconds.toFixed(1)} s` : "1m 0s";
  }
  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Items per second: 12/s, 4.0/s, 0.25/s. */
export function formatDecisionRate(perSecond: number): string {
  if (!Number.isFinite(perSecond) || perSecond <= 0) return "—";
  if (perSecond >= 10) return `${Math.round(perSecond)}/s`;
  if (perSecond >= 1) return `${perSecond.toFixed(1)}/s`;
  return `${perSecond.toFixed(2)}/s`;
}

/** 0.93; a probability always shows two places so a column of them lines up. */
export function formatDecisionProbability(probability: number): string {
  return Math.min(1, Math.max(0, probability)).toFixed(2);
}

/** 14:02 today; Nov 18, 14:02 on another day. */
export function formatDecisionClock(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function decisionBatchStatusLabel(batch: Pick<DecisionsRailBatch, "state" | "stopping">): string {
  switch (batch.state) {
    case "queued": return batch.stopping ? "Cancelling" : "Waiting";
    case "running": return batch.stopping ? "Stopping" : "Running";
    case "completed": return "Completed";
    case "stopped": return "Stopped";
    case "cancelled": return "Cancelled";
  }
}

/** A batch the operator stopped, not one an error stopped. */
export function isOperatorStoppedBatch(batch: Pick<DecisionsRailBatch, "state" | "stoppedBy">): boolean {
  return batch.state === "stopped" && batch.stoppedBy?.code === DECISIONS_OPERATOR_STOP_CODE;
}

export function decisionBatchTone(batch: Pick<DecisionsRailBatch, "state" | "failed" | "stoppedBy">): RailChipTone {
  switch (batch.state) {
    case "queued":
    case "running":
      return "active";
    case "completed":
      return batch.failed > 0 ? "warning" : "ok";
    case "stopped":
      return isOperatorStoppedBatch(batch) ? "neutral" : "error";
    case "cancelled":
      return "neutral";
  }
}

export function isDecisionBatchRunning(batch: Pick<DecisionsRailBatch, "state">): boolean {
  return batch.state === "queued" || batch.state === "running";
}

/**
 * The batch row's timing line. A batch that ran shows when it started, its
 * wall time, throughput and request latency; one that stopped on an error
 * says which error and how far it got, because that is what the operator
 * acts on.
 */
export function decisionBatchTimingLine(batch: DecisionsRailBatch, now: number): string {
  const ran = batch.finished - batch.skipped;
  const started = `started ${formatDecisionClock(batch.startedAt ?? batch.createdAt, now)}`;
  if (batch.state === "queued") {
    return `queued ${formatDecisionClock(batch.createdAt, now)} · waiting for another call on this decision`;
  }
  if (batch.state === "stopped" && batch.stoppedBy && !isOperatorStoppedBatch(batch)) {
    return `${started} · ${batch.stoppedBy.code} after ${ran} ${ran === 1 ? "item" : "items"}`;
  }
  const parts = [started];
  if (batch.wallMs !== undefined) parts.push(formatDecisionDuration(batch.wallMs));
  if (batch.itemsPerSecond !== undefined) parts.push(formatDecisionRate(batch.itemsPerSecond));
  if (batch.latency) {
    parts.push(`mean ${formatDecisionDuration(batch.latency.meanMs)}`);
    parts.push(`max ${formatDecisionDuration(batch.latency.maxMs)}`);
  }
  if (batch.state === "cancelled" && batch.cancelReason) parts.push(batch.cancelReason);
  return parts.join(" · ");
}

/** What a batch row says about its counts, for screen readers. */
export function decisionBatchCountsLabel(batch: Pick<DecisionsRailBatch, "succeeded" | "failed" | "skipped">): string {
  return `${batch.succeeded} succeeded, ${batch.failed} failed, ${batch.skipped} skipped`;
}

/** predicate → yes/no; choice → choice · low · high; score → score · 1 · 2 · 3. */
export function decisionQuestionKind(question: DecisionsRailQuestion): string {
  if (question.type === "predicate") return "yes/no";
  const options = question.type === "choice" ? question.choices : question.levels;
  return [question.type, ...(options ?? [])].join(" · ");
}

/**
 * One line for an input schema: an object's properties, with `[]` after an
 * array property, as `{ title, body, labels[] }`. A schema with no
 * properties reads as the type it takes.
 */
export function decisionInputSchemaSummary(schema: Record<string, unknown>): string {
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const names = Object.entries(properties as Record<string, unknown>).map(([name, value]) => {
      const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
      return type === "array" ? `${name}[]` : name;
    });
    if (names.length > 0) return `{ ${names.join(", ")} }`;
  }
  if (schema.type === "string") return "text";
  if (schema.type === "object") return "any object";
  return "text or any object";
}

/** "2 questions · mean 410 ms over 200 requests". */
export function decisionSummaryLine(decision: DecisionsRailDecision): string {
  const questions = `${decision.questions.length} ${decision.questions.length === 1 ? "question" : "questions"}`;
  if (decision.timing) {
    const requests = `${decision.timing.samples} ${decision.timing.samples === 1 ? "request" : "requests"}`;
    return `${questions} · mean ${formatDecisionDuration(decision.timing.meanMs)} over ${requests}`;
  }
  return `${questions} · no runs since PwrAgent started`;
}

/** "relevant: yes" — the probability renders beside it. */
export function decisionAnswerText(answer: DecisionsRailAnswer): string {
  const label = answer.name ?? answer.type;
  switch (answer.type) {
    case "refusal": return `${label}: refused`;
    case "unavailable": return `${label}: unavailable${answer.reason ? ` (${answer.reason})` : ""}`;
    default: return `${label}: ${answer.value ?? "—"}`;
  }
}

/**
 * How soon the open tab asks again: quickly while a batch can still move,
 * slowly once every batch has ended (a new one can still start).
 */
export function decisionsRailPollDelayMs(snapshot: DecisionsRailSnapshot | undefined): number {
  return snapshot?.batches.some(isDecisionBatchRunning) ? 2_000 : 10_000;
}

/** The tab shows once the thread has a decision it can see or a batch it ran. */
export function decisionsRailHasContent(snapshot: DecisionsRailSnapshot | undefined): boolean {
  return Boolean(snapshot && (snapshot.decisions.length > 0 || snapshot.batches.length > 0));
}
