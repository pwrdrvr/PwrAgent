import path from "node:path";
import { createHash } from "node:crypto";
import {
  AGENT_FOLLOW_UP_FIRED_WINDOW_MS,
  AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW,
} from "@pwragent/shared";
import type {
  AgentFollowUpProtection,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ScheduledThreadAction,
  ScheduledThreadActionKind,
  ScheduledThreadActionHoldCause,
  ScheduledThreadActionOrigin,
  ScheduledThreadActionStatus,
  PendingWakeScheduledActions,
} from "@pwragent/shared";
import type {
  CreateScheduledThreadActionRecord,
  ScheduledThreadActionClaim as ClaimParams,
  ScheduledThreadActionHold,
  ScheduledThreadActionStorage,
  UpdateScheduledThreadActionRecord,
} from "@pwragent/owner-core/scheduled-thread-action-storage";
import { scheduledTurnQueueEntryId } from "@pwragent/owner-core/scheduled-thread-action-storage";
import type { StateDb } from "./state-db.js";
import {
  FileScheduledThreadActionPayloadStore,
  MemoryScheduledThreadActionPayloadStore,
  type ScheduledThreadActionPayload,
  type ScheduledThreadActionPayloadStore,
} from "./scheduled-thread-action-payload-store.js";

type ScheduledThreadActionRow = {
  action_id: string;
  backend: ScheduledThreadAction["backend"];
  thread_id: string;
  kind: ScheduledThreadActionKind;
  origin: ScheduledThreadActionOrigin;
  status: ScheduledThreadActionStatus;
  scheduled_for: number;
  queue_entry_id: string | null;
  turn_id: string | null;
  error_message: string | null;
  payload_ref: string | null;
  claim_owner: string | null;
  claim_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

const ACTIVE_STATUSES: readonly ScheduledThreadActionStatus[] = [
  "held",
  "scheduled",
  "dispatching",
  "queued",
];
/**
 * The fired agent follow-ups a thread's rolling window still counts. A
 * reservation is keyed by action id, so claiming the same follow-up again
 * after a hold reuses its slot.
 */
type AgentFollowUpGuard = {
  fired: Array<{ id: string; at: number }>;
  /** Never moves back, so a clock rollback cannot age reservations out early. */
  lastFiredAt?: number;
  suspendedAt?: number;
  /** The stored payload could not be read, so the allowance cannot be counted. */
  unreadable?: true;
};

/** An agent follow-up on a thread whose loop guard has tripped. */
const SUSPENDED_AGENT_FOLLOW_UP = `(
  origin = 'agent' AND EXISTS (
    SELECT 1 FROM thread_agent_follow_up_guards AS guard
    WHERE guard.backend = scheduled_thread_actions.backend
      AND guard.thread_id = scheduled_thread_actions.thread_id
      AND guard.suspended_at IS NOT NULL
  )
)`;

const ROW_COLUMNS = `
  action_id, backend, thread_id, kind, origin, status, scheduled_for,
  queue_entry_id, turn_id, error_message, payload_ref, claim_owner,
  claim_expires_at, created_at, updated_at
`;

export class ScheduledThreadActionStore implements ScheduledThreadActionStorage {
  private readonly payloadStore: ScheduledThreadActionPayloadStore;
  private readonly hasLegacyPayloadColumn: boolean;
  // Payload refs are immutable. Retain only compact text, never execution inputs.
  private readonly wakePreviewCache = new Map<string, string>();
  private suspendedAgentFollowUpThreads: Array<{ backend: ScheduledThreadAction["backend"]; threadId: string }> = [];

  constructor(
    private readonly stateDb: StateDb,
    payloadStore?: ScheduledThreadActionPayloadStore,
  ) {
    const dbName = stateDb.raw.name;
    this.payloadStore = payloadStore ?? (
      !dbName || dbName === ":memory:"
        ? new MemoryScheduledThreadActionPayloadStore()
        : new FileScheduledThreadActionPayloadStore(
            path.join(path.dirname(dbName), "scheduled-actions"),
          )
    );
    this.hasLegacyPayloadColumn = (
      stateDb.raw.prepare("PRAGMA table_info(scheduled_thread_actions)").all() as Array<{
        name: string;
      }>
    ).some((column) => column.name === "payload");
    this.migrateLegacyPayloads();
  }

  create(input: CreateScheduledThreadActionRecord): ScheduledThreadAction {
    const action: ScheduledThreadAction = {
      id: input.id,
      backend: input.backend,
      threadId: input.threadId,
      kind: input.kind,
      origin: input.origin,
      status: input.manualReleaseRequired ? "held" : "scheduled",
      scheduledFor: input.scheduledFor,
      displayText: input.displayText,
      imageAttachments: input.imageAttachments,
      fileAttachments: input.fileAttachments,
      manualReleaseRequired: input.manualReleaseRequired,
      turn: input.turn,
      review: input.review,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.write(action);
    return action;
  }

  createAgentFollowUp(
    input: CreateScheduledThreadActionRecord,
    maxActive: number,
  ): { action: ScheduledThreadAction } | { refused: "active_limit"; active: number } {
    return this.stateDb.raw.transaction(() => {
      const active = this.countActiveAgentFollowUps(input);
      if (active >= maxActive) return { refused: "active_limit" as const, active };
      return { action: this.create({ ...input, origin: "agent" }) };
    }).immediate();
  }

  countActiveAgentFollowUps(thread: { backend: string; threadId: string }): number {
    return (this.stateDb.raw.prepare(
      `SELECT COUNT(*) AS active FROM scheduled_thread_actions
       WHERE backend = ? AND thread_id = ? AND origin = 'agent'
         AND status IN ('held', 'scheduled', 'dispatching', 'queued')`,
    ).get(thread.backend, thread.threadId) as { active: number }).active;
  }

  agentFollowUpProtection(
    thread: { backend: string; threadId: string },
    now: number,
  ): AgentFollowUpProtection {
    const guard = this.readAgentFollowUpGuard(thread);
    const effectiveNow = Math.max(now, guard.lastFiredAt ?? now);
    return {
      firedInWindow: guard.fired.filter((entry) =>
        entry.at > effectiveNow - AGENT_FOLLOW_UP_FIRED_WINDOW_MS).length,
      ...(guard.suspendedAt !== undefined ? { suspendedAt: guard.suspendedAt } : {}),
    };
  }

  rearmAgentFollowUps(thread: { backend: string; threadId: string }): void {
    this.stateDb.raw.prepare(
      "DELETE FROM thread_agent_follow_up_guards WHERE backend = ? AND thread_id = ?",
    ).run(thread.backend, thread.threadId);
  }

  takeSuspendedAgentFollowUpThreads(): Array<{ backend: ScheduledThreadAction["backend"]; threadId: string }> {
    const threads = this.suspendedAgentFollowUpThreads;
    this.suspendedAgentFollowUpThreads = [];
    return threads;
  }

  private readAgentFollowUpGuard(thread: { backend: string; threadId: string }): AgentFollowUpGuard {
    const row = this.stateDb.raw.prepare(
      "SELECT suspended_at, payload FROM thread_agent_follow_up_guards WHERE backend = ? AND thread_id = ?",
    ).get(thread.backend, thread.threadId) as { suspended_at: number | null; payload: string } | undefined;
    if (!row) return { fired: [] };
    // The column is the authority: the due queries read it without the payload.
    const suspended = row.suspended_at !== null ? { suspendedAt: row.suspended_at } : {};
    let payload: Partial<AgentFollowUpGuard>;
    try {
      payload = JSON.parse(row.payload) as Partial<AgentFollowUpGuard>;
      if (!payload || typeof payload !== "object") throw new Error("Not a guard payload");
    } catch {
      return { fired: [], unreadable: true, ...suspended };
    }
    return {
      fired: Array.isArray(payload.fired) ? payload.fired : [],
      ...(typeof payload.lastFiredAt === "number" ? { lastFiredAt: payload.lastFiredAt } : {}),
      ...suspended,
    };
  }

  private writeAgentFollowUpGuard(
    thread: { backend: string; threadId: string },
    guard: AgentFollowUpGuard,
  ): void {
    this.stateDb.raw.prepare(
      `INSERT INTO thread_agent_follow_up_guards(backend, thread_id, suspended_at, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(backend, thread_id) DO UPDATE SET
         suspended_at = excluded.suspended_at, payload = excluded.payload`,
    ).run(
      thread.backend,
      thread.threadId,
      guard.suspendedAt ?? null,
      JSON.stringify({ fired: guard.fired, lastFiredAt: guard.lastFiredAt }),
    );
  }

  /**
   * The guard's answer for one dispatch claim, read inside the claim's own
   * immediate transaction. An admitted claim returns the guard to store with
   * it; a refused one has already recorded the suspension.
   */
  private reserveAgentFollowUp(
    thread: { backend: ScheduledThreadAction["backend"]; threadId: string },
    actionId: string,
    now: number,
  ): AgentFollowUpGuard | "unchanged" | undefined {
    const guard = this.readAgentFollowUpGuard(thread);
    if (guard.suspendedAt !== undefined) return undefined;
    if (guard.unreadable) {
      // Suspended rather than thrown: a throw here would stop every thread's
      // scheduled actions, and a fresh allowance would defeat the guard.
      this.writeAgentFollowUpGuard(thread, { fired: [], suspendedAt: now });
      this.suspendedAgentFollowUpThreads.push({ backend: thread.backend, threadId: thread.threadId });
      return undefined;
    }
    const effectiveNow = Math.max(now, guard.lastFiredAt ?? now);
    const fired = guard.fired.filter((entry) =>
      entry.at > effectiveNow - AGENT_FOLLOW_UP_FIRED_WINDOW_MS);
    // A held or re-admitted follow-up already spent its slot.
    if (fired.some((entry) => entry.id === actionId)) return "unchanged";
    if (fired.length >= AGENT_FOLLOW_UP_MAX_FIRED_PER_WINDOW) {
      this.writeAgentFollowUpGuard(thread, { ...guard, fired, suspendedAt: effectiveNow });
      this.suspendedAgentFollowUpThreads.push({ backend: thread.backend, threadId: thread.threadId });
      return undefined;
    }
    return { fired: [...fired, { id: actionId, at: effectiveNow }], lastFiredAt: effectiveNow };
  }

  get(id: string): ScheduledThreadAction | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT ` + ROW_COLUMNS + `
         FROM scheduled_thread_actions WHERE action_id = ?`,
      )
      .get(id) as ScheduledThreadActionRow | undefined;
    return row ? this.actionFromRow(row) : undefined;
  }

  getByQueueEntryId(queueEntryId: string): ScheduledThreadAction | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT ` + ROW_COLUMNS + `
         FROM scheduled_thread_actions WHERE queue_entry_id = ?`,
      )
      .get(queueEntryId) as ScheduledThreadActionRow | undefined;
    return row ? this.actionFromRow(row) : undefined;
  }

  list(request: ListScheduledThreadActionsRequest = {}): ScheduledThreadAction[] {
    const { clause, values } = this.listPredicate(request);
    const rows = this.stateDb.raw
      .prepare(
        `SELECT ` + ROW_COLUMNS + ` FROM scheduled_thread_actions
         ` + clause + `
         ORDER BY scheduled_for ASC, created_at ASC`,
      )
      .all(...values) as ScheduledThreadActionRow[];
    return rows.map((row) => this.actionFromRow(row));
  }

  ownsPendingWake(thread: { backend: string; threadId: string }, id: string): boolean {
    return Boolean(this.stateDb.raw.prepare(
      "SELECT 1 FROM scheduled_thread_actions WHERE action_id = ? AND backend = ? AND thread_id = ? AND status IN ('scheduled', 'held')",
    ).get(id, thread.backend, thread.threadId));
  }

  /** Bounded metadata for Waiting for. History is admitted only on panel demand. */
  listPendingWakes(thread: { backend: string; threadId: string; endedLimit: number }): PendingWakeScheduledActions {
    // The guard is read in this statement, so a suspension costs the Waiting
    // for projection no extra query. The guard side always yields one row, so
    // a suspension with no waiting follow-up still reaches the panel: the
    // operator may have cancelled it, which does not rearm the thread.
    const joined = this.stateDb.raw.prepare(
      `SELECT ` + ROW_COLUMNS + `,
         guard.suspended AS follow_ups_suspended,
         (origin = 'agent' AND guard.suspended) AS follow_up_suspended
       FROM (
         SELECT EXISTS (
           SELECT 1 FROM thread_agent_follow_up_guards
           WHERE backend = ? AND thread_id = ? AND suspended_at IS NOT NULL
         ) AS suspended
       ) AS guard
       LEFT JOIN scheduled_thread_actions
         ON scheduled_thread_actions.backend = ?
           AND scheduled_thread_actions.thread_id = ?
           AND scheduled_thread_actions.status IN ('scheduled', 'held')
       ORDER BY CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END, scheduled_for, created_at, action_id LIMIT 101`,
    ).all(thread.backend, thread.threadId, thread.backend, thread.threadId) as Array<
      Omit<ScheduledThreadActionRow, "action_id"> & { action_id: string | null; follow_ups_suspended: number; follow_up_suspended?: number }>;
    // The guard column is the same on every row, and there is always one.
    const followUpsSuspended = joined[0]?.follow_ups_suspended === 1;
    const active = joined.filter((row): row is ScheduledThreadActionRow & { follow_ups_suspended: number; follow_up_suspended?: number } =>
      row.action_id !== null);
    const ended = thread.endedLimit === 0 ? [] : this.stateDb.raw.prepare(
      `SELECT ` + ROW_COLUMNS + ` FROM scheduled_thread_actions
       WHERE backend = ? AND thread_id = ? AND status IN ('started', 'cancelled', 'failed')
       ORDER BY updated_at DESC, action_id DESC LIMIT ?`,
    ).all(thread.backend, thread.threadId, thread.endedLimit) as ScheduledThreadActionRow[];
    let incomplete = active.length > 100;
    const actions = [...active.slice(0, 100), ...ended].map((row: ScheduledThreadActionRow & { follow_up_suspended?: number }) => {
      let displayText = "";
      try {
        if (!row.payload_ref) throw new Error("Missing scheduled payload");
        const cached = this.wakePreviewCache.get(row.payload_ref);
        displayText = cached ?? this.payloadStore.read(row.payload_ref, 256 * 1024).displayText.trim().replace(/\s+/g, " ").slice(0, 600);
        if (cached === undefined) {
          if (this.wakePreviewCache.size >= 128) this.wakePreviewCache.delete(this.wakePreviewCache.keys().next().value!);
          this.wakePreviewCache.set(row.payload_ref, displayText);
        }
      } catch {
        // Keep the cancellable wake visible even when its optional text is unreadable.
        incomplete = true;
      }
      return { id: row.action_id, kind: row.kind, origin: row.origin, status: row.status,
        scheduledFor: row.scheduled_for, queueEntryId: row.queue_entry_id ?? undefined, displayText, createdAt: row.created_at, updatedAt: row.updated_at,
        ...(row.follow_up_suspended ? { followUpSuspended: true as const } : {}) };
    });
    return {
      actions,
      ...(followUpsSuspended ? { followUpsSuspended: true as const } : {}),
      ...(incomplete ? { incomplete: true as const } : {}),
    };
  }

  listProjectionPage(request: ListScheduledThreadActionsRequest): ListScheduledThreadActionsResponse {
    const { clause, values } = this.listPredicate(request);
    const revision = (): string => this.readProjectionRevision(request);
    const currentRevision = revision();
    let offset = 0;
    if (request.cursor) {
      if (request.cursor.length > 256) throw new Error("Invalid scheduled action cursor.");
      const match = /^([a-f0-9]{64}):([0-9]{1,6})$/.exec(request.cursor);
      if (!match) throw new Error("Invalid scheduled action cursor.");
      if (match[1] !== currentRevision) throw new Error("[navigation_cursor_expired] Scheduled actions changed while paging.");
      offset = Number(match[2]);
    }
    const rows = this.stateDb.raw.prepare(
      `SELECT ` + ROW_COLUMNS + ` FROM scheduled_thread_actions ` + clause + `
       ORDER BY scheduled_for ASC, created_at ASC, action_id ASC LIMIT ? OFFSET ?`,
    ).all(...values, 101, offset) as ScheduledThreadActionRow[];
    const actions: ScheduledThreadAction[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, 100)) {
      const action = this.actionFromRow(row, 248 * 1024);
      const actionBytes = Buffer.byteLength(JSON.stringify(action));
      if (actionBytes > 248 * 1024) throw new Error("Scheduled action exceeds the bounded projection budget.");
      if (bytes + actionBytes > 248 * 1024) break;
      actions.push(action);
      bytes += actionBytes;
    }
    if (revision() !== currentRevision) throw new Error("[navigation_cursor_expired] Scheduled actions changed while paging.");
    const complete = actions.length === rows.length;
    return { actions, projectionProtocol: 2, revision: currentRevision, complete,
      ...(!complete ? { nextCursor: `${currentRevision}:${offset + actions.length}` } : {}),
    };
  }

  private externalDataVersion?: number;
  private externalProjectionRevision?: string;

  observeExternalProjectionChange(): boolean {
    const version = this.stateDb.raw.pragma("data_version", { simple: true }) as number;
    if (version === this.externalDataVersion) return false;
    const revision = this.readProjectionRevision({ includeTerminal: true });
    const changed = this.externalProjectionRevision !== undefined && this.externalProjectionRevision !== revision;
    this.externalDataVersion = version;
    this.externalProjectionRevision = revision;
    return changed;
  }

  private readProjectionRevision(request: ListScheduledThreadActionsRequest): string {
    const { clause, values } = this.listPredicate(request);
    const admission = this.stateDb.raw.prepare(
      `SELECT COALESCE(SUM(
         length(CAST(action_id AS BLOB)) + length(CAST(thread_id AS BLOB))
         + COALESCE(length(CAST(error_message AS BLOB)), 0)
         + COALESCE(length(CAST(payload_ref AS BLOB)), 0)
         + COALESCE(length(CAST(queue_entry_id AS BLOB)), 0)
         + COALESCE(length(CAST(turn_id AS BLOB)), 0) + 512
       ), 0) AS bytes FROM scheduled_thread_actions ` + clause + ``,
    ).get(...values) as { bytes: number };
    if (admission.bytes > 8 * 1024 * 1024) throw new Error("Scheduled action index exceeds its byte budget.");
    const hash = createHash("sha256").update(JSON.stringify([clause, values]));
    let bytes = 0;
    // Stream compact rows; neither hash construction nor cursor validation
    // loads scheduled inputs or retains an owner-wide payload collection.
    for (const row of this.stateDb.raw.prepare(
      `SELECT action_id, backend, thread_id, kind, origin, status, scheduled_for,
        queue_entry_id, turn_id, error_message, payload_ref, created_at, updated_at
       FROM scheduled_thread_actions ` + clause + ` ORDER BY action_id`,
    ).iterate(...values)) {
      const json = JSON.stringify(row);
      bytes += Buffer.byteLength(json);
      if (bytes > 8 * 1024 * 1024) throw new Error("Scheduled action index exceeds its byte budget.");
      hash.update(json);
    }
    return hash.digest("hex");
  }

  private listPredicate(request: ListScheduledThreadActionsRequest): { clause: string; values: unknown[] } {
    const where: string[] = [];
    const values: unknown[] = [];
    if (request.backend) {
      where.push("backend = ?");
      values.push(request.backend);
    }
    if (request.threadId) {
      where.push("thread_id = ?");
      values.push(request.threadId);
    }
    if (typeof request.terminalUpdatedAfter === "number") {
      where.push(
        `(status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")}) OR updated_at >= ?)`,
      );
      values.push(...ACTIVE_STATUSES, request.terminalUpdatedAfter);
    } else if (request.includeFailed && !request.includeTerminal) {
      where.push(
        `(status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")}) OR status = 'failed')`,
      );
      values.push(...ACTIVE_STATUSES);
    } else if (!request.includeTerminal) {
      where.push(`status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`);
      values.push(...ACTIVE_STATUSES);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return { clause, values };
  }

  nextScheduledAt(): number | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT scheduled_for
         FROM scheduled_thread_actions
         WHERE status = 'scheduled' AND NOT ` + SUSPENDED_AGENT_FOLLOW_UP + `
         ORDER BY scheduled_for ASC, created_at ASC
         LIMIT 1`,
      )
      .get() as { scheduled_for: number } | undefined;
    return row?.scheduled_for;
  }

  update(
    id: string,
    patch: UpdateScheduledThreadActionRecord,
  ): ScheduledThreadAction | undefined {
    const current = this.get(id);
    if (!current || current.status !== "scheduled") return undefined;
    const updated: ScheduledThreadAction = {
      ...current,
      scheduledFor: patch.scheduledFor ?? current.scheduledFor,
      displayText: patch.displayText ?? current.displayText,
      imageAttachments: patch.imageAttachments ?? current.imageAttachments,
      fileAttachments: patch.fileAttachments ?? current.fileAttachments,
      turn: patch.turn ?? current.turn,
      review: patch.review ?? current.review,
      updatedAt: patch.now,
    };
    const previousRef = this.readPayloadRef(id);
    const nextRef = this.payloadStore.write(id, payloadFromAction(updated));
    try {
      const result = this.stateDb.raw.prepare(
        `UPDATE scheduled_thread_actions
         SET scheduled_for = ?, updated_at = ?, payload_ref = ?
         WHERE action_id = ? AND status = 'scheduled' AND payload_ref = ?`,
      ).run(updated.scheduledFor, updated.updatedAt, nextRef, id, previousRef);
      if (result.changes !== 1) {
        this.payloadStore.delete(nextRef);
        return undefined;
      }
      this.payloadStore.delete(previousRef);
      return updated;
    } catch (error) {
      this.payloadStore.delete(nextRef);
      throw error;
    }
  }

  cancel(id: string, now: number): ScheduledThreadAction | undefined {
    return this.transition(id, ["held", "scheduled"], { status: "cancelled" }, now);
  }

  /**
   * The operator has dealt with a failed action: deleted it, edited it back
   * into the composer, or sent it again. Without this the failure stays
   * projectable for the whole history retention, and every fresh projection
   * puts its row back in the queue.
   */
  dismissFailed(id: string, now: number): ScheduledThreadAction | undefined {
    return this.transition(id, ["failed"], { status: "cancelled" }, now);
  }

  /**
   * An agent follow-up reserves its slot in the thread's loop guard in this
   * same immediate transaction, so two owners cannot spend one allowance and
   * a crash cannot keep a claim without its reservation.
   */
  claim(id: string, params: ClaimParams): ScheduledThreadAction | undefined {
    return this.claimWith(id, params, {});
  }

  /**
   * Claims a held action only while `holderId` still holds it, so two owners
   * that both found its holder dead cannot both take it. The dead holder's
   * queue entry is gone, so the claim forgets it. `readmit` also drops the
   * manual release: the action is dispatched again as when it came due.
   */
  claimHeld(
    id: string,
    holderId: string | undefined,
    params: ClaimParams,
    options: { readmit: boolean },
  ): ScheduledThreadAction | undefined {
    return this.stateDb.raw.transaction(() => {
      const held = this.stateDb.raw.prepare(
        "SELECT backend, thread_id, queue_entry_id FROM scheduled_thread_actions WHERE action_id = ? AND status = 'held' AND claim_owner IS ?",
      ).get(id, holderId ?? null) as Pick<ScheduledThreadActionRow, "backend" | "thread_id" | "queue_entry_id"> | undefined;
      if (!held) return undefined;
      const queueEntryId = held.queue_entry_id ?? scheduledTurnQueueEntryId(id);
      const receipt = this.readQueuedRestartReceipt(queueEntryId, held);
      // A real operator pause belongs to the checkpoint, including when
      // the old scheduler's PID can no longer be confirmed.
      if (receipt?.ownsScheduledTurn === 1) return undefined;
      const claimed = this.claimWith(id, params, {
        queueEntryId: undefined,
        ...(options.readmit ? { manualReleaseRequired: false, holdCause: undefined } : {}),
      });
      if (claimed && options.readmit && receipt) {
        // Discard a legacy quiet-restart copy with the claim, even if its
        // old PID has been reused and the restart store cannot claim it.
        this.stateDb.raw.prepare("DELETE FROM restart_continuations WHERE entry_id = ?").run(queueEntryId);
      }
      return claimed;
    }).immediate();
  }

  listHeldHolds(id?: string): ScheduledThreadActionHold[] {
    // A suspended thread's follow-ups cannot be claimed, so listing them
    // would only make every scheduler pass try and fail.
    const rows = this.stateDb.raw.prepare(
      `SELECT action_id, claim_owner, error_message, updated_at FROM scheduled_thread_actions
       WHERE status = 'held' AND (? IS NULL OR action_id = ?)
         AND NOT ` + SUSPENDED_AGENT_FOLLOW_UP + `
       ORDER BY scheduled_for ASC, created_at ASC`,
    ).all(id ?? null, id ?? null) as Array<{
      action_id: string;
      claim_owner: string | null;
      error_message: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.action_id,
      updatedAt: row.updated_at,
      ...(row.claim_owner ? { holderId: row.claim_owner } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
    }));
  }

  private claimWith(
    id: string,
    params: ClaimParams,
    patch: Pick<Partial<ScheduledThreadAction>, "holdCause" | "manualReleaseRequired" | "queueEntryId">,
  ): ScheduledThreadAction | undefined {
    return this.stateDb.raw.transaction(() => {
      const row = this.stateDb.raw.prepare(
        `SELECT backend, thread_id, origin FROM scheduled_thread_actions
         WHERE action_id = ? AND status IN ('held', 'scheduled')`,
      ).get(id) as {
        backend: ScheduledThreadAction["backend"];
        thread_id: string;
        origin: ScheduledThreadActionOrigin;
      } | undefined;
      if (!row) return undefined;
      const thread = { backend: row.backend, threadId: row.thread_id };
      const reservation = row.origin === "agent"
        ? this.reserveAgentFollowUp(thread, id, params.now)
        : "unchanged";
      if (reservation === undefined) return undefined;
      const claimed = this.transition(
        id,
        ["held", "scheduled"],
        { ...patch, status: "dispatching" },
        params.now,
        {
          claimOwner: params.ownerId,
          claimExpiresAt: params.leaseExpiresAt,
        },
      );
      if (claimed && reservation !== "unchanged") this.writeAgentFollowUpGuard(thread, reservation);
      return claimed;
    }).immediate();
  }

  claimNextDue(params: ClaimParams): ScheduledThreadAction | undefined {
    return this.stateDb.raw.transaction(() => {
      // A claim the guard refuses suspends its thread, which takes that
      // thread's follow-ups out of the next read. Other due work goes on.
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const row = this.stateDb.raw.prepare(
          `SELECT action_id
           FROM scheduled_thread_actions
           WHERE status = 'scheduled' AND scheduled_for <= ?
             AND NOT ` + SUSPENDED_AGENT_FOLLOW_UP + `
           ORDER BY scheduled_for ASC, created_at ASC
           LIMIT 1`,
        ).get(params.now) as { action_id: string } | undefined;
        if (!row) return undefined;
        const claimed = this.claim(row.action_id, params);
        if (claimed) return claimed;
      }
      return undefined;
    }).immediate();
  }

  markQueued(
    id: string,
    queueEntryId: string,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching"],
      { status: "queued", queueEntryId },
      now,
      { expectedOwner: ownerId },
    );
  }

  markStarted(
    id: string,
    turnId: string | undefined,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching", "queued"],
      { status: "started", turnId, errorMessage: undefined },
      now,
      { clearClaim: true, expectedOwner: ownerId },
    );
  }

  markHeld(
    id: string,
    queueEntryId: string,
    errorMessage: string,
    now: number,
    ownerId?: string,
    hold?: { holderId?: string; cause?: ScheduledThreadActionHoldCause },
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching", "queued"],
      {
        status: "held",
        queueEntryId,
        errorMessage,
        manualReleaseRequired: true,
        holdCause: hold?.cause,
      },
      now,
      // The holder's in-memory queue keeps the entry. Holding is no lease:
      // nothing renews it, and only the holder's death ends it.
      { clearClaim: true, expectedOwner: ownerId, holder: hold?.holderId },
    );
  }

  markHeldQueued(
    id: string,
    queueEntryId: string,
    params: ClaimParams,
  ): ScheduledThreadAction | undefined {
    return this.stateDb.raw.transaction(() => {
      const row = this.stateDb.raw.prepare(
        "SELECT queue_entry_id FROM scheduled_thread_actions WHERE action_id = ? AND status = 'held'",
      ).get(id) as { queue_entry_id: string | null } | undefined;
      if (row?.queue_entry_id !== queueEntryId) return undefined;
      return this.transition(
        id,
        ["held"],
        { status: "queued", errorMessage: undefined },
        params.now,
        { claimOwner: params.ownerId, claimExpiresAt: params.leaseExpiresAt },
      );
    }).immediate();
  }

  markHeldStarted(
    id: string,
    queueEntryId: string,
    turnId: string | undefined,
    now: number,
  ): ScheduledThreadAction | undefined {
    return this.stateDb.raw.transaction(() => {
      const row = this.stateDb.raw.prepare(
        "SELECT queue_entry_id FROM scheduled_thread_actions WHERE action_id = ? AND status = 'held'",
      ).get(id) as { queue_entry_id: string | null } | undefined;
      if (row?.queue_entry_id !== queueEntryId) return undefined;
      return this.transition(
        id,
        ["held"],
        { status: "started", turnId, errorMessage: undefined },
        now,
        { clearClaim: true },
      );
    }).immediate();
  }

  markFailed(
    id: string,
    errorMessage: string,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching", "queued"],
      { status: "failed", errorMessage },
      now,
      { clearClaim: true, expectedOwner: ownerId },
    );
  }

  markCancelled(
    id: string,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["held", "dispatching", "queued"],
      { status: "cancelled" },
      now,
      { clearClaim: true, expectedOwner: ownerId },
    );
  }

  renewClaims(ownerId: string, now: number, leaseExpiresAt: number): void {
    this.stateDb.raw.prepare(
      `UPDATE scheduled_thread_actions
       SET claim_expires_at = ?, updated_at = ?
       WHERE claim_owner = ? AND status IN ('dispatching', 'queued')`,
    ).run(leaseExpiresAt, now, ownerId);
  }

  private readQueuedRestartReceipt(
    entryId: string,
    action: Pick<ScheduledThreadActionRow, "backend" | "thread_id">,
  ): { ownsScheduledTurn: number | null } | undefined {
    return this.stateDb.raw.prepare(
      `SELECT json_extract(payload, '$.ownsScheduledTurn') AS ownsScheduledTurn
       FROM restart_continuations WHERE entry_id = ?
         AND CASE WHEN json_valid(payload) THEN
           json_extract(payload, '$.kind') = 'queued' AND json_extract(payload, '$.id') = entry_id
           AND json_extract(payload, '$.backend') = ? AND json_extract(payload, '$.threadId') = ?
           AND json_type(payload, '$.input') = 'array'
         END`,
    ).get(entryId, action.backend, action.thread_id) as { ownsScheduledTurn: number | null } | undefined;
  }

  expiredClaimOwnerIds(now: number): string[] {
    const rows = this.stateDb.raw.prepare(
      `SELECT DISTINCT claim_owner
       FROM scheduled_thread_actions
       WHERE status IN ('dispatching', 'queued')
         AND claim_owner IS NOT NULL
         AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
    ).all(now) as Array<{ claim_owner: string }>;
    return rows.map((row) => row.claim_owner);
  }

  recoverExpiredClaims(
    now: number,
    protectedOwnerIds: ReadonlySet<string> = new Set(),
  ): ScheduledThreadAction[] {
    return this.stateDb.raw.transaction(() => {
      const rows = this.stateDb.raw.prepare(
        `SELECT action_id, claim_owner, status, backend, thread_id, queue_entry_id
         FROM scheduled_thread_actions
         WHERE status IN ('dispatching', 'queued')
           AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
      ).all(now) as Array<{
        action_id: string;
        claim_owner: string | null;
        status: "dispatching" | "queued";
      } & Pick<ScheduledThreadActionRow, "backend" | "thread_id" | "queue_entry_id">>;
      return rows.flatMap((row) => {
        if (
          row.claim_owner
          && protectedOwnerIds.has(row.claim_owner)
        ) return [];
        // Quiet restart checkpointed this entry before it started. The
        // restart queue now owns it, including after the old lease expires.
        if (row.status === "queued" && row.queue_entry_id && this.readQueuedRestartReceipt(row.queue_entry_id, row)) {
          return [];
        }
        const current = this.get(row.action_id);
        const updated = current?.manualReleaseRequired && row.status === "queued"
          // A queued release is announced just before the queue starts it,
          // so the turn may have begun. Sending it again could run it twice.
          ? this.transition(
              row.action_id,
              ["queued"],
              {
                status: "failed",
                queueEntryId: undefined,
                errorMessage:
                  "PwrAgent stopped while this held action was being released. It was not sent again, because it may already have started. Check the thread before scheduling it again.",
              },
              now,
              { clearClaim: true, requireExpiredAt: now },
            )
          : current?.manualReleaseRequired
          ? this.transition(
              row.action_id,
              ["dispatching", "queued"],
              { status: "held", queueEntryId: undefined },
              now,
              { clearClaim: true, requireExpiredAt: now },
            )
          : current?.origin === "agent" && row.status === "queued"
            // The in-memory queue may have started this follow-up just before
            // the owner died. An agent's own wake is never admitted twice.
            ? this.transition(
                row.action_id,
                ["queued"],
                {
                  status: "failed",
                  queueEntryId: undefined,
                  errorMessage:
                    "PwrAgent stopped while this follow-up waited behind another turn. It was not sent again, because it may already have started. Check the thread before scheduling it again.",
                },
                now,
                { clearClaim: true, requireExpiredAt: now },
              )
          : row.status === "dispatching"
            ? this.transition(
                row.action_id,
                ["dispatching"],
                {
                  status: "failed",
                  errorMessage:
                    "The scheduler lease expired while this action was being dispatched. Check the thread before scheduling it again.",
                },
                now,
                { clearClaim: true, requireExpiredAt: now },
              )
            : this.transition(
                row.action_id,
                ["queued"],
                { status: "scheduled", queueEntryId: undefined },
                now,
                { clearClaim: true, requireExpiredAt: now },
              );
        return updated ? [updated] : [];
      });
    })();
  }

  cleanupTerminalBefore(cutoff: number): void {
    const rows = this.stateDb.raw.prepare(
      `SELECT action_id, payload_ref
       FROM scheduled_thread_actions
       WHERE status NOT IN ('held', 'scheduled', 'dispatching', 'queued')
         AND updated_at < ?`,
    ).all(cutoff) as Array<{
      action_id: string;
      payload_ref: string | null;
    }>;
    const remove = this.stateDb.raw.prepare(
      `DELETE FROM scheduled_thread_actions
       WHERE action_id = ? AND payload_ref = ?
         AND status NOT IN ('held', 'scheduled', 'dispatching', 'queued')`,
    );
    for (const row of rows) {
      if (!row.payload_ref) continue;
      const result = remove.run(row.action_id, row.payload_ref);
      if (result.changes === 1) this.payloadStore.delete(row.payload_ref);
    }
  }

  private transition(
    id: string,
    expectedStatuses: readonly ScheduledThreadActionStatus[],
    patch: Partial<Pick<
      ScheduledThreadAction,
      | "errorMessage"
      | "holdCause"
      | "manualReleaseRequired"
      | "queueEntryId"
      | "status"
      | "turnId"
    >>,
    now: number,
    claim?: {
      claimOwner?: string;
      claimExpiresAt?: number;
      clearClaim?: boolean;
      /** With `clearClaim`: the owner whose queue holds a held action. */
      holder?: string;
      expectedOwner?: string;
      requireExpiredAt?: number;
    },
  ): ScheduledThreadAction | undefined {
    const current = this.get(id);
    if (!current || !expectedStatuses.includes(current.status)) return undefined;
    const updated: ScheduledThreadAction = { ...current, ...patch, updatedAt: now };
    const updatesPayload = patch.manualReleaseRequired !== undefined;
    const previousPayloadRef = updatesPayload ? this.readPayloadRef(id) : undefined;
    const nextPayloadRef = updatesPayload
      ? this.payloadStore.write(id, payloadFromAction(updated))
      : undefined;
    const ownerClause = claim?.expectedOwner ? " AND claim_owner = ?" : "";
    const expiredClause = claim?.requireExpiredAt !== undefined
      ? " AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)"
      : "";
    try {
      const result = this.stateDb.raw.prepare(
        `UPDATE scheduled_thread_actions
         SET status = ?, queue_entry_id = ?, turn_id = ?, error_message = ?,
             payload_ref = COALESCE(?, payload_ref), claim_owner = ?,
             claim_expires_at = ?, updated_at = ?
         WHERE action_id = ?
           AND status IN (` + expectedStatuses.map(() => "?").join(", ") + `)
           ` + ownerClause + `` + expiredClause + ``,
      ).run(
        updated.status,
        updated.queueEntryId ?? null,
        updated.turnId ?? null,
        updated.errorMessage ?? null,
        nextPayloadRef ?? null,
        claim?.clearClaim
          ? claim.holder ?? null
          : claim?.claimOwner ?? this.readClaimOwner(id),
        claim?.clearClaim
          ? null
          : claim?.claimExpiresAt ?? this.readClaimExpiresAt(id),
        updated.updatedAt,
        id,
        ...expectedStatuses,
        ...(claim?.expectedOwner ? [claim.expectedOwner] : []),
        ...(claim?.requireExpiredAt !== undefined ? [claim.requireExpiredAt] : []),
      );
      if (result.changes !== 1) {
        if (nextPayloadRef) this.payloadStore.delete(nextPayloadRef);
        return undefined;
      }
      if (previousPayloadRef) this.payloadStore.delete(previousPayloadRef);
      return updated;
    } catch (error) {
      if (nextPayloadRef) this.payloadStore.delete(nextPayloadRef);
      throw error;
    }
  }

  private write(action: ScheduledThreadAction): void {
    const payloadRef = this.payloadStore.write(action.id, payloadFromAction(action));
    const columns = this.hasLegacyPayloadColumn
      ? `${ROW_COLUMNS}, payload`
      : ROW_COLUMNS;
    const placeholders = this.hasLegacyPayloadColumn
      ? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
      : "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
    try {
      this.stateDb.raw.prepare(
        `INSERT INTO scheduled_thread_actions(` + columns + `) VALUES (` + placeholders + `)`,
      ).run(
        action.id,
        action.backend,
        action.threadId,
        action.kind,
        action.origin,
        action.status,
        action.scheduledFor,
        action.queueEntryId ?? null,
        action.turnId ?? null,
        action.errorMessage ?? null,
        payloadRef,
        null,
        null,
        action.createdAt,
        action.updatedAt,
        ...(this.hasLegacyPayloadColumn ? ["{}"] : []),
      );
    } catch (error) {
      this.payloadStore.delete(payloadRef);
      throw error;
    }
  }

  private actionFromRow(row: ScheduledThreadActionRow, maxBytes?: number): ScheduledThreadAction {
    if (!row.payload_ref) {
      throw new Error(`Scheduled action ${row.action_id} has no payload reference.`);
    }
    return {
      ...this.payloadStore.read(row.payload_ref, maxBytes),
      id: row.action_id,
      backend: row.backend,
      threadId: row.thread_id,
      kind: row.kind,
      origin: row.origin,
      status: row.status,
      scheduledFor: row.scheduled_for,
      queueEntryId: row.queue_entry_id ?? undefined,
      turnId: row.turn_id ?? undefined,
      errorMessage: row.error_message ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readPayloadRef(id: string): string {
    const row = this.stateDb.raw.prepare(
      "SELECT payload_ref FROM scheduled_thread_actions WHERE action_id = ?",
    ).get(id) as { payload_ref: string | null } | undefined;
    if (!row?.payload_ref) throw new Error("Scheduled action payload not found.");
    return row.payload_ref;
  }

  private readClaimOwner(id: string): string | null {
    return (this.stateDb.raw.prepare(
      "SELECT claim_owner FROM scheduled_thread_actions WHERE action_id = ?",
    ).get(id) as { claim_owner: string | null } | undefined)?.claim_owner ?? null;
  }

  private readClaimExpiresAt(id: string): number | null {
    return (this.stateDb.raw.prepare(
      "SELECT claim_expires_at FROM scheduled_thread_actions WHERE action_id = ?",
    ).get(id) as { claim_expires_at: number | null } | undefined)
      ?.claim_expires_at ?? null;
  }

  private migrateLegacyPayloads(): void {
    if (!this.hasLegacyPayloadColumn) return;
    const rows = this.stateDb.raw.prepare(
      `SELECT action_id, payload_ref, payload
       FROM scheduled_thread_actions`,
    ).all() as Array<{
      action_id: string;
      payload_ref: string | null;
      payload: string;
    }>;
    for (const row of rows) {
      if (row.payload_ref) {
        if (row.payload !== "{}") {
          this.stateDb.raw.prepare(
            "UPDATE scheduled_thread_actions SET payload = '{}' WHERE action_id = ?",
          ).run(row.action_id);
        }
        continue;
      }
      const legacy = JSON.parse(row.payload) as ScheduledThreadAction;
      const payloadRef = this.payloadStore.write(
        row.action_id,
        payloadFromAction(legacy),
      );
      try {
        const migrated = this.stateDb.raw.prepare(
          `UPDATE scheduled_thread_actions
           SET payload_ref = ?, turn_id = ?, error_message = ?, payload = '{}'
           WHERE action_id = ? AND payload_ref IS NULL`,
        ).run(
          payloadRef,
          legacy.turnId ?? null,
          legacy.errorMessage ?? null,
          row.action_id,
        );
        if (migrated.changes !== 1) this.payloadStore.delete(payloadRef);
      } catch (error) {
        this.payloadStore.delete(payloadRef);
        throw error;
      }
    }
  }
}

function payloadFromAction(
  action: ScheduledThreadAction,
): ScheduledThreadActionPayload {
  return {
    displayText: action.displayText,
    imageAttachments: action.imageAttachments,
    fileAttachments: action.fileAttachments,
    manualReleaseRequired: action.manualReleaseRequired,
    holdCause: action.holdCause,
    turn: action.turn,
    review: action.review,
  };
}
