import type {
  AppServerBackendKind,
  AppServerThreadReplay,
  ThreadIdentifier,
  ThreadExecutionMode,
} from "./normalized-app-server";
import type {
  InboundPreviewMessage,
  MessagingChannelKind,
  MessagingConversationKind,
} from "./messaging";

export const AUTOMATION_BACKLOG_POLICIES = [
  "coalesce",
  "drop_missed",
] as const;

export type AutomationBacklogPolicy =
  (typeof AUTOMATION_BACKLOG_POLICIES)[number];

export const DEFAULT_AUTOMATION_BACKLOG_POLICY: AutomationBacklogPolicy =
  "coalesce";

/**
 * Default inbound coalescing window. The first matching message fires a run
 * immediately (leading edge); further messages in the same automation within
 * this window are batched into a single follow-up run, bounding the cost of a
 * burst (or a misconfigured firehose / message loop). Set to 0 to disable and
 * fire one run per message.
 */
export const DEFAULT_AUTOMATION_INBOUND_COALESCE_WINDOW_MS = 60_000;

/**
 * Default cap on how many inbound-triggered runs an automation may START per
 * hour. Enforced as a per-automation token bucket (an idle automation may burst
 * up to the rate, then settles to the steady rate). This is a cost backstop
 * against a misconfigured trigger on a busy channel kicking off a flood of
 * ephemeral agent runs. `undefined` inherits this default; `null` is unlimited.
 */
export const DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR = 20;

/** Operator-selectable inbound run-rate options surfaced in the editor. */
export const AUTOMATION_RUN_RATE_PER_HOUR_OPTIONS = [5, 20, 45, 60] as const;

/**
 * Resolve the effective inbound run-rate for an automation: the number of run
 * starts allowed per hour, or `null` for unlimited. `undefined` (field absent /
 * legacy row) falls back to the default; `null` and non-positive / non-finite
 * values are unlimited. A positive fraction clamps UP to 1/hour so a sub-1 rate
 * becomes the most restrictive real cap rather than flooring to 0 (a 0-capacity
 * bucket that would block every run).
 */
export function resolveAutomationRunsPerHour(
  maxRunsPerHour: number | null | undefined,
): number | null {
  if (maxRunsPerHour === null) return null;
  if (maxRunsPerHour === undefined) return DEFAULT_AUTOMATION_MAX_RUNS_PER_HOUR;
  if (!Number.isFinite(maxRunsPerHour) || maxRunsPerHour <= 0) return null;
  return Math.max(1, Math.floor(maxRunsPerHour));
}

export const AUTOMATION_STATUSES = ["enabled", "paused", "deleted"] as const;

export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_RUN_STATUSES = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AUTOMATION_RUN_TRIGGERS = [
  "scheduled",
  "manual",
  "inbound_message",
] as const;

export type AutomationRunTrigger = (typeof AUTOMATION_RUN_TRIGGERS)[number];

export const AUTOMATION_INTERVAL_UNITS = ["minutes", "hours"] as const;

export type AutomationIntervalUnit = (typeof AUTOMATION_INTERVAL_UNITS)[number];

export const AUTOMATION_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type AutomationWeekday = (typeof AUTOMATION_WEEKDAYS)[number];

export type AutomationTimeOfDay = {
  hour: number;
  minute: number;
};

export type AutomationIntervalScheduleDefinition = {
  kind: "interval";
  every: number;
  unit: AutomationIntervalUnit;
  /** Epoch ms used as the recurrence anchor. When omitted, creation time is used. */
  anchorAt?: number;
};

export type AutomationWeeklyScheduleDefinition = {
  kind: "weekly";
  daysOfWeek: AutomationWeekday[];
  timeOfDay: AutomationTimeOfDay;
};

export type AutomationWeekdaysScheduleDefinition = {
  kind: "weekdays";
  timeOfDay: AutomationTimeOfDay;
};

export type AutomationScheduleDefinition =
  | AutomationIntervalScheduleDefinition
  | AutomationWeeklyScheduleDefinition
  | AutomationWeekdaysScheduleDefinition;

/**
 * Every schedule discriminant this build understands. Used by the desktop
 * automation store to recognize — and safely skip — automation rows whose
 * persisted schedule shape this version can't parse (e.g. a row written by a
 * newer build that introduced a new schedule/trigger kind). Keep this in sync
 * with the `AutomationScheduleDefinition` union and the
 * `computeNextAutomationRunAt` switch.
 */
export const AUTOMATION_SCHEDULE_KINDS = [
  "interval",
  "weekly",
  "weekdays",
] as const;
export type AutomationScheduleKind = (typeof AUTOMATION_SCHEDULE_KINDS)[number];

export type AutomationScheduleTriggerDefinition = {
  id: string;
  kind: "schedule";
  schedule: AutomationScheduleDefinition;
};

export const AUTOMATION_INBOUND_TEXT_MATCH_MODES = [
  "contains",
  "equals",
] as const;

