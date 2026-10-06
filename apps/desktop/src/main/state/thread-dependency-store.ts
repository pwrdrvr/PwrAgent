import type Database from "better-sqlite3";
import type { ThreadDependency } from "@pwragent/shared";

export const THREAD_DEPENDENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_dependencies (
  dependency_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_dependencies_consumer
  ON thread_dependencies(backend, thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_thread_dependencies_active
  ON thread_dependencies(status) WHERE status IN ('waiting', 'ready', 'dispatching');
`;

function key(backend: string, threadId: string): string {
  return JSON.stringify([backend, threadId]);
}

function signature(dependency: ThreadDependency): string {
  return JSON.stringify([
    dependency.backend, dependency.threadId, dependency.mode,
    dependency.onFailure, dependency.continuation ?? "",
    dependency.conditions.map((condition) => JSON.stringify([
      condition.backend, condition.threadId, condition.when,
      condition.turnId ?? "", condition.prUrl ?? "", condition.headSha ?? "",
    ])).sort(),
  ]);
}

export class ThreadDependencyStore {
  constructor(private readonly db: Database.Database) {}

  active(): ThreadDependency[] {
    return this.decode(this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE status IN ('waiting', 'ready', 'dispatching')",
    ).all());
  }

  list(backend: string, threadId: string): ThreadDependency[] {
    return this.decode(this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE backend = ? AND thread_id = ? ORDER BY CASE WHEN status IN ('waiting', 'ready', 'dispatching') THEN 0 ELSE 1 END, created_at DESC LIMIT 132",
    ).all(backend, threadId));
  }

  /** Active registrations elsewhere that name this thread as a prerequisite. */
  dependents(backend: string, threadId: string): ThreadDependency[] {
    const target = key(backend, threadId);
    return this.active()
      .filter((item) => item.conditions.some((condition) => key(condition.backend, condition.threadId) === target))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  get(backend: string, threadId: string, id: string): ThreadDependency | undefined {
    const row = this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE dependency_id = ? AND backend = ? AND thread_id = ?",
    ).get(id, backend, threadId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ThreadDependency : undefined;
  }

  hasDeliveryReceipt(item: ThreadDependency): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM thread_message_origins WHERE backend = ? AND thread_id = ? AND json_extract(payload, '$.dependencyId') = ? LIMIT 1",
    ).get(item.backend, item.threadId, item.id));
  }

  register(candidate: ThreadDependency): ThreadDependency {
    return this.db.transaction(() => {
      const active = this.active();
      const duplicate = active.find((item) => signature(item) === signature(candidate));
      if (duplicate) return duplicate;
      if (active.length >= 512) throw new Error("There are already 512 active dependencies. Cancel an existing dependency first.");
      if (active.filter((item) => item.backend === candidate.backend && item.threadId === candidate.threadId).length >= 32) throw new Error("This thread already has 32 active dependencies. Cancel an existing dependency first.");
      const edges = new Map<string, Set<string>>();
      for (const item of [...active, candidate]) {
        const consumer = key(item.backend, item.threadId);
        const targets = edges.get(consumer) ?? new Set<string>();
        item.conditions.forEach((condition) => targets.add(key(condition.backend, condition.threadId)));
        edges.set(consumer, targets);
      }
      const consumer = key(candidate.backend, candidate.threadId);
      const reachesConsumer = (node: string, seen: Set<string>): boolean => {
        if (node === consumer) return true;
        if (seen.has(node)) return false;
        seen.add(node);
        return [...(edges.get(node) ?? [])].some((target) => reachesConsumer(target, seen));
      };
      if (candidate.conditions.some((condition) => reachesConsumer(key(condition.backend, condition.threadId), new Set()))) {
        throw new Error("This dependency would create a thread dependency cycle.");
      }
      this.db.prepare(
        "INSERT INTO thread_dependencies(dependency_id, backend, thread_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(candidate.id, candidate.backend, candidate.threadId, candidate.status, candidate.createdAt, JSON.stringify(candidate));
      return candidate;
    }).immediate();
  }

  /** Compare-and-swap also arbitrates dispatch across processes sharing a profile. */
  replace(previous: ThreadDependency, next: ThreadDependency): boolean {
    if (JSON.stringify(previous) === JSON.stringify(next)) return true;
    return this.db.prepare(
      "UPDATE thread_dependencies SET status = ?, payload = ? WHERE dependency_id = ? AND payload = ?",
    ).run(next.status, JSON.stringify(next), previous.id, JSON.stringify(previous)).changes === 1;
  }

  cancel(backend: string, threadId: string, id: string, now: number): ThreadDependency {
    const item = this.get(backend, threadId, id);
    if (!item) throw new Error("Dependency not found for this thread.");
    if (item.status === "dispatching" || item.status === "delivered") {
      throw new Error("The continuation has already been admitted and cannot be cancelled here.");
    }
    if (item.status === "cancelled") return item;
    const next = { ...item, status: "cancelled" as const, updatedAt: now };
    if (!this.replace(item, next)) {
      throw new Error("Dependency changed while cancelling. Read its current state first.");
    }
    return next;
  }

  dismiss(backend: string, threadId: string, id: string, now: number): ThreadDependency {
    const item = this.get(backend, threadId, id);
    if (!item || item.status !== "dispatching" || !item.error) throw new Error("Only an uncertain delivery can be dismissed after review.");
    const next = { ...item, status: "dismissed" as const, updatedAt: now };
    if (!this.replace(item, next)) throw new Error("Dependency changed while dismissing. Read its current state first.");
    return next;
  }

  private decode(rows: unknown[]): ThreadDependency[] {
    return rows.map((row) => JSON.parse((row as { payload: string }).payload) as ThreadDependency);
  }
}
