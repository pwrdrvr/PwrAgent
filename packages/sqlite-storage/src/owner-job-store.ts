import type { OwnerJobRecord, OwnerJobStorage } from "@pwragent/owner-core/owner-job-storage";
import type { StateDb } from "./state-db";

export const ACTIVE_OWNER_JOB_STATUSES = new Set(["starting", "running", "interrupting"]);
const STATUSES = new Set([...ACTIVE_OWNER_JOB_STATUSES, "queued", "completed", "failed", "interrupted", "blocked", "unknown"]);
const FIELDS = ["version", "id", "status", "fingerprint", "delivery", "threadId", "turnId", "model", "sandbox", "cwd",
  "messageOrigin", "reasoningEffort", "serviceTier", "messagingFileTools", "createdAt", "updatedAt", "finishedAt", "reason"] as const;

export function projectOwnerJob(value: OwnerJobRecord): OwnerJobRecord {
  if (value?.version !== 1 || typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id)
    || !STATUSES.has(value.status) || (value.delivery !== undefined && value.delivery !== "queued-steer")) throw new Error("Invalid headless job record");
  // Never retain a prompt, transcript or arbitrary provider response in SQLite.
  return Object.fromEntries(FIELDS.filter(field => value[field] !== undefined).map(field => [field, structuredClone(value[field])])) as OwnerJobRecord;
}

/** Acceptance and JSON retirement must survive loss of the process and OS. */
export function withOwnerDataDurability<T>(db: StateDb, work: () => T): T {
  if (db.raw.inTransaction) return work();
  const previous = db.raw.pragma("synchronous", { simple: true }) as number;
  if (previous !== 2) db.raw.pragma("synchronous = FULL");
  try { return work(); }
  finally { if (previous !== 2) db.raw.pragma(["synchronous = OFF", "synchronous = NORMAL", "synchronous = FULL", "synchronous = EXTRA"][previous]!); }
}

export class SqliteOwnerJobStore implements OwnerJobStorage {
  constructor(private readonly db: StateDb) {}

  get(id: string): OwnerJobRecord | undefined {
    const row = this.db.raw.prepare("SELECT payload FROM owner_jobs WHERE job_id = ?").get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    const record = projectOwnerJob(JSON.parse(row.payload));
    if (record.id !== id) throw new Error("Invalid headless job record identity");
    return record;
  }

  list(): OwnerJobRecord[] {
    const rows = this.db.raw.prepare("SELECT job_id, payload FROM owner_jobs ORDER BY job_id").all() as { job_id: string; payload: string }[];
    return rows.map(row => {
      const record = projectOwnerJob(JSON.parse(row.payload));
      if (record.id !== row.job_id) throw new Error("Invalid headless job record identity");
      return record;
    });
  }

  count(): number {
    return (this.db.raw.prepare("SELECT count(*) AS n FROM owner_jobs").get() as { n: number }).n;
  }

  save(job: OwnerJobRecord): OwnerJobRecord {
    const saved = projectOwnerJob(job);
    const payload = JSON.stringify(saved);
    withOwnerDataDurability(this.db, () => this.db.raw.prepare(`INSERT INTO owner_jobs(job_id, payload) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET payload = excluded.payload WHERE owner_jobs.payload <> excluded.payload`).run(saved.id, payload));
    return saved;
  }

  recover(): void {
    withOwnerDataDurability(this.db, () => this.db.raw.transaction(() => {
      for (const job of this.list()) {
        if (job.status === "queued" || ACTIVE_OWNER_JOB_STATUSES.has(job.status)) this.save({ ...job, status: "unknown",
          reason: "Daemon stopped before a terminal outcome was recorded; no work was replayed", updatedAt: new Date().toISOString() });
      }
    }).immediate());
  }
}