export type AutomationInboundTextMatchMode =
  (typeof AUTOMATION_INBOUND_TEXT_MATCH_MODES)[number];

export type AutomationInboundTextFilter = {
  mode: AutomationInboundTextMatchMode;
  text: string;
  caseSensitive?: boolean;
};

export type AutomationInboundSenderFilter = {
  platformUserId?: string;
  isBot?: boolean;
};

/**
 * Fields an inbound condition can test. Deliberately small: the operator set
 * (including negations and multi-value membership) carries the expressiveness,
 * so operators can grow without widening what a condition reaches into.
 */
export const AUTOMATION_INBOUND_CONDITION_FIELDS = [
  "message_text",
  "sender",
  "sender_type",
] as const;

export type AutomationInboundConditionField =
  (typeof AUTOMATION_INBOUND_CONDITION_FIELDS)[number];

/**
 * Condition operators. Each negating operator is its own discriminant rather
 * than a `negate: true` flag so a stored condition reads the same way the
 * editor renders it, and so an unknown operator from a newer build is skipped
 * as a unit instead of silently inverting.
 */
export const AUTOMATION_INBOUND_CONDITION_OPERATORS = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "starts_with",
  "not_starts_with",
  "matches_regex",
  "not_matches_regex",
  "is_one_of",
  "is_not_one_of",
] as const;

export type AutomationInboundConditionOperator =
  (typeof AUTOMATION_INBOUND_CONDITION_OPERATORS)[number];

/**
 * Operators whose result is the boolean inverse of their positive twin. Kept as
 * a map (rather than a name-prefix test) so the matcher never infers semantics
 * from string shape.
 */
export const AUTOMATION_INBOUND_CONDITION_NEGATIONS: Readonly<
  Record<AutomationInboundConditionOperator, AutomationInboundConditionOperator>
> = {
  contains: "not_contains",
  not_contains: "contains",
  equals: "not_equals",
  not_equals: "equals",
  starts_with: "not_starts_with",
  not_starts_with: "starts_with",
  matches_regex: "not_matches_regex",
  not_matches_regex: "matches_regex",
  is_one_of: "is_not_one_of",
  is_not_one_of: "is_one_of",
};

export function isNegatedAutomationInboundConditionOperator(
  operator: AutomationInboundConditionOperator,
): boolean {
  return (
    operator === "not_contains"
    || operator === "not_equals"
    || operator === "not_starts_with"
    || operator === "not_matches_regex"
    || operator === "is_not_one_of"
  );
}

/**
 * One row in the filter list. `values` is always an array so single-value and
 * membership operators share a shape; single-value operators read `values[0]`.
 */
export type AutomationInboundCondition = {
  id: string;
  field: AutomationInboundConditionField;
  operator: AutomationInboundConditionOperator;
  values: string[];
  caseSensitive?: boolean;
  /**
   * Display names for opaque platform values, keyed by value — "U041ZGYG07Q"
   * → "datadog". Pure presentation metadata captured at selection time (the
   * same snapshot-at-selection pattern conversation titles use): the matcher
   * never reads it, and a missing entry just renders the raw id. Without it,
   * reopening the editor or reading the list screen shows ids nobody can
   * recognize.
   */
  valueLabels?: Record<string, string>;
};

/** How the condition rows combine. Flat by design — there is no nesting. */
export const AUTOMATION_INBOUND_CONDITION_JOINS = ["all", "any"] as const;

export type AutomationInboundConditionJoin =
  (typeof AUTOMATION_INBOUND_CONDITION_JOINS)[number];

export type AutomationInboundConditionGroup = {
  join: AutomationInboundConditionJoin;
  conditions: AutomationInboundCondition[];
};

export type AutomationMessagingConversationSnapshot = {
  channel: MessagingChannelKind;
  conversationId: string;
  conversationKind?: MessagingConversationKind;
  parentId?: string;
  title?: string;
  parentTitle?: string;
  ancestorTitle?: string;
};

export type AutomationInboundMessageTriggerDefinition = {
  id: string;
  kind: "inbound_message";
  name?: string;
  conversation: AutomationMessagingConversationSnapshot;
  /**
   * Canonical filter shape. When present it is authoritative and the legacy
   * `sender` / `textFilter` fields below are ignored by the matcher.
   */
  conditionGroup?: AutomationInboundConditionGroup;
  /**
   * @deprecated Superseded by {@link conditionGroup}. Still read so automations
   * written by older builds keep matching; `normalizeInboundTriggerConditions`
   * converts them forward. Retained on disk rather than rewritten in place so a
   * downgrade to a prior build does not silently lose the operator's filter.
   */
  sender?: AutomationInboundSenderFilter;
  /** @deprecated Superseded by {@link conditionGroup}. See `sender`. */
  textFilter?: AutomationInboundTextFilter;
  includeThreadReplies?: boolean;
};

/** The parts of a message a condition can be evaluated against. */
export type AutomationInboundConditionSubject = {
  text: string;
  platformUserId: string;
  isBot?: boolean;
};

