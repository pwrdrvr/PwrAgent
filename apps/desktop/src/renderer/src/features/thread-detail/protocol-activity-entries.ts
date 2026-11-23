import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared/contracts/normalized-app-server";
import { mergeActivityDetails, summarizeActivityStatus } from "./live-transcript-activity";
import {
  isModelRoutingActivityEntry,
  mergeModelRoutingActivityEntry,
  modelRoutingActivityEntryId,
  type ModelRoutingNotification,
} from "./model-routing-activity";

/**
 * Live transcript rows for protocol notices: MCP startup and login status,
 * warnings, model reroutes and verification requests. Each kind keeps its own
 * row, so no notice erases a notice of another kind. A repeat of the same
 * notice updates its own row: MCP status merges per server, a warning is one
 * row per distinct text, and model routing is one row per turn. Codex reports
 * each automatic approval review as a warning; those share one collapsed row,
 * which takes the warning tone only once a review is not approved.
 */
export type ProtocolActivityNotice =
  | { method: "mcpServer/startupStatus/updated"; params: Record<string, unknown> }
  | { method: "mcpServer/oauthLogin/completed"; params: Record<string, unknown> }
  | { method: "warning"; params: { message?: unknown } }
  | ModelRoutingNotification;

export interface ProtocolActivityNoticeContext {
  threadId: string;
  now?: number;
  turn?: AppServerThreadTurnMetadata;
}

export type ProtocolActivityTurnEnd = "completed" | "failed" | "cancelled";

const MCP_PROTOCOL_ENTRY_ID = "live-mcp-protocol-status";
const WARNING_ENTRY_ID_PREFIX = "live-warning-";
const AUTO_REVIEW_ENTRY_ID = "live-auto-review-warnings";
const AUTO_REVIEW_DETAIL_ID_PREFIX = "live-auto-review-";

// Codex's guardianWarning text for one review decision, for example
// "Automatic approval review approved (risk: low, authorization: high): ...".
// The denial-limit notice ("... rejected too many approval requests ...")
// does not match, so it keeps a warning row of its own.
const AUTO_REVIEW_WARNING =
  /^Automatic approval review (approved|denied|timed out|aborted)(?:\s*\(([^)]*)\))?\s*:\s*([\s\S]*)$/i;
const AUTO_REVIEW_DECISION_ORDER = ["approved", "denied", "timed out", "aborted"] as const;
type AutoReviewDecision = (typeof AUTO_REVIEW_DECISION_ORDER)[number];

export const NO_PROTOCOL_ACTIVITY_ENTRIES: readonly AppServerThreadActivityEntry[] = [];

/**
 * Applies one notice. Returns `entries` itself when the notice changes
 * nothing (an empty warning, an MCP notice without a server name, a repeated
 * warning), so a state setter can skip the render.
 */
export function applyProtocolActivityNotice(
  entries: readonly AppServerThreadActivityEntry[],
  notice: ProtocolActivityNotice,
  context: ProtocolActivityNoticeContext,
): readonly AppServerThreadActivityEntry[] {
  const now = context.now ?? Date.now();
  switch (notice.method) {
    case "mcpServer/startupStatus/updated": {
      const entry = buildMcpServerStatusActivityEntry(notice.params, now);
      return entry
        ? upsertEntry(entries, entry.id, (current) => mergeMcpProtocolActivityEntry(current, entry))
        : entries;
    }
    case "mcpServer/oauthLogin/completed": {
      const entry = buildMcpOauthActivityEntry(notice.params, now);
      return entry
        ? upsertEntry(entries, entry.id, (current) => mergeMcpProtocolActivityEntry(current, entry))
        : entries;
    }
    case "warning": {
      const message = typeof notice.params.message === "string" ? notice.params.message : "";
      const review = buildAutoReviewActivityDetail(message);
      if (review) {
        return upsertEntry(entries, AUTO_REVIEW_ENTRY_ID, (current) => {
          // The same review again keeps its first detail.
          if (current?.details.some((detail) => detail.id === review.id)) return current;
          return buildAutoReviewActivityEntry(
            [...(current?.details ?? []), review],
            current?.createdAt ?? now,
          );
        });
      }
      const entry = buildWarningActivityEntry({ threadId: context.threadId, message, now });
      // The same warning again keeps its first row and time.
      return entry ? upsertEntry(entries, entry.id, (current) => current ?? entry) : entries;
    }
    default: {
      return upsertEntry(entries, modelRoutingActivityEntryId(notice.params.turnId), (current) => {
        const entry = mergeModelRoutingActivityEntry(current, notice, now);
        return entry ? { ...entry, ...(context.turn ? { turn: context.turn } : {}) } : current;
      });
    }
  }
}

