import type {
  ThreadToolInvocationCategory,
  ThreadToolInvocationRecord,
} from "@pwragent/shared";
import { TOOL_OUTPUT_CAP_CHARS, toolOutputCapShare } from "@pwragent/shared";

/**
 * Derivations behind the incident explorer's visual summary.
 *
 * Two things drive replay cost, and they need separate encodings because they
 * need separate fixes. A turn that returns one enormous tool result is a
 * filtering problem; a turn that makes sixty small calls is a round-trip
 * problem, because every one of those trips replays the whole accumulated
 * context. Reading only one of them — which is all a list of output sizes can
 * show — hides half the bill.
 *
 * Everything here is a pure function over records the accounting analyzer
 * already persists. No new IPC, no new fields.
 */

/** Turn rows shown before the strip switches from timeline to ranking. */
const DEFAULT_TURN_ROW_LIMIT = 12;

/** Distinct legend entries before the tail folds into "Other". */
const DEFAULT_CATEGORY_LIMIT = 4;

/**
 * Characters of command text a case row can show before eliding. Sized to the
 * list's minimum column width, because CSS truncation is an end-truncation —
 * if it ever fires it undoes the middle-elision below.
 */
const DEFAULT_IDENTITY_BUDGET = 38;

/** Longest word-boundary prefix used as the bolded head of a case row. */
const IDENTITY_LEAD_BUDGET = 18;

export type IncidentSummary = {
  caseCount: number;
  incidentChars: number;
  incidentTokens: number;
  /** Estimated tokens across every accounted call, flagged or not. */
  totalTokens: number;
  totalCallCount: number;
  /** Flagged share of all tool output, 0–1. Zero when nothing is accounted. */
  share: number;
  turnCount: number;
  worstChars: number;
};

export type TurnCostRow = {
  callCount: number;
  estimatedOutputTokens: number;
  firstObservedAt: number;
  key: string;
  label: string;
  noisyCount: number;
  /** Calls that reached the harness's output cap, where output is truncated. */
  overCapCount: number;
  outputChars: number;
  turnId?: string;
};

export type TurnCostStrip = {
  /** Largest single-turn values in the strip, for scaling both bars. */
  maxCallCount: number;
  maxTokens: number;
  /**
   * "time" reads as a timeline. Past the row limit that stops being legible,
   * so the strip ranks by cost instead and reports what it dropped.
   */
  ordering: "cost" | "time";
  rows: TurnCostRow[];
  hiddenTurnCount: number;
};

export type CategoryShare = {
  caseCount: number;
  category: ThreadToolInvocationCategory | "other";
  estimatedOutputTokens: number;
  label: string;
  /** Share of flagged output tokens, 0–1. */
  share: number;
};

export type IncidentSortMode = "largest" | "newest" | "turn";

const CATEGORY_LABELS: Record<ThreadToolInvocationCategory, string> = {
  "build-test": "Tests & builds",
  "file-io": "File reads",
  git: "Git",
  mcp: "MCP",
  "package-manager": "Package manager",
  polling: "Polling",
  search: "Search",
  shell: "Shell",
  "sub-agent": "Sub-agents",
  unknown: "Other",
};

export function formatCategoryLabel(
  category: ThreadToolInvocationCategory | "other",
): string {
  return category === "other" ? "Other" : CATEGORY_LABELS[category];
}

export function summarizeIncidents(
  invocations: ThreadToolInvocationRecord[],
): IncidentSummary {
  const flagged = invocations.filter((invocation) => invocation.noisy);
  const turnKeys = new Set(flagged.map((invocation) => invocation.turnId ?? ""));
  const totalTokens = sumTokens(invocations);
  const incidentTokens = sumTokens(flagged);
  return {
    caseCount: flagged.length,
    incidentChars: flagged.reduce((sum, entry) => sum + entry.outputChars, 0),
    incidentTokens,
    share: totalTokens > 0 ? incidentTokens / totalTokens : 0,
    totalCallCount: invocations.length,
    totalTokens,
    turnCount: turnKeys.size,
    worstChars: flagged.reduce((worst, entry) => Math.max(worst, entry.outputChars), 0),
  };
}

/**
 * One row per turn over EVERY accounted call, not just the flagged ones —
 * round trips are the cost being measured here, and a turn's quiet calls
 * replay context exactly like its loud ones do.
 */
export function buildTurnCostStrip(
  invocations: ThreadToolInvocationRecord[],
  options?: { limit?: number },
): TurnCostStrip {
  const limit = options?.limit ?? DEFAULT_TURN_ROW_LIMIT;
  const groups = new Map<string, TurnCostRow>();
  for (const invocation of invocations) {
    const key = invocation.turnId ?? "";
    const row = groups.get(key) ?? {
      callCount: 0,
      estimatedOutputTokens: 0,
      firstObservedAt: invocation.observedAt,
      key,
      label: "",
      noisyCount: 0,
      outputChars: 0,
      overCapCount: 0,
      ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    };
    row.callCount += 1;
    row.estimatedOutputTokens += invocation.estimatedOutputTokens;
    row.outputChars += invocation.outputChars;
    row.firstObservedAt = Math.min(row.firstObservedAt, invocation.observedAt);
    if (invocation.noisy) row.noisyCount += 1;
    if (isOverOutputCap(invocation.outputChars)) row.overCapCount += 1;
    groups.set(key, row);
  }

  /* Ordinals come from time order across all turns, so "Turn 3" keeps meaning
     the third turn even when the strip is ranked by cost or truncated. */
  const chronological = [...groups.values()]
    .sort((left, right) => left.firstObservedAt - right.firstObservedAt);
  let ordinal = 0;
  for (const row of chronological) {
    row.label = row.turnId ? `Turn ${(ordinal += 1)}` : "Unassigned";
  }

  const ordering: TurnCostStrip["ordering"] = chronological.length > limit
    ? "cost"
    : "time";
  const ordered = ordering === "cost"
    ? [...chronological].sort((left, right) =>
        right.estimatedOutputTokens - left.estimatedOutputTokens
        || right.callCount - left.callCount)
    : chronological;
  const rows = ordered.slice(0, limit);
  return {
    hiddenTurnCount: chronological.length - rows.length,
    maxCallCount: rows.reduce((max, row) => Math.max(max, row.callCount), 0),
    maxTokens: rows.reduce((max, row) => Math.max(max, row.estimatedOutputTokens), 0),
    ordering,
    rows,
  };
}