/**
 * Evaluate a condition group against one message.
 *
 * This lives in shared, and is the ONLY implementation, because two callers
 * must agree exactly: the main-process matcher that decides whether to start a
 * run, and the editor's live preview that tells the operator which messages
 * would match. A preview that disagrees with the matcher is worse than no
 * preview — it teaches the operator a filter they do not have.
 *
 * An empty condition list matches everything: an inbound trigger with no
 * filters has always meant "every message in this conversation". Note that
 * holds for `any` too — an `any` over zero rows must not become "reject all".
 */
export function evaluateAutomationInboundConditions(
  group: AutomationInboundConditionGroup,
  subject: AutomationInboundConditionSubject,
): boolean {
  if (group.conditions.length === 0) return true;
  const test = (condition: AutomationInboundCondition): boolean =>
    evaluateAutomationInboundCondition(condition, subject);
  return group.join === "any"
    ? group.conditions.some(test)
    : group.conditions.every(test);
}

/**
 * A condition that cannot be evaluated is inert: it matches in NEITHER sense.
 *
 * Emptiness and unknown fields are resolved before negation for that reason.
 * Returning "unsatisfied" and letting negation invert it would turn a
 * half-written `does not contain ""` row — or any negated field a newer build
 * introduced — into a filter matching every message in the conversation, which
 * is the loudest possible failure mode.
 */
export function evaluateAutomationInboundCondition(
  condition: AutomationInboundCondition,
  subject: AutomationInboundConditionSubject,
): boolean {
  const values = condition.values.filter((value) => value.length > 0);
  if (values.length === 0) return false;
  if (!AUTOMATION_INBOUND_CONDITION_FIELDS.includes(condition.field)) return false;

  const satisfied = evaluateConditionSubject(condition, values, subject);
  return isNegatedAutomationInboundConditionOperator(condition.operator)
    ? !satisfied
    : satisfied;
}

function evaluateConditionSubject(
  condition: AutomationInboundCondition,
  values: string[],
  subject: AutomationInboundConditionSubject,
): boolean {
  switch (condition.field) {
    case "message_text":
      return values.some((value) => matchesConditionText(subject.text, value, condition));
    case "sender":
      return values.some((value) => value === subject.platformUserId);
    case "sender_type": {
      const actual = subject.isBot ? "bot" : "human";
      return values.some((value) => value === actual);
    }
    default:
      return false;
  }
}

/**
 * Longest regex pattern accepted from an operator. Long patterns are where
 * catastrophic constructs hide, and no realistic message filter needs more.
 */
export const AUTOMATION_CONDITION_MAX_REGEX_LENGTH = 200;

/**
 * Longest message text a regex is evaluated against. Backtracking cost grows
 * with input length, so the text is truncated before matching. This is well
 * above any realistic alert line, and `contains` / `equals` are unaffected.
 */
export const AUTOMATION_CONDITION_MAX_REGEX_INPUT = 4_000;

/**
 * Conservative catastrophic-backtracking check: a quantified group that itself
 * contains a quantifier (`(a+)+`, `(a*)*`, `(a|a)+`), which is the shape behind
 * essentially every practical ReDoS.
 *
 * This is a mitigation, not a proof — JavaScript has no interruptible regex
 * engine, so a linear-time guarantee would mean an RE2-class dependency. It
 * exists because the PATTERN is operator-authored but the TEXT arrives from a
 * messaging platform and is treated as hostile; a sloppy pattern plus crafted
 * text would otherwise stall the main process on the inbound hot path.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*}][^)]*\)\s*[+*]|\([^)]*[+*}][^)]*\)\s*\{\d/;

export function isSafeAutomationConditionRegex(pattern: string): boolean {
  if (pattern.length === 0) return false;
  if (pattern.length > AUTOMATION_CONDITION_MAX_REGEX_LENGTH) return false;
  if (NESTED_QUANTIFIER.test(pattern)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function matchesConditionText(
  text: string,
  value: string,
  condition: AutomationInboundCondition,
): boolean {
  if (
    condition.operator === "matches_regex"
    || condition.operator === "not_matches_regex"
  ) {
    // A pattern that cannot compile, is over-long, or carries a catastrophic
    // construct simply does not match, rather than breaking inbound matching
    // for every other automation.
    if (!isSafeAutomationConditionRegex(value)) return false;
    try {
      return new RegExp(value, condition.caseSensitive ? "" : "i").test(
        text.slice(0, AUTOMATION_CONDITION_MAX_REGEX_INPUT),
      );
    } catch {
      return false;
    }
  }
  const left = condition.caseSensitive ? text : text.toLowerCase();
  const right = condition.caseSensitive ? value : value.toLowerCase();
  switch (condition.operator) {
    case "equals":
    case "not_equals":
      return left === right;
    case "starts_with":
    case "not_starts_with":
      return left.startsWith(right);
    case "contains":
    case "not_contains":
      return left.includes(right);
    // Membership operators are offered for senders, not text. If one reaches
    // here from stored data, "the text is one of these values" is equality
    // across the value list — the caller already maps over `values`. Spelled
    // out rather than left to a default branch, so the semantics are reviewed
    // rather than inherited.
    case "is_one_of":
    case "is_not_one_of":
      return left === right;
    default:
      return false;
  }
}

/**
 * Structural check for a persisted condition group. The desktop store runs this
 * before writing so a group this build cannot evaluate never reaches disk, and
 * so a group written by a newer build is recognized as unparseable rather than
 * half-applied.
 */