/**
 * The rows a turn end defers into the transcript, stamped with that turn. A
 * completed turn keeps every row. A failed or cancelled turn keeps warnings
 * and model routing, which can explain why it ended; MCP startup and login
 * status is ambient session state.
 *
 * Deferred rows are retained by id, so MCP and warning rows, whose live ids
 * do not name a turn, take the turn's id. Otherwise the same warning or MCP
 * row in a later turn would replace this turn's row.
 */
export function protocolActivityEntriesAtTurnEnd(
  entries: readonly AppServerThreadActivityEntry[],
  end: ProtocolActivityTurnEnd,
  turn: AppServerThreadTurnMetadata | undefined,
): AppServerThreadActivityEntry[] {
  const kept = end === "completed"
    ? entries
    : entries.filter(
      (entry) => isModelRoutingActivityEntry(entry) || isWarningActivityEntry(entry),
    );
  if (!turn) return [...kept];
  return kept.map((entry) => ({
    ...entry,
    id: isModelRoutingActivityEntry(entry) ? entry.id : `${entry.id}@${turn.id}`,
    turn,
  }));
}

function isWarningActivityEntry(entry: AppServerThreadActivityEntry): boolean {
  return entry.id.startsWith(WARNING_ENTRY_ID_PREFIX) || entry.id === AUTO_REVIEW_ENTRY_ID;
}

/** Replaces the row with `id` in place, or appends it, so rows keep arrival order. */
function upsertEntry(
  entries: readonly AppServerThreadActivityEntry[],
  id: string,
  build: (current: AppServerThreadActivityEntry | undefined) => AppServerThreadActivityEntry | undefined,
): readonly AppServerThreadActivityEntry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  const current = index >= 0 ? entries[index] : undefined;
  const next = build(current);
  if (!next || next === current) return entries;
  if (index < 0) return [...entries, next];
  const updated = [...entries];
  updated[index] = next;
  return updated;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildMcpProtocolActivityEntry(
  details: AppServerThreadActivityDetail[],
  createdAt: number,
): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: MCP_PROTOCOL_ENTRY_ID,
    createdAt,
    summary: summarizeMcpProtocolActivity(details),
    status: summarizeActivityStatus(details),
    details,
  };
}

function summarizeMcpProtocolActivity(details: AppServerThreadActivityDetail[]): string {
  if (details.length === 1 && details[0]) {
    return details[0].label;
  }

  return `MCP status updates (${details.length})`;
}

function mergeMcpProtocolActivityEntry(
  current: AppServerThreadActivityEntry | undefined,
  next: AppServerThreadActivityEntry,
): AppServerThreadActivityEntry {
  if (current?.id !== MCP_PROTOCOL_ENTRY_ID) {
    return next;
  }

  return buildMcpProtocolActivityEntry(
    mergeActivityDetails(current.details, next.details),
    current.createdAt ?? next.createdAt ?? Date.now(),
  );
}