export function buildCategoryComposition(
  invocations: ThreadToolInvocationRecord[],
  options?: { limit?: number },
): CategoryShare[] {
  const limit = options?.limit ?? DEFAULT_CATEGORY_LIMIT;
  const groups = new Map<ThreadToolInvocationCategory, CategoryShare>();
  for (const invocation of invocations) {
    const share = groups.get(invocation.category) ?? {
      caseCount: 0,
      category: invocation.category,
      estimatedOutputTokens: 0,
      label: formatCategoryLabel(invocation.category),
      share: 0,
    };
    share.caseCount += 1;
    share.estimatedOutputTokens += invocation.estimatedOutputTokens;
    groups.set(invocation.category, share);
  }

  const total = sumTokens(invocations);
  const ranked = [...groups.values()]
    .sort((left, right) => right.estimatedOutputTokens - left.estimatedOutputTokens);
  const head = ranked.slice(0, limit);
  const tail = ranked.slice(limit);
  if (tail.length > 0) {
    head.push({
      caseCount: tail.reduce((sum, entry) => sum + entry.caseCount, 0),
      category: "other",
      estimatedOutputTokens: sumEntries(tail),
      label: `Other (${tail.length})`,
      share: 0,
    });
  }
  for (const entry of head) {
    entry.share = total > 0 ? entry.estimatedOutputTokens / total : 0;
  }
  return head;
}

export function sortIncidentCases(
  invocations: ThreadToolInvocationRecord[],
  mode: IncidentSortMode,
): ThreadToolInvocationRecord[] {
  const sorted = [...invocations];
  if (mode === "largest") {
    return sorted.sort((left, right) =>
      right.outputChars - left.outputChars
      || right.observedAt - left.observedAt);
  }
  if (mode === "newest") {
    return sorted.sort((left, right) => right.observedAt - left.observedAt);
  }
  return sorted.sort((left, right) =>
    left.observedAt - right.observedAt
    || right.outputChars - left.outputChars);
}

/**
 * Case-row label. The problem this solves: shell invocations in one turn
 * routinely share a long prefix, so a plain head-truncation renders several
 * rows byte-identical and the list stops being a list. Eliding the middle
 * keeps the part that actually differs — usually a path or a subcommand near
 * the end — on screen.
 */
export function formatInvocationIdentity(
  value: string,
  budget = DEFAULT_IDENTITY_BUDGET,
): { detail: string; lead: string } {
  const flattened = value.replace(/\s+/g, " ").trim();
  const lead = flattened.length <= IDENTITY_LEAD_BUDGET
    ? flattened
    : leadingWords(flattened, IDENTITY_LEAD_BUDGET);
  const detail = flattened.slice(lead.length).trim();
  return { detail: elideMiddle(detail, Math.max(12, budget - lead.length)), lead };
}

/**
 * Longest whole-word prefix within budget, or "" when the first word alone
 * overruns it. Returning a hard slice there would cut a path mid-segment and
 * bold a fragment that is identical across every row in the group — exactly
 * the sameness the elision is meant to break.
 */
function leadingWords(value: string, budget: number): string {
  const boundary = value.lastIndexOf(" ", budget);
  return boundary > 0 ? value.slice(0, boundary) : "";
}

export function capShare(outputChars: number): number {
  return toolOutputCapShare(outputChars);
}

/** Meter width, clamped — a case past the cap pins rather than overflowing. */
export function capMeterWidth(outputChars: number): number {
  return Math.min(1, Math.max(0.02, capShare(outputChars)));
}

export function isOverOutputCap(outputChars: number): boolean {
  return outputChars >= TOOL_OUTPUT_CAP_CHARS;
}

/**
 * The short form is for case rows, where the long phrase would repeat once per
 * row and turn the list back into prose.
 */
export function formatCapShare(
  outputChars: number,
  options?: { short?: boolean },
): string {
  const percentage = Math.max(1, Math.round(capShare(outputChars) * 100));
  return options?.short
    ? `${percentage.toLocaleString()}% of cap`
    : `${percentage.toLocaleString()}% of the output cap`;
}

export function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) return tokens.toLocaleString();
  const thousands = tokens / 1_000;
  return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
}

function elideMiddle(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const head = Math.floor((budget - 1) * 0.42);
  const tail = budget - 1 - head;
  return `${value.slice(0, head).trimEnd()}…${value.slice(value.length - tail).trimStart()}`;
}

function sumTokens(invocations: ThreadToolInvocationRecord[]): number {
  return invocations.reduce((sum, entry) => sum + entry.estimatedOutputTokens, 0);
}

function sumEntries(entries: CategoryShare[]): number {
  return entries.reduce((sum, entry) => sum + entry.estimatedOutputTokens, 0);
}