export function isSupportedAutomationInboundConditionGroup(
  group: AutomationInboundConditionGroup | undefined,
): boolean {
  if (!group || typeof group !== "object") return false;
  if (!AUTOMATION_INBOUND_CONDITION_JOINS.includes(group.join)) return false;
  if (!Array.isArray(group.conditions)) return false;
  return group.conditions.every(
    (condition) =>
      Boolean(condition)
      && typeof condition === "object"
      && typeof condition.id === "string"
      && condition.id.length > 0
      && AUTOMATION_INBOUND_CONDITION_FIELDS.includes(condition.field)
      && AUTOMATION_INBOUND_CONDITION_OPERATORS.includes(condition.operator)
      && Array.isArray(condition.values)
      && condition.values.every((value) => typeof value === "string")
      && (condition.valueLabels === undefined
        || (typeof condition.valueLabels === "object"
          && condition.valueLabels !== null
          && Object.values(condition.valueLabels).every(
            (label) => typeof label === "string",
          ))),
  );
}

const AUTOMATION_INBOUND_CONDITION_OPERATOR_LABELS: Readonly<
  Record<AutomationInboundConditionOperator, string>
> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "equals",
  not_equals: "does not equal",
  starts_with: "starts with",
  not_starts_with: "does not start with",
  matches_regex: "matches",
  not_matches_regex: "does not match",
  is_one_of: "is",
  is_not_one_of: "is not",
};

const AUTOMATION_INBOUND_CONDITION_FIELD_LABELS: Readonly<
  Record<AutomationInboundConditionField, string>
> = {
  message_text: "text",
  sender: "sender",
  sender_type: "sender",
};

export function formatAutomationInboundConditionOperator(
  operator: AutomationInboundConditionOperator,
): string {
  return AUTOMATION_INBOUND_CONDITION_OPERATOR_LABELS[operator] ?? operator;
}

export function formatAutomationInboundConditionField(
  field: AutomationInboundConditionField,
): string {
  return AUTOMATION_INBOUND_CONDITION_FIELD_LABELS[field] ?? field;
}

/**
 * Render a condition group as a sentence, e.g.
 * `text contains "ERROR" and text does not contain "staging"`.
 *
 * Lives in shared (not the renderer) so the editor's summary line and any
 * main-process surface that explains why an automation fired stay worded
 * identically. `resolveLabel` lets the caller substitute a display name for an
 * opaque platform id — the editor knows PagerDuty, the store only knows B04KM21.
 */
export function formatAutomationInboundConditionGroup(
  group: AutomationInboundConditionGroup,
  options: { resolveLabel?: (value: string, condition: AutomationInboundCondition) => string } = {},
): string {
  const parts = group.conditions
    .map((condition) => {
      const values = condition.values.filter((value) => value.length > 0);
      if (values.length === 0) return undefined;
      const rendered = values.map((value) => {
        if (options.resolveLabel) return options.resolveLabel(value, condition);
        // Sender values are opaque platform ids; the stored display name (or
        // the raw id, unquoted) reads better than a quoted id. Text values
        // keep their quotes so literal match strings stay visually distinct.
        if (condition.field === "sender" || condition.field === "sender_type") {
          return condition.valueLabels?.[value] ?? value;
        }
        return `"${value}"`;
      });
      const joined =
        rendered.length === 1
          ? rendered[0]
          : `${rendered.slice(0, -1).join(", ")} or ${rendered[rendered.length - 1]}`;
      return `${formatAutomationInboundConditionField(condition.field)} ${formatAutomationInboundConditionOperator(condition.operator)} ${joined}`;
    })
    .filter((part): part is string => part !== undefined);

  if (parts.length === 0) return "every message in the conversation";
  return parts.join(group.join === "any" ? " or " : " and ");
}

/**
 * Resolve a trigger's effective filter, converting the legacy
 * `sender` / `textFilter` pair into the condition shape when no
 * `conditionGroup` is stored.
 *
 * Legacy semantics were a strict AND across every populated field, so the
 * converted group always joins with `all`. An empty result means "no filtering"
 * — every message in the conversation matches, which is what an inbound trigger
 * with no filters has always meant.
 */
