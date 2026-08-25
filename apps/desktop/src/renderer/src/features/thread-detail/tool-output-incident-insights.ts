import type {
  ThreadTokenMiserInterceptionAccounting,
  ThreadToolInvocationCategory,
  ThreadToolInvocationRecord,
  ThreadToolAccounting,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  isFlaggedToolInvocation,
  TOOL_OUTPUT_CAP_CHARS,
  toolOutputCapShare,
} from "@pwragent/shared";

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
  /** Flagged share of all tool output, 0–1. Zero when nothing is accounted. */
  share: number;
  turnCount: number;
  worstChars: number;
};

export type TokenMiserContextComparison = {
  actualParentTokens: number;
  avoidedParentTokens: number;
  withoutTokenMiserTokens: number;
};

export function buildTokenMiserContextComparison(
  invocations: readonly ThreadToolInvocationRecord[],
  tokenMiser: ThreadToolAccounting["tokenMiser"],
): TokenMiserContextComparison | undefined {
  if (!tokenMiser || tokenMiser.interceptionCount === 0) {
    return undefined;
  }
  const interceptedToolUseIds = new Set(
    (tokenMiser.interceptions ?? []).map((entry) => entry.toolUseId),
  );
  const modelVisibleTokens = (invocation: ThreadToolInvocationRecord): number =>
    Math.ceil(Math.min(invocation.outputChars, TOOL_OUTPUT_CAP_CHARS) / 4);
  const accountedTokens = invocations.reduce(
    (total, invocation) => total + modelVisibleTokens(invocation),
    0,
  );
  const accountedGatedTokens = invocations.reduce((total, invocation) => {
    const isGated = Boolean(
      (invocation.itemId && interceptedToolUseIds.has(invocation.itemId))
      || Array.from(interceptedToolUseIds).some((toolUseId) =>
        invocation.invocationId.endsWith(`:${toolUseId}`),
      ),
    );
    return total + (isGated ? modelVisibleTokens(invocation) : 0);
  }, 0);
  const withoutTokenMiserTokens =
    accountedTokens - accountedGatedTokens + tokenMiser.baselineParentTokens;
  return {
    actualParentTokens:
      withoutTokenMiserTokens - tokenMiser.estimatedParentTokensSaved,
    avoidedParentTokens: tokenMiser.estimatedParentTokensSaved,
    withoutTokenMiserTokens,
  };
}

/**
 * A gate that did not pay off, or a payload the gate never really controlled.
 *
 * Aggregate savings hide these: a thread can show a large avoided footprint
 * while individual gates cost more than they saved, hand most of the payload
 * back through retrieval, or summarize the same output several times over.
 */
export type TokenMiserRoughEdge = {
  detail: string;
  key: string;
  kind: "cost" | "leak" | "repeat" | "truncated";
  label: string;
  title: string;
  value: string;
};

const ROUGH_EDGE_ORDER: Record<TokenMiserRoughEdge["kind"], number> = {
  cost: 0,
  leak: 1,
  repeat: 2,
  truncated: 3,
};

