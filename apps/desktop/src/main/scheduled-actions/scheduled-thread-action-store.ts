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

type ScheduledThreadActionRow = {
  action_id: string;
  backend: ScheduledThreadAction["backend"];
  thread_id: string;
  kind: ScheduledThreadActionKind;
  origin: ScheduledThreadActionOrigin;
  status: ScheduledThreadActionStatus;
  scheduled_for: number;
  queue_entry_id: string | null;
  created_at: number;
  updated_at: number;
  payload: string;
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

const ACTIVE_STATUSES: readonly ScheduledThreadActionStatus[] = [
  "scheduled",
  "dispatching",
  "queued",
];

export class ScheduledThreadActionStore {
  constructor(private readonly stateDb: StateDb) {}

  create(input: CreateScheduledThreadActionRecord): ScheduledThreadAction {
    const action: ScheduledThreadAction = {
      id: input.id,
      backend: input.backend,
      threadId: input.threadId,
      kind: input.kind,
      origin: input.origin,
      status: "scheduled",
      scheduledFor: input.scheduledFor,
      displayText: input.displayText,
      imageAttachments: input.imageAttachments,
      fileAttachments: input.fileAttachments,
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
      .prepare("SELECT * FROM scheduled_thread_actions WHERE action_id = ?")
      .get(id) as ScheduledThreadActionRow | undefined;
    return row ? actionFromRow(row) : undefined;
  }

  getByQueueEntryId(queueEntryId: string): ScheduledThreadAction | undefined {
    const row = this.stateDb.raw
      .prepare(
        "SELECT * FROM scheduled_thread_actions WHERE queue_entry_id = ?",
      )
      .get(queueEntryId) as ScheduledThreadActionRow | undefined;
    return row ? actionFromRow(row) : undefined;
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
    if (!request.includeTerminal) {
      where.push(`status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`);
      values.push(...ACTIVE_STATUSES);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.stateDb.raw
      .prepare(
        `SELECT * FROM scheduled_thread_actions
         ${clause}
         ORDER BY scheduled_for ASC, created_at ASC`,
      )
      .all(...values) as ScheduledThreadActionRow[];
    return rows.map(actionFromRow);
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
    if (!current || current.status !== "scheduled") {
      return undefined;
    }
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
    const result = this.stateDb.raw
      .prepare(
        `UPDATE scheduled_thread_actions
         SET scheduled_for = ?, updated_at = ?, payload = ?
         WHERE action_id = ? AND status = 'scheduled'`,
      )
      .run(
        updated.scheduledFor,
        updated.updatedAt,
        JSON.stringify(updated),
        id,
      );
    return result.changes === 1 ? updated : undefined;
  }

  cancel(id: string, now: number): ScheduledThreadAction | undefined {
    return this.transition(id, ["scheduled"], { status: "cancelled" }, now);
  }

  claim(id: string, now: number): ScheduledThreadAction | undefined {
    return this.transition(id, ["scheduled"], { status: "dispatching" }, now);
  }

  claimDue(params: { now: number; limit?: number }): ScheduledThreadAction[] {
    const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
    return this.stateDb.raw.transaction(() => {
      const rows = this.stateDb.raw
        .prepare(
          `SELECT action_id
           FROM scheduled_thread_actions
           WHERE status = 'scheduled' AND scheduled_for <= ?
           ORDER BY scheduled_for ASC, created_at ASC
           LIMIT ?`,
        )
        .all(params.now, limit) as Array<{ action_id: string }>;
      const claimed: ScheduledThreadAction[] = [];
      for (const row of rows) {
        const action = this.claim(row.action_id, params.now);
        if (action) claimed.push(action);
      }
      return claimed;
    })();
  }

  markQueued(
    id: string,
    queueEntryId: string,
    now: number,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching"],
      { status: "queued", queueEntryId },
      now,
    );
  }

  markStarted(
    id: string,
    turnId: string | undefined,
    now: number,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching", "queued"],
      { status: "started", turnId },
      now,
    );
  }

  markFailed(
    id: string,
    errorMessage: string,
    now: number,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching", "queued"],
      { status: "failed", errorMessage },
      now,
    );
  }

  markCancelled(
    id: string,
    now: number,
  ): ScheduledThreadAction | undefined {
    return this.transition(
      id,
      ["dispatching", "queued"],
      { status: "cancelled" },
      now,
    );
  }

  failInterruptedDispatches(now: number): ScheduledThreadAction[] {
    const interrupted = this.list({ includeTerminal: true }).filter(
      (action) => action.status === "dispatching",
    );
    return interrupted.flatMap((action) => {
      const failed = this.markFailed(
        action.id,
        "PwrAgent restarted while this scheduled action was being dispatched. Check the thread before scheduling it again.",
        now,
      );
      return failed ? [failed] : [];
    });
  }

  recoverInterruptedQueues(now: number): ScheduledThreadAction[] {
    const interrupted = this.list({ includeTerminal: true }).filter(
      (action) => action.status === "queued",
    );
    return interrupted.flatMap((action) => {
      const recovered = this.transition(
        action.id,
        ["queued"],
        { status: "scheduled", queueEntryId: undefined },
        now,
      );
      return recovered ? [recovered] : [];
    });
  }

  private transition(
    id: string,
    expectedStatuses: readonly ScheduledThreadActionStatus[],
    patch: Partial<Pick<
      ScheduledThreadAction,
      "errorMessage" | "queueEntryId" | "status" | "turnId"
    >>,
    now: number,
  ): ScheduledThreadAction | undefined {
    const current = this.get(id);
    if (!current || !expectedStatuses.includes(current.status)) {
      return undefined;
    }
    const updated: ScheduledThreadAction = {
      ...current,
      ...patch,
      updatedAt: now,
    };
    const result = this.stateDb.raw
      .prepare(
        `UPDATE scheduled_thread_actions
         SET status = ?, queue_entry_id = ?, updated_at = ?, payload = ?
         WHERE action_id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})`,
      )
      .run(
        updated.status,
        updated.queueEntryId ?? null,
        updated.updatedAt,
        JSON.stringify(updated),
        id,
        ...expectedStatuses,
      );
    return result.changes === 1 ? updated : undefined;
  }

  private write(action: ScheduledThreadAction): void {
    this.stateDb.raw
      .prepare(
        `INSERT INTO scheduled_thread_actions(
           action_id, backend, thread_id, kind, origin, status,
           scheduled_for, queue_entry_id, created_at, updated_at, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.backend,
        action.threadId,
        action.kind,
        action.origin,
        action.status,
        action.scheduledFor,
        action.queueEntryId ?? null,
        action.createdAt,
        action.updatedAt,
        JSON.stringify(action),
      );
  }
}

function actionFromRow(row: ScheduledThreadActionRow): ScheduledThreadAction {
  const payload = JSON.parse(row.payload) as ScheduledThreadAction;
  return {
    ...payload,
    id: row.action_id,
    backend: row.backend,
    threadId: row.thread_id,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    scheduledFor: row.scheduled_for,
    queueEntryId: row.queue_entry_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