export function normalizeInboundTriggerConditions(
  trigger: Pick<
    AutomationInboundMessageTriggerDefinition,
    "conditionGroup" | "sender" | "textFilter"
  >,
): AutomationInboundConditionGroup {
  if (trigger.conditionGroup) return trigger.conditionGroup;

  const conditions: AutomationInboundCondition[] = [];
  if (trigger.sender?.platformUserId) {
    conditions.push({
      id: "legacy-sender",
      field: "sender",
      operator: "is_one_of",
      values: [trigger.sender.platformUserId],
    });
  }
  if (trigger.sender?.isBot !== undefined) {
    conditions.push({
      id: "legacy-sender-type",
      field: "sender_type",
      operator: "is_one_of",
      values: [trigger.sender.isBot ? "bot" : "human"],
    });
  }
  // Gate on the filter's PRESENCE, not on its text. A legacy trigger holding
  // `textFilter: { text: "" }` matched nothing under the old matcher
  // (`if (!filter?.text) return false`). Skipping it here would leave an empty
  // condition list, which matches EVERY message — inverting "never fires" into
  // "fires on everything". Emitting the row with an empty value keeps it inert,
  // which reproduces the old semantics exactly.
  if (trigger.textFilter) {
    conditions.push({
      id: "legacy-text",
      field: "message_text",
      operator: trigger.textFilter.mode === "equals" ? "equals" : "contains",
      values: [trigger.textFilter.text],
      ...(trigger.textFilter.caseSensitive ? { caseSensitive: true } : {}),
    });
  }
  return { join: "all", conditions };
}

export type AutomationTriggerDefinition =
  | AutomationScheduleTriggerDefinition
  | AutomationInboundMessageTriggerDefinition;

export type AutomationRunSourceActorSnapshot = {
  platformUserId: string;
  displayName?: string;
  username?: string;
  isBot?: boolean;
};

export type AutomationRunSourceMessage = {
  text?: string;
  textTruncated?: boolean;
};

export type AutomationRunSourceMetadata = {
  kind: "messaging";
  eventId?: string;
  sourceEventKey: string;
  receivedAt: number;
  matchedTriggerId: string;
  matchedTriggerName?: string;
  actor: AutomationRunSourceActorSnapshot;
  conversation: AutomationMessagingConversationSnapshot;
  message?: AutomationRunSourceMessage;
  routingState?: Record<string, unknown>;
  /**
   * Additional messages coalesced into this run within the inbound coalescing
   * window. The primary fields above describe the first message; these are the
   * follow-ups, bounded in count and size.
   */
  batchedEvents?: AutomationRunSourceBatchedEntry[];
};

export type AutomationRunSourceBatchedEntry = {
  sourceEventKey: string;
  receivedAt: number;
  actor: AutomationRunSourceActorSnapshot;
  message?: AutomationRunSourceMessage;
};

/**
 * Bounds on how much of an automation's own history a new run may see.
 *
 * Each run is an ephemeral sub-agent that starts from the prompt every time,
 * so without this it has no memory: "ERROR rate spike" reads the same on the
 * first occurrence and the fifth. Feeding the last few run outcomes back in
 * lets a prompt ask "is this becoming a pattern?" and escalate — once is
 * noise, twice is a coincidence, three times in an hour is a problem.
 *
 * Presence enables the feature; `undefined` on the automation means runs see
 * no history. Both bounds are caps, applied together.
 */
export type AutomationPriorRunLookback = {
  /** Most-recent completed runs to include, 1..{@link AUTOMATION_PRIOR_RUN_LOOKBACK_MAX_RUNS}. */
  maxRuns: number;
  /** Ignore runs older than this. Undefined = bounded by count alone. */
  maxAgeMs?: number;
};

export const AUTOMATION_PRIOR_RUN_LOOKBACK_MAX_RUNS = 20;

export function normalizeAutomationPriorRunLookback(
  value: AutomationPriorRunLookback | undefined,
): AutomationPriorRunLookback | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maxRuns = Math.floor(Number(value.maxRuns));
  if (!Number.isFinite(maxRuns) || maxRuns < 1) return undefined;
  const maxAgeMs =
    value.maxAgeMs !== undefined && Number.isFinite(value.maxAgeMs) && value.maxAgeMs > 0
      ? Math.floor(value.maxAgeMs)
      : undefined;
  return {
    maxRuns: Math.min(maxRuns, AUTOMATION_PRIOR_RUN_LOOKBACK_MAX_RUNS),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
  };
}

/**
 * One prior run as the prompt builder receives it: the outcome, not the
 * transcript. Assembled by the scheduler from run rows + artifacts so the
 * prompt builder stays a pure function.
 */
export type AutomationPriorRunContext = {
  completedAt: number;
  status: AutomationRunStatus;
  summary?: string;
  details?: string;
};

export type AutomationExecutionProfile = {
  backend?: AppServerBackendKind;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  cwd?: string;
  mcpAllowlist?: string[];
  skillAllowlist?: string[];
  toolAllowlist?: string[];
};

export type AutomationSourceMessageDestination =
  | "source_thread"
  | "source_channel";