export function buildTokenMiserRoughEdges(
  invocations: readonly ThreadToolInvocationRecord[],
  tokenMiser: ThreadToolAccounting["tokenMiser"],
): TokenMiserRoughEdge[] {
  const interceptions = tokenMiser?.interceptions ?? [];
  if (interceptions.length === 0) {
    return [];
  }
  const invocationByToolUseId = new Map<string, ThreadToolInvocationRecord>();
  for (const invocation of invocations) {
    if (invocation.itemId) {
      invocationByToolUseId.set(invocation.itemId, invocation);
    }
  }
  const describe = (toolUseId: string, toolName: string): string =>
    invocationByToolUseId.get(toolUseId)?.normalizedCommand ?? toolName;

  // Only a resolved command identifies a payload. Codex names every shell call
  // `commandExecution`, so grouping on the toolName fallback merged unrelated
  // gates into one bogus repeat finding and downgraded each of them to a miss.
  const groupingKey = (toolUseId: string): string | undefined =>
    invocationByToolUseId.get(toolUseId)?.normalizedCommand;

  // Count gates per command so a payload summarized several times reads as one
  // finding about the repetition rather than N unrelated gates.
  const gatesByCommand = new Map<string, number>();
  for (const entry of interceptions) {
    const key = groupingKey(entry.toolUseId);
    if (key === undefined) {
      continue;
    }
    gatesByCommand.set(key, (gatesByCommand.get(key) ?? 0) + 1);
  }

  const edges: TokenMiserRoughEdge[] = [];
  const reportedRepeats = new Set<string>();
  for (const entry of interceptions) {
    const command = describe(entry.toolUseId, entry.toolName);
    if (entry.estimatedParentTokensSaved <= 0) {
      edges.push({
        detail:
          `A ${formatCompactTokens(entry.baselineParentTokens)} baseline became `
          + `${formatCompactTokens(entry.replacementTokens + entry.retrievedTokens)} of summary and retrieval.`,
        key: entry.objectId,
        kind: "cost",
        label: "Cost more than it saved",
        title: command,
        value: `${formatCompactTokens(Math.abs(entry.estimatedParentTokensSaved))} over`,
      });
      continue;
    }
    if (entry.retrievedTokens > 0 && entry.retrievedTokens * 2 >= entry.baselineParentTokens) {
      edges.push({
        detail:
          `The agent read ${formatCompactTokens(entry.retrievedTokens)} of the `
          + `${formatCompactTokens(entry.baselineParentTokens)} baseline back. The gate still saved `
          + `${formatCompactTokens(entry.estimatedParentTokensSaved)}, but most of the payload reached the parent anyway.`,
        key: entry.objectId,
        kind: "leak",
        label: "Most output retrieved",
        title: command,
        value: `${formatCompactTokens(entry.estimatedParentTokensSaved)} net`,
      });
      continue;
    }
    const repeatKey = groupingKey(entry.toolUseId);
    const gateCount = repeatKey === undefined
      ? 1
      : gatesByCommand.get(repeatKey) ?? 1;
    if (repeatKey !== undefined && gateCount > 1 && !reportedRepeats.has(repeatKey)) {
      reportedRepeats.add(repeatKey);
      edges.push({
        detail:
          `The same output was gated ${gateCount.toLocaleString()} times, so `
          + `${(gateCount - 1).toLocaleString()} extra ${gateCount === 2 ? "summary was" : "summaries were"} written for one payload.`,
        key: `repeat:${command}`,
        kind: "repeat",
        label: `Gated ${gateCount.toLocaleString()}×`,
        title: command,
        value: `${(gateCount - 1).toLocaleString()} redundant`,
      });
      continue;
    }
    // Codex caps tool output before the hook sees it, so a payload far past the
    // cap was never gateable in full — the gate only ever saw the capped head.
    const emitted = invocationByToolUseId.get(entry.toolUseId)?.outputChars ?? 0;
    if (emitted > TOOL_OUTPUT_CAP_CHARS * 2) {
      edges.push({
        detail:
          `The tool emitted ${emitted.toLocaleString()} characters. Codex truncated it to `
          + `${TOOL_OUTPUT_CAP_CHARS.toLocaleString()} before the hook saw it, so only the cap was ever gateable.`,
        key: `truncated:${entry.objectId}`,
        kind: "truncated",
        label: "Truncated upstream",
        title: command,
        value: `${formatCompactTokens(entry.baselineParentTokens)} of ${formatCompactTokens(Math.ceil(emitted / 4))}`,
      });
    }
  }
  return edges.sort((left, right) =>
    ROUGH_EDGE_ORDER[left.kind] - ROUGH_EDGE_ORDER[right.kind]
  );
}

/**
 * Every gate, classified by how it actually turned out.
 *
 * The rough-edges list answered "where did this go wrong", which is only useful
 * once you can also see what went right. Outcome is one axis over the same set,
 * so the operator can move between all / wins / misses instead of seeing only
 * the failures and inferring the rest.
 */