function buildMcpServerStatusActivityEntry(
  params: Record<string, unknown>,
  now: number,
): AppServerThreadActivityEntry | undefined {
  const serverName = readString(params, "name") ?? readString(params, "serverName");
  const status = readString(params, "status") ?? "updated";
  if (!serverName) {
    return undefined;
  }

  const error = readString(params, "error");
  const detailStatus: AppServerThreadActivityDetail["status"] =
    status === "failed" || error
      ? "failed"
      : status === "cancelled"
        ? "cancelled"
        : status === "ready"
          ? "completed"
          : "in_progress";
  const label = error
    ? `MCP ${serverName} ${status}: ${error}`
    : `MCP ${serverName} ${status}`;

  return buildMcpProtocolActivityEntry([
    {
      id: `live-mcp-status-${serverName}`,
      kind: "command",
      label,
      status: detailStatus,
    },
  ], now);
}

function buildMcpOauthActivityEntry(
  params: Record<string, unknown>,
  now: number,
): AppServerThreadActivityEntry | undefined {
  const serverName = readString(params, "name") ?? readString(params, "serverName");
  if (!serverName) {
    return undefined;
  }

  const success = params.success === true;
  const error = readString(params, "error");
  const label = success
    ? `MCP ${serverName} login completed`
    : `MCP ${serverName} login failed${error ? `: ${error}` : ""}`;
  const status: AppServerThreadActivityDetail["status"] = success ? "completed" : "failed";

  return buildMcpProtocolActivityEntry([
    {
      id: `live-mcp-oauth-${serverName}`,
      kind: "command",
      label,
      status,
    },
  ], now);
}

function buildWarningActivityEntry(params: {
  threadId: string;
  message: string;
  now: number;
}): AppServerThreadActivityEntry | undefined {
  const message = params.message.replace(/^warning:\s*/i, "").trim();
  if (!message) {
    return undefined;
  }

  return {
    type: "activity",
    id: `${WARNING_ENTRY_ID_PREFIX}${params.threadId}:${message}`,
    createdAt: params.now,
    tone: "warning",
    summary: `Warning: ${message}`,
    details: [],
  };
}

function readAutoReviewDecision(detail: AppServerThreadActivityDetail): AutoReviewDecision {
  const decision = detail.label.toLowerCase();
  return AUTO_REVIEW_DECISION_ORDER.find((candidate) => decision.startsWith(candidate))
    ?? "approved";
}

function buildAutoReviewActivityDetail(rawMessage: string): AppServerThreadActivityDetail | undefined {
  const message = rawMessage.replace(/^warning:\s*/i, "").trim();
  const match = AUTO_REVIEW_WARNING.exec(message);
  if (!match) {
    return undefined;
  }

  const decision = (match[1] ?? "approved").toLowerCase();
  const assessment = match[2]?.trim();
  const rationale = match[3]?.trim();
  const verdict = `${decision.charAt(0).toUpperCase()}${decision.slice(1)}`
    + (assessment ? ` (${assessment})` : "");
  // The label carries the rationale too: copying the row copies labels.
  return {
    id: `${AUTO_REVIEW_DETAIL_ID_PREFIX}${message}`,
    kind: "command",
    label: rationale ? `${verdict}: ${rationale}` : verdict,
    markdown: rationale ? `**${verdict}:** ${rationale}` : `**${verdict}**`,
  };
}

function buildAutoReviewActivityEntry(
  details: AppServerThreadActivityDetail[],
  createdAt: number,
): AppServerThreadActivityEntry {
  const counts = new Map<AutoReviewDecision, number>();
  for (const detail of details) {
    const decision = readAutoReviewDecision(detail);
    counts.set(decision, (counts.get(decision) ?? 0) + 1);
  }
  const summary = AUTO_REVIEW_DECISION_ORDER
    .filter((decision) => counts.has(decision))
    .map((decision) => `${counts.get(decision)} ${decision}`)
    .join(", ");
  const onlyApproved = counts.size === 1 && counts.has("approved");
  return {
    type: "activity",
    id: AUTO_REVIEW_ENTRY_ID,
    createdAt,
    ...(onlyApproved ? {} : { tone: "warning" as const }),
    summary: `Auto reviews: ${summary}`,
    details,
  };
}