export type AutomationOutputActionDefinition =
  | {
      id: string;
      kind: "agent_context";
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "source_message";
      destination: AutomationSourceMessageDestination;
      broadcast?: boolean;
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "messaging_target";
      target: AutomationMessagingConversationSnapshot;
      enabled?: boolean;
    };

export type AutomationOutputActionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "unsupported"
  | "skipped";

export type AutomationOutputActionResult = {
  actionId: string;
  kind: AutomationOutputActionDefinition["kind"];
  status: AutomationOutputActionStatus;
  attemptedAt?: number;
  completedAt?: number;
  message?: string;
  errorMessage?: string;
};

/**
 * True when an automation delivers its result through an explicit messaging
 * output action (`source_message` or `messaging_target`). Such automations own
 * their messaging delivery deliberately, so the legacy "broadcast the result to
 * every binding of the attached Agent thread" path must be suppressed for them
 * — otherwise the source conversation (which is often also a binding) receives
 * the result twice. `agent_context`-only automations keep the legacy broadcast.
 */
export function automationDeliversViaMessagingActions(
  outputActions: AutomationOutputActionDefinition[] | undefined,
): boolean {
  if (!Array.isArray(outputActions)) {
    return false;
  }
  return outputActions.some(
    (action) =>
      action.enabled !== false &&
      (action.kind === "source_message" || action.kind === "messaging_target"),
  );
}

/**
 * True when an automation's messaging delivery is governed entirely by its
 * configured output actions, so the legacy "broadcast the result to every
 * binding of the attached Agent thread" path must be suppressed. This holds
 * for:
 *   - inbound-triggered automations, whose result destination is always chosen
 *     in the editor (reply to source / a different conversation / agent only),
 *     and
 *   - any automation with an explicit messaging-delivery action.
 *
 * Legacy schedule-only automations that default to `agent_context` keep the
 * broadcast so they continue to surface in their bound conversations.
 */
export function automationSuppressesBindingBroadcast(automation: {
  outputActions?: AutomationOutputActionDefinition[];
  triggers?: AutomationTriggerDefinition[];
}): boolean {
  if (
    Array.isArray(automation.triggers) &&
    automation.triggers.some((trigger) => trigger.kind === "inbound_message")
  ) {
    return true;
  }
  return automationDeliversViaMessagingActions(automation.outputActions);
}

export type AutomationScheduleValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

export type DraftAutomationPromptRequest = {
  description: string;
};

export type DraftAutomationPromptResponse =
  | { status: "generated"; prompt: string }
  | { status: "unavailable" | "invalid" | "failed"; reason: string };

export type AutomationGateConfig = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  outputLimitChars?: number;
};

export type AutomationGateRunResult = {
  status: "proceed" | "skip" | "failed";
  command: string;
  cwd?: string;
  exitCode?: number;
  durationMs: number;
  output: string;
  outputTruncated?: boolean;
  errorMessage?: string;
};

export type AutomationThreadAssignment = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

/**
 * Automations attach to an Agent thread. The backend/thread identity remains
 * the durable pointer because Agent metadata is stored on the thread overlay.
 */
export type AutomationAgentAssignment = AutomationThreadAssignment;

export type AutomationListItemSummary = AutomationThreadAssignment & {
  id: string;
  name: string;
  status: AutomationStatus;
  triggers: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  scheduleSummary: string;
  backlogPolicy: AutomationBacklogPolicy;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunStatus?: AutomationRunStatus;
  pendingRunCount?: number;
  coalescedWindowCount?: number;
  updatedAt: number;
};

export type AutomationDetail = AutomationListItemSummary & {
  taskPrompt: string;
  gate?: AutomationGateConfig;
  executionProfile?: AutomationExecutionProfile;
  priorRunLookback?: AutomationPriorRunLookback;
  /**
   * Summed run cost since local midnight, computed from retained runs at read
   * time. A durable lifetime total needs a denormalized counter (schema
   * migration) and is deliberately not attempted here.
   */
  costTodayMicros?: number;
  outputActions: AutomationOutputActionDefinition[];
  /**
   * Inbound coalescing window in milliseconds. 0 disables coalescing (one run
   * per matching message). Undefined inherits the default.
   */
  inboundCoalesceWindowMs?: number;
  /**
   * Cap on inbound-triggered run starts per hour. Undefined inherits the
   * default; null is unlimited. See {@link resolveAutomationRunsPerHour}.
   */
  maxRunsPerHour?: number | null;
  createdAt: number;
  deletedAt?: number;
};

export type AutomationThreadSummary = {
  totalCount: number;
  enabledCount: number;
  pausedCount: number;
  nextRunAt?: number;
  lastRunAt?: number;
  pendingRunCount: number;
  coalescedWindowCount: number;
  skippedSinceLastCompletedCount: number;
  automations: AutomationListItemSummary[];
};

export type AutomationRunWindow = {
  scheduledFor: number;
};