export type TokenMiserGateOutcome = "win" | "miss" | "big-miss";

export type TokenMiserGateEntry = {
  command: string;
  edge?: TokenMiserRoughEdge;
  interception: ThreadTokenMiserInterceptionAccounting;
  outcome: TokenMiserGateOutcome;
};

export function buildTokenMiserGateEntries(
  invocations: readonly ThreadToolInvocationRecord[],
  tokenMiser: ThreadToolAccounting["tokenMiser"],
): TokenMiserGateEntry[] {
  const interceptions = tokenMiser?.interceptions ?? [];
  if (interceptions.length === 0) {
    return [];
  }
  const edgesByKey = new Map<string, TokenMiserRoughEdge>();
  for (const edge of buildTokenMiserRoughEdges(invocations, tokenMiser)) {
    edgesByKey.set(edge.key, edge);
  }
  const invocationByToolUseId = new Map<string, ThreadToolInvocationRecord>();
  for (const invocation of invocations) {
    if (invocation.itemId) {
      invocationByToolUseId.set(invocation.itemId, invocation);
    }
  }
  return interceptions.map((interception) => {
    const command =
      invocationByToolUseId.get(interception.toolUseId)?.normalizedCommand
      ?? interception.toolName;
    // Rough edges are keyed by object id, except the repeat finding which is
    // reported once per command; look for both so a repeated gate still shows
    // its finding on every row it applies to.
    const edge = edgesByKey.get(interception.objectId)
      ?? edgesByKey.get(`repeat:${command}`)
      ?? edgesByKey.get(`truncated:${interception.objectId}`);
    const outcome: TokenMiserGateOutcome =
      interception.estimatedParentTokensSaved <= 0
        ? "big-miss"
        : edge
          ? "miss"
          : "win";
    return {
      command,
      ...(edge ? { edge } : {}),
      interception,
      outcome,
    };
  });
}

export type TurnCostRow = {
  callCount: number;
  /** Billed cost of this turn, when the pricing ledger has priced it. */
  costMicros?: number;
  estimatedOutputTokens: number;
  firstObservedAt: number;
  /** Calls that pass `isFlaggedToolInvocation` — the scope toggle's test. */
  flaggedCallCount: number;
  key: string;
  label: string;
  /** Calls that reached the harness's output cap, where output is truncated. */
  overCapCount: number;
  /** Owning thread for the ledger join; never infer it from a turn id alone. */
  threadId: string;
  turnId?: string;
};

export type TurnStripScope = "all" | "flagged";

export type TurnCostStrip = {
  /** Turns in scope that contain at least one flagged call. */
  flaggedTurnCount: number;
  /**
   * Every turn's label, including turns the row limit dropped. Callers label
   * cases from this rather than from `rows` — a case belonging to a turn that
   * did not make the strip still belongs to a turn.
   */
  labelsByKey: Map<string, string>;
  /** Largest single-turn values in the strip, for scaling both bars. */
  maxCallCount: number;
  maxTokens: number;
  /**
   * "time" reads as a timeline. Past the row limit that stops being legible,
   * so the strip ranks instead and reports what it dropped.
   */
  ordering: "cost" | "time";
  /**
   * What the "cost" ordering actually ranks by, so the header can say it
   * instead of leaving the reader to reverse-engineer the sort. "billed" is
   * ledger money; "estimate" is the two-axis blend of output tokens and
   * round trips, used when nothing is priced.
   */
  rankedBy: "billed" | "estimate";
  rows: TurnCostRow[];
  scope: TurnStripScope;
  /**
   * Every turn with recorded tool calls, in time order and unscoped — the
   * whole thread at a glance. The ranked rows answer "which turns cost the
   * most"; this answers "when", which is where a long poll shows up as a
   * stretch of round-trip spikes with no matching output.
   */
  timeline: TurnCostRow[];
  /** Turns with any recorded tool call — the "all" scope's population. */
  totalTurnCount: number;
  hiddenTurnCount: number;
};

