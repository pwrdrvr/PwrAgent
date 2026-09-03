import path from "node:path";
import type {
  ListScheduledThreadActionsRequest,
  ScheduledThreadAction,
  ScheduledThreadActionKind,
  ScheduledThreadActionOrigin,
  ScheduledThreadActionStatus,
  ScheduledThreadReviewPayload,
  ScheduledThreadTurnPayload,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";
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

type CreateScheduledThreadActionRecord = {
  id: string;
  backend: ScheduledThreadAction["backend"];
  threadId: string;
  kind: ScheduledThreadActionKind;
  origin: ScheduledThreadActionOrigin;
  scheduledFor: number;
  displayText: string;
  imageAttachments?: ScheduledThreadAction["imageAttachments"];
  fileAttachments?: ScheduledThreadAction["fileAttachments"];
  manualReleaseRequired?: boolean;
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
  now: number;
};

type UpdateScheduledThreadActionRecord = {
  scheduledFor?: number;
  displayText?: string;
  imageAttachments?: ScheduledThreadAction["imageAttachments"];
  fileAttachments?: ScheduledThreadAction["fileAttachments"];
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
  now: number;
};

type ClaimParams = {
  now: number;
  ownerId: string;
  leaseExpiresAt: number;
};

const ACTIVE_STATUSES: readonly ScheduledThreadActionStatus[] = [
  "held",
  "scheduled",
  "dispatching",
  "queued",
];
const ROW_COLUMNS = `
  action_id, backend, thread_id, kind, origin, status, scheduled_for,
  queue_entry_id, turn_id, error_message, payload_ref, claim_owner,
  claim_expires_at, created_at, updated_at
`;

export class ScheduledThreadActionStore {
  private readonly payloadStore: ScheduledThreadActionPayloadStore;
  private readonly hasLegacyPayloadColumn: boolean;

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

  get(id: string): ScheduledThreadAction | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM scheduled_thread_actions WHERE action_id = ?`,
      )
      .get(id) as ScheduledThreadActionRow | undefined;
    return row ? this.actionFromRow(row) : undefined;
  }

  getByQueueEntryId(queueEntryId: string): ScheduledThreadAction | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM scheduled_thread_actions WHERE queue_entry_id = ?`,
      )
      .get(queueEntryId) as ScheduledThreadActionRow | undefined;
    return row ? this.actionFromRow(row) : undefined;
  }

  list(request: ListScheduledThreadActionsRequest = {}): ScheduledThreadAction[] {
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
    const rows = this.stateDb.raw
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM scheduled_thread_actions
         ${clause}
         ORDER BY scheduled_for ASC, created_at ASC`,
      )
      .all(...values) as ScheduledThreadActionRow[];
    return rows.map((row) => this.actionFromRow(row));
  }

  nextScheduledAt(): number | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT scheduled_for
         FROM scheduled_thread_actions
         WHERE status = 'scheduled'
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

  claim(id: string, params: ClaimParams): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["held", "scheduled"],
      { status: "dispatching" },
      params.now,
      {
        claimOwner: params.ownerId,
        claimExpiresAt: params.leaseExpiresAt,
      },
    );
  }

  claimNextDue(params: ClaimParams): ScheduledThreadAction | undefined {
    return this.stateDb.raw.transaction(() => {
      const row = this.stateDb.raw.prepare(
        `SELECT action_id
         FROM scheduled_thread_actions
         WHERE status = 'scheduled' AND scheduled_for <= ?
         ORDER BY scheduled_for ASC, created_at ASC
         LIMIT 1`,
      ).get(params.now) as { action_id: string } | undefined;
      return row ? this.claim(row.action_id, params) : undefined;
    })();
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
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching", "queued"],
      { status: "held", queueEntryId, errorMessage },
      now,
      { clearClaim: true, expectedOwner: ownerId },
    );
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
        `SELECT action_id, claim_owner, status
         FROM scheduled_thread_actions
         WHERE status IN ('dispatching', 'queued')
           AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
      ).all(now) as Array<{
        action_id: string;
        claim_owner: string | null;
        status: "dispatching" | "queued";
      }>;
      return rows.flatMap((row) => {
        if (
          row.claim_owner
          && protectedOwnerIds.has(row.claim_owner)
        ) return [];
        const current = this.get(row.action_id);
        const updated = current?.manualReleaseRequired
          ? this.transition(
              row.action_id,
              ["dispatching", "queued"],
              { status: "held", queueEntryId: undefined },
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
      "errorMessage" | "queueEntryId" | "status" | "turnId"
    >>,
    now: number,
    claim?: {
      claimOwner?: string;
      claimExpiresAt?: number;
      clearClaim?: boolean;
      expectedOwner?: string;
      requireExpiredAt?: number;
    },
  ): ScheduledThreadAction | undefined {
    const current = this.get(id);
    if (!current || !expectedStatuses.includes(current.status)) return undefined;
    const updated: ScheduledThreadAction = { ...current, ...patch, updatedAt: now };
    const ownerClause = claim?.expectedOwner ? " AND claim_owner = ?" : "";
    const expiredClause = claim?.requireExpiredAt !== undefined
      ? " AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)"
      : "";
    const result = this.stateDb.raw.prepare(
      `UPDATE scheduled_thread_actions
       SET status = ?, queue_entry_id = ?, turn_id = ?, error_message = ?,
           claim_owner = ?, claim_expires_at = ?, updated_at = ?
       WHERE action_id = ?
         AND status IN (${expectedStatuses.map(() => "?").join(", ")})
         ${ownerClause}${expiredClause}`,
    ).run(
      updated.status,
      updated.queueEntryId ?? null,
      updated.turnId ?? null,
      updated.errorMessage ?? null,
      claim?.clearClaim ? null : claim?.claimOwner ?? this.readClaimOwner(id),
      claim?.clearClaim
        ? null
        : claim?.claimExpiresAt ?? this.readClaimExpiresAt(id),
      updated.updatedAt,
      id,
      ...expectedStatuses,
      ...(claim?.expectedOwner ? [claim.expectedOwner] : []),
      ...(claim?.requireExpiredAt !== undefined ? [claim.requireExpiredAt] : []),
    );
    return result.changes === 1 ? updated : undefined;
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
        `INSERT INTO scheduled_thread_actions(${columns}) VALUES (${placeholders})`,
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

  private actionFromRow(row: ScheduledThreadActionRow): ScheduledThreadAction {
    if (!row.payload_ref) {
      throw new Error(`Scheduled action ${row.action_id} has no payload reference.`);
    }
    return {
      ...this.payloadStore.read(row.payload_ref),
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
    turn: action.turn,
    review: action.review,
  };
}