/**
 * Why a run was recorded as `skipped` without starting a headless turn. Used to
 * tell the two inbound-skip kinds apart structurally (rather than by matching
 * display copy): `lane_busy` is a drop_missed busy-lane drop; `rate_limited` is
 * an hourly-cap throttle drop.
 */
export type AutomationRunSkipReason = "lane_busy" | "rate_limited";

/**
 * Token/cost accounting for one run's headless turn, distilled from the
 * turn-scope ThreadUsageLineRecord the pricing pipeline computes. Cost is the
 * list price at the time the run happened (micros, USD) — deliberately frozen
 * rather than recomputed, so later pricing-table changes don't rewrite the
 * history an operator already read.
 */
export type AutomationRunUsage = {
  model?: string;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  totalCostMicros?: number;
  currency?: string;
};

export type AutomationRunSummary = {
  id: string;
  automationId: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  scheduledFor?: number;
  scheduledWindows: AutomationRunWindow[];
  queuedAt?: number;
  queueEntryId?: string;
  startedAt?: number;
  completedAt?: number;
  backendThreadId?: string;
  backendTurnId?: string;
  errorMessage?: string;
  /** Set on `skipped` runs to explain the skip without matching display copy. */
  skipReason?: AutomationRunSkipReason;
  /**
   * How many inbound messages a `rate_limited` throttle marker has absorbed by
   * coalescing (a bounded count, not a per-message list). Surfaced in the run
   * list so the operator sees the size of the drop, e.g. "N messages dropped".
   */
  coalescedCount?: number;
  source?: AutomationRunSourceMetadata;
  usage?: AutomationRunUsage;
};

export type AutomationRunOutputDecision =
  | {
      kind: "post_card";
      summary: string;
      details?: string;
    }
  | {
      kind: "quiet";
      summary?: string;
      details?: string;
    }
  | {
      kind: "parse_failed";
      summary?: string;
      details?: string;
    };

export type AutomationRunTranscriptEvent = {
  id: string;
  at: number;
  kind: "invocation" | "gate" | "lifecycle" | "assistant_final" | "error";
  text?: string;
  metadata?: Record<string, unknown>;
};

export type AutomationRunArtifact = {
  runId: string;
  automationId: string;
  status: AutomationRunStatus;
  finalText?: string;
  errorMessage?: string;
  outputDecision?: AutomationRunOutputDecision;
  actionResults: AutomationOutputActionResult[];
  transcriptEvents: AutomationRunTranscriptEvent[];
  createdAt: number;
  updatedAt: number;
};

export type AutomationRunRollout = AutomationAgentAssignment & {
  turnId?: string;
  replay?: AppServerThreadReplay;
  errorMessage?: string;
};

export type AutomationTimelineCard = AutomationAgentAssignment & {
  id: string;
  automationId: string;
  automationName: string;
  runId: string;
  status: AutomationRunStatus;
  summary: string;
  details?: string;
  occurredAt: number;
};

export type OpenAutomationRunWindowRequest = {
  automationId: string;
  runId: string;
  /** Window-title hint; the window fetches authoritative data itself. */
  title?: string;
};

export type ListAutomationReplayCandidatesRequest = {
  automationId: string;
};

/** One recent conversation message, pre-judged against the trigger's filter. */
export type AutomationReplayCandidate = {
  message: InboundPreviewMessage;
  matches: boolean;
};

export type ListAutomationReplayCandidatesResponse = {
  candidates: AutomationReplayCandidate[];
  /**
   * False when the provider cannot serve conversation history (only Slack can
   * today) — the UI says so instead of rendering an empty list that reads as
   * "the channel is silent".
   */
  supported: boolean;
};

export type ReplayAutomationInboundRequest = {
  automationId: string;
  message: InboundPreviewMessage;
};

export type CreateAutomationRequest = AutomationAgentAssignment & {
  name: string;
  taskPrompt: string;
  gate?: AutomationGateConfig;
  triggers?: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
  executionProfile?: AutomationExecutionProfile;
  priorRunLookback?: AutomationPriorRunLookback;
  outputActions?: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  enabled?: boolean;
  nextRunAt?: number;
};

export type UpdateAutomationRequest = {
  automationId: string;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  name?: string;
  taskPrompt?: string;
  gate?: AutomationGateConfig | null;
  triggers?: AutomationTriggerDefinition[];
  schedule?: AutomationScheduleDefinition;
  backlogPolicy?: AutomationBacklogPolicy;
  executionProfile?: AutomationExecutionProfile | null;
  priorRunLookback?: AutomationPriorRunLookback | null;
  outputActions?: AutomationOutputActionDefinition[];
  inboundCoalesceWindowMs?: number;
  maxRunsPerHour?: number | null;
  enabled?: boolean;
  nextRunAt?: number | null;
};

export type AutomationIdRequest = {
  automationId: string;
};

export type ListAutomationsRequest = {
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
};

export type ListAutomationsResponse = {
  automations: AutomationDetail[];
};