export type CategoryShare = {
  category: RefinedToolCategory | "other";
  estimatedOutputTokens: number;
  label: string;
  /**
   * Categories this entry stands for. One for a named entry; for the folded
   * "Other" entry, every category inside it — which is what lets that entry
   * be a real filter rather than an unreachable remainder.
   */
  members: RefinedToolCategory[];
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

/**
 * Display-level refinements of the persisted category.
 *
 * The stored enum is assigned by pattern-matching the tool name or the
 * command's first token, so every `cat`/`sed` lands in one undifferentiated
 * `file-io` bucket. That bucket was 80% of one thread's entire output, which
 * tells the operator where to look and nothing about what to change. Reading
 * an agent instruction file over and over is a different problem from reading
 * a source file once, and the command text already distinguishes them.
 *
 * Derived rather than persisted so it applies to threads recorded before any
 * of this existed — the same reason the size test is derived.
 */
const AGENT_INSTRUCTION_PATTERN = /\b(?:AGENTS|CLAUDE)\.md\b/i;
const SKILL_FILE_PATTERN = /\bSKILL\.md\b|[/\\]skills?[/\\]|[/\\]plugins[/\\]/i;

/** Shell wrappers whose payload is the command we actually care about. */
const SHELL_WRAPPER_PATTERN =
  /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|k)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/i;

/**
 * Command verbs we can categorize, and what they mean. Scanned across the
 * whole command rather than read off its first token.
 */
const VERB_CATEGORIES = new Map<string, ThreadToolInvocationCategory>([
  ["git", "git"],
  ["cat", "file-io"], ["head", "file-io"], ["tail", "file-io"],
  ["sed", "file-io"], ["awk", "file-io"], ["ls", "file-io"], ["wc", "file-io"],
  ["rg", "search"], ["grep", "search"], ["find", "search"], ["fd", "search"],
  ["npm", "package-manager"], ["pnpm", "package-manager"],
  ["yarn", "package-manager"], ["bun", "package-manager"],
  ["npx", "package-manager"],
  ["sleep", "polling"],
]);

export type RefinedToolCategory =
  | ThreadToolInvocationCategory
  | "agent-instructions"
  | "skill-files"
  | `mcp:${string}`;

export function unwrapShellCommand(command: string): string {
  const match = SHELL_WRAPPER_PATTERN.exec(command.trim());
  return match?.[2]?.trim() ?? command;
}

/**
 * The one category every verb in the command agrees on, or undefined when
 * they disagree or none is recognized.
 *
 * Reading the first token alone gets a compound command wrong twice over: a
 * `/bin/bash -c '…'` wrapper reports the shell rather than what it ran, and a
 * script that is four `git` invocations in a row is plainly git work. Real
 * example from a 236-turn thread: `/bin/bash -c 'git diff --check git diff
 * --stat git status --short --branch git diff -- …'` was filed under
 * "Tests & builds", because the substring " test" appeared in a path.
 */