/**
 * One automation row the running build could not load (malformed payload, or a
 * schedule/trigger shape this version doesn't understand). The row is left
 * untouched in storage and excluded from results for this process lifetime —
 * not paused, not deleted — so an older build silently skips data a newer
 * build wrote instead of crashing on it.
 */
export type AutomationLoadIssue = {
  id: string;
  name: string;
  reason: string;
};

export type ListAutomationLoadIssuesResponse = {
  issues: AutomationLoadIssue[];
};

export type AutomationMutationResponse = {
  automation: AutomationDetail;
};

export type ListAutomationRunsRequest = {
  automationId?: string;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  limit?: number;
};

export type ListAutomationRunsResponse = {
  runs: AutomationRunSummary[];
};

export type ListAutomationCardsRequest = AutomationAgentAssignment & {
  limit?: number;
};

export type ListAutomationCardsResponse = {
  cards: AutomationTimelineCard[];
};

export type GetAutomationRunArtifactRequest = {
  runId: string;
};

export type GetAutomationRunArtifactResponse = {
  artifact?: AutomationRunArtifact;
  rollout?: AutomationRunRollout;
};

export type RunAutomationNowResponse = {
  run: AutomationRunSummary;
  queueStatus: "started" | "queued" | "failed";
  queueEntryId?: string;
  turnId?: string;
};

export function validateAutomationScheduleDefinition(
  schedule: AutomationScheduleDefinition,
): AutomationScheduleValidationResult {
  switch (schedule.kind) {
    case "interval":
      if (!Number.isInteger(schedule.every) || schedule.every < 1) {
        return {
          ok: false,
          error: "Interval schedules must run every whole number greater than zero.",
        };
      }
      if (!AUTOMATION_INTERVAL_UNITS.includes(schedule.unit)) {
        return {
          ok: false,
          error: "Interval schedules must use minutes or hours.",
        };
      }
      return { ok: true };
    case "weekly": {
      const uniqueDays = new Set(schedule.daysOfWeek);
      if (uniqueDays.size === 0) {
        return {
          ok: false,
          error: "Weekly schedules must include at least one day.",
        };
      }
      if (uniqueDays.size !== schedule.daysOfWeek.length) {
        return {
          ok: false,
          error: "Weekly schedules cannot include duplicate days.",
        };
      }
      for (const day of uniqueDays) {
        if (!AUTOMATION_WEEKDAYS.includes(day)) {
          return {
            ok: false,
            error: "Weekly schedules contain an unsupported day.",
          };
        }
      }
      return validateTimeOfDay(schedule.timeOfDay);
    }
    case "weekdays":
      return validateTimeOfDay(schedule.timeOfDay);
    default:
      return assertNeverSchedule(schedule);
  }
}

export function formatAutomationScheduleSummary(
  schedule: AutomationScheduleDefinition,
): string {
  switch (schedule.kind) {
    case "interval":
      if (schedule.every === 1 && schedule.unit === "hours") {
        return "hourly";
      }
      if (schedule.every === 1 && schedule.unit === "minutes") {
        return "every minute";
      }
      return `every ${schedule.every} ${schedule.unit}`;
    case "weekly":
      return `${formatWeekdayList(schedule.daysOfWeek)} at ${formatTimeOfDay(schedule.timeOfDay)}`;
    case "weekdays":
      return `weekdays at ${formatTimeOfDay(schedule.timeOfDay)}`;
    default:
      return assertNeverSchedule(schedule);
  }
}

function validateTimeOfDay(
  timeOfDay: AutomationTimeOfDay,
): AutomationScheduleValidationResult {
  if (!Number.isInteger(timeOfDay.hour) || timeOfDay.hour < 0 || timeOfDay.hour > 23) {
    return {
      ok: false,
      error: "Schedule hour must be a whole number from 0 through 23.",
    };
  }
  if (
    !Number.isInteger(timeOfDay.minute) ||
    timeOfDay.minute < 0 ||
    timeOfDay.minute > 59
  ) {
    return {
      ok: false,
      error: "Schedule minute must be a whole number from 0 through 59.",
    };
  }
  return { ok: true };
}

function formatWeekdayList(daysOfWeek: AutomationWeekday[]): string {
  const labels = daysOfWeek.map((day) => pluralizeWeekday(day));
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function pluralizeWeekday(day: AutomationWeekday): string {
  const label = `${day[0]?.toUpperCase() ?? ""}${day.slice(1)}`;
  return `${label}s`;
}

function formatTimeOfDay(timeOfDay: AutomationTimeOfDay): string {
  const period = timeOfDay.hour >= 12 ? "PM" : "AM";
  const hour12 = timeOfDay.hour % 12 || 12;
  if (timeOfDay.minute === 0) {
    return `${hour12} ${period}`;
  }
  return `${hour12}:${String(timeOfDay.minute).padStart(2, "0")} ${period}`;
}

function assertNeverSchedule(schedule: never): never {
  throw new Error(`Unsupported automation schedule: ${JSON.stringify(schedule)}`);
}