function unanimousVerbCategory(
  command: string,
): ThreadToolInvocationCategory | undefined {
  const found = new Set<ThreadToolInvocationCategory>();
  for (const token of command.split(/[\s;|&()]+/)) {
    const category = VERB_CATEGORIES.get(token.toLowerCase());
    if (category) found.add(category);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export function refineToolCategory(
  invocation: Pick<
    ThreadToolInvocationRecord,
    "category" | "normalizedCommand" | "toolName"
  >,
): RefinedToolCategory {
  const raw = invocation.normalizedCommand ?? invocation.toolName;
  /* MCP identities are persisted as `server/tool`, so the split into a
     per-server subcategory is a prefix read — each MCP answers for its own
     output rather than pooling under one bucket. */
  if (invocation.category === "mcp") {
    const server = raw.includes("/") ? raw.split("/", 1)[0] : undefined;
    return server ? `mcp:${server}` : "mcp";
  }
  const command = unwrapShellCommand(raw);
  /* Only second-guess the persisted category when it is untrustworthy: either
     it was computed from a shell wrapper we have now seen through, or it is
     one of the buckets that means "no pattern matched". `pnpm test` stays
     Tests & builds — the verb scan is a fallback, not a better classifier. */
  const persistedIsWeak =
    command !== raw.trim()
    || invocation.category === "shell"
    || invocation.category === "unknown";
  const category = (persistedIsWeak ? unanimousVerbCategory(command) : undefined)
    ?? invocation.category;
  /* Only a read gets refined by what it read. `git diff -- …/SKILL.md` is git
     work that happens to touch a skill file, not a skill read. */
  if (category !== "file-io" && category !== "search") return category;
  if (AGENT_INSTRUCTION_PATTERN.test(command)) return "agent-instructions";
  if (SKILL_FILE_PATTERN.test(command)) return "skill-files";
  return category;
}

export function formatCategoryLabel(
  category: RefinedToolCategory | "other",
): string {
  if (category === "other") return "Other";
  if (category === "agent-instructions") return "Agent instructions";
  if (category === "skill-files") return "Skill files";
  if (category.startsWith("mcp:")) return `MCP · ${category.slice(4)}`;
  return CATEGORY_LABELS[category as ThreadToolInvocationCategory];
}

/**
 * Commands this thread ran more than once. Re-running the identical read is a
 * signal in its own right: either the turn lost the earlier result to
 * compaction, or the file is being rewritten underneath it. Both are causes
 * of cost rather than symptoms of it, and neither is visible from any single
 * row's size.
 */
export function countRepeatedCommands(
  invocations: readonly ThreadToolInvocationRecord[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const invocation of invocations) {
    const command = invocation.normalizedCommand;
    if (!command) continue;
    counts.set(command, (counts.get(command) ?? 0) + 1);
  }
  for (const [command, count] of counts) {
    if (count < 2) counts.delete(command);
  }
  return counts;
}

export function repeatCountFor(
  invocation: Pick<ThreadToolInvocationRecord, "normalizedCommand">,
  repeats: Map<string, number>,
): number {
  return invocation.normalizedCommand
    ? repeats.get(invocation.normalizedCommand) ?? 1
    : 1;
}

export function summarizeIncidents(
  invocations: ThreadToolInvocationRecord[],
  options?: { largeOutputThresholdChars?: number },
): IncidentSummary {
  const flagged = invocations.filter((invocation) =>
    isFlaggedToolInvocation(invocation, options?.largeOutputThresholdChars)
  );
  const turnKeys = new Set(flagged.map((invocation) => invocation.turnId ?? ""));
  const totalTokens = sumTokens(invocations);
  const incidentTokens = sumTokens(flagged);
  return {
    caseCount: flagged.length,
    incidentChars: flagged.reduce((sum, entry) => sum + entry.outputChars, 0),
    incidentTokens,
    share: totalTokens > 0 ? incidentTokens / totalTokens : 0,
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
  options?: {
    largeOutputThresholdChars?: number;
    limit?: number;
    scope?: TurnStripScope;
    usageLines?: readonly ThreadUsageLineRecord[];
  },
): TurnCostStrip {
  const limit = options?.limit ?? DEFAULT_TURN_ROW_LIMIT;
  const scope = options?.scope ?? "flagged";
  /* Billed cost per thread and turn. The ledger is the authority on money;
     the token bar is an estimate from character counts, so the two are
     reported side by side rather than one derived from the other. A turn id
     alone is not a safe join key: child threads and other backends can emit
     short, repeated ids such as "turn-1". */
  const costByThread = new Map<string, Map<string, number>>();
  for (const line of options?.usageLines ?? []) {
    if (!line.turnId) continue;
    const byTurn = costByThread.get(line.threadId) ?? new Map<string, number>();
    byTurn.set(
      line.turnId,
      (byTurn.get(line.turnId) ?? 0) + line.totalCostMicros,
    );
    costByThread.set(line.threadId, byTurn);
  }
  const groups = new Map<string, TurnCostRow>();
  for (const invocation of invocations) {
    const key = invocation.turnId ?? "";
    const row = groups.get(key) ?? {
      callCount: 0,
      estimatedOutputTokens: 0,
      firstObservedAt: invocation.observedAt,
      flaggedCallCount: 0,
      key,
      label: "",
      overCapCount: 0,
      threadId: invocation.threadId,
      ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    };
    row.callCount += 1;
    row.estimatedOutputTokens += invocation.estimatedOutputTokens;
    row.firstObservedAt = Math.min(row.firstObservedAt, invocation.observedAt);
    if (
      isFlaggedToolInvocation(
        invocation,
        options?.largeOutputThresholdChars,
      )
    ) {
      row.flaggedCallCount += 1;
    }
    if (isOverOutputCap(invocation.outputChars)) row.overCapCount += 1;
    groups.set(key, row);
  }

  for (const row of groups.values()) {
    const cost = row.turnId
      ? costByThread.get(row.threadId)?.get(row.turnId)
      : undefined;
    if (cost !== undefined) row.costMicros = cost;
  }

  /* Ordinals come from time order across all turns, so "Turn 3" keeps meaning
     the third turn even when the strip is ranked by cost or truncated. */
  const chronological = [...groups.values()]
    .sort((left, right) => left.firstObservedAt - right.firstObservedAt);
  let ordinal = 0;
  for (const row of chronological) {
    row.label = row.turnId ? `Turn ${(ordinal += 1)}` : "Unassigned";
  }

  /* Ordinals are assigned before scoping, so "Turn 92" names the same turn
     in both scopes and in the case list. */
  const scoped = scope === "flagged"
    ? chronological.filter((row) => row.flaggedCallCount > 0)
    : chronological;

  const ordering: TurnCostStrip["ordering"] = scoped.length > limit
    ? "cost"
    : "time";
  /* Billed money outranks any estimate: when the ledger has priced these
     turns, "costliest" means dollars, full stop — an invented blend next to a
     visible price column reads as a sort nobody can name. The blend remains
     only for unpriced threads, where it still beats tokens alone (which would
     cut the 80-call polling turn the tick rail exists to show). */
  const rankedBy: TurnCostStrip["rankedBy"] = scoped.some(
    (row) => row.costMicros !== undefined,
  )
    ? "billed"
    : "estimate";
  const scale = {
    calls: scoped.reduce((max, row) => Math.max(max, row.callCount), 0),
    tokens: scoped.reduce(
      (max, row) => Math.max(max, row.estimatedOutputTokens),
      0,
    ),
  };
  const score = (row: TurnCostRow): number =>
    (scale.tokens > 0 ? row.estimatedOutputTokens / scale.tokens : 0)
    + (scale.calls > 0 ? row.callCount / scale.calls : 0);
  const ordered = ordering === "cost"
    ? [...scoped].sort((left, right) =>
        (rankedBy === "billed"
          ? (right.costMicros ?? -1) - (left.costMicros ?? -1)
          : 0)
        || score(right) - score(left)
        || right.estimatedOutputTokens - left.estimatedOutputTokens
        || right.callCount - left.callCount)
    : scoped;
  const rows = ordered.slice(0, limit);
  return {
    flaggedTurnCount: chronological
      .filter((row) => row.flaggedCallCount > 0).length,
    hiddenTurnCount: scoped.length - rows.length,
    labelsByKey: new Map(chronological.map((row) => [row.key, row.label])),
    maxCallCount: rows.reduce((max, row) => Math.max(max, row.callCount), 0),
    maxTokens: rows.reduce((max, row) => Math.max(max, row.estimatedOutputTokens), 0),
    ordering,
    rankedBy,
    rows,
    scope,
    timeline: chronological,
    totalTurnCount: chronological.length,
  };
}

export function buildCategoryComposition(
  invocations: ThreadToolInvocationRecord[],
  options?: { limit?: number },
): CategoryShare[] {
  const limit = options?.limit ?? DEFAULT_CATEGORY_LIMIT;
  const groups = new Map<RefinedToolCategory, CategoryShare>();
  for (const invocation of invocations) {
    const category = refineToolCategory(invocation);
    const share = groups.get(category) ?? {
      category,
      estimatedOutputTokens: 0,
      label: formatCategoryLabel(category),
      members: [category],
      share: 0,
    };
    share.estimatedOutputTokens += invocation.estimatedOutputTokens;
    groups.set(category, share);
  }

  const total = sumTokens(invocations);
  const ranked = [...groups.values()]
    .sort((left, right) => right.estimatedOutputTokens - left.estimatedOutputTokens);
  const head = ranked.slice(0, limit);
  const tail = ranked.slice(limit);
  if (tail.length === 1 && tail[0]) {
    /* "Other (1)" hides a real name behind a label that says less than the
       name did — a single MCP bucket read as an unexplained remainder. */
    head.push(tail[0]);
  } else if (tail.length > 1) {
    head.push({
      category: "other",
      estimatedOutputTokens: sumEntries(tail),
      label: `Other (${tail.length})`,
      members: tail.map((entry) => entry.category as RefinedToolCategory),
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

function capShare(outputChars: number): number {
  return toolOutputCapShare(outputChars);
}

/**
 * Success coloring is reserved for a call that actually succeeded. A non-zero
 * exit is a failure whatever the transport status says, and cancelled or still
 * running is neither — those stay neutral rather than borrowing green.
 */
export function invocationStatusTone(
  invocation: ThreadToolInvocationRecord,
): "error" | "ok" | undefined {
  if (invocation.status === "failed") return "error";
  if (invocation.status !== "completed") return undefined;
  if (invocation.exitCode !== undefined && invocation.exitCode !== 0) return "error";
  return "ok";
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

/**
 * Money, always to the penny.
 *
 * This renders a column, and a column of "$3.5" over "$8.38" puts the decimal
 * point in a different place on every row — the eye cannot compare magnitudes
 * without re-reading each number. Fixed two places keeps the point in one
 * column, which is why spreadsheets do it. Sub-cent amounts round to $0.00
 * rather than growing a third place and breaking the same alignment.
 */
export function formatMicrosCurrency(
  micros: number,
  currency: string | undefined,
): string {
  const value = (micros / 1_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
  if (!currency || currency === "USD") return `$${value}`;
  if (currency.toLowerCase().includes("credit")) return `${value} cr`;
  return `${value} ${currency}`;
}

export function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) return tokens.toLocaleString();
  const thousands = tokens / 1_000;
  return `${(thousands >= 100
    ? Math.round(thousands)
    : Number(thousands.toFixed(1))
  ).toLocaleString()}k`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * When a turn ran, at the precision that distinguishes it from its neighbours.
 *
 * A bare clock time is ambiguous the moment a thread spans midnight, and these
 * threads run for days — two rows both reading "2:00 PM" are three days apart
 * and the strip gives no hint of it.
 */
export function formatTurnWhen(timestamp: number, now: number): string {
  const elapsed = now - timestamp;
  if (elapsed < 0) return formatClock(timestamp);
  if (elapsed < HOUR_MS) {
    return `${Math.max(1, Math.round(elapsed / MINUTE_MS))}m ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    const minutes = Math.round((elapsed % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  if (elapsed < 7 * DAY_MS) {
    const day = new Date(timestamp)
      .toLocaleDateString(undefined, { weekday: "short" });
    return `${day} ${formatClock(timestamp)}`;
  }
  const date = new Date(timestamp)
    .toLocaleDateString(undefined, { day: "numeric", month: "numeric" });
  return `${date} ${formatClock(timestamp)}`;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
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
