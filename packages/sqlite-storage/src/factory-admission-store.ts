import { factoryAdmissionKey, type FactoryAdmissionRow, type FactoryAdmissionStore, type FactoryAdmissionSubject } from "@pwragent/owner-core/factory-admission";
import type { StateDb } from "./state-db";

export class SqliteFactoryAdmissionStore implements FactoryAdmissionStore {
  constructor(private readonly state: StateDb) {}

  read(subject: FactoryAdmissionSubject): FactoryAdmissionRow | undefined {
    // The existing issue_id column holds raw Linear IDs and namespaced keys for other trackers.
    const row = this.state.raw.prepare("SELECT row_json FROM factory_admission WHERE project_key = ? AND issue_id = ?")
      .get(subject.projectKey, factoryAdmissionKey(subject)) as { row_json: string } | undefined;
    return row ? JSON.parse(row.row_json) as FactoryAdmissionRow : undefined;
  }

  insert(row: FactoryAdmissionRow): boolean {
    return this.durable(() => this.state.raw.prepare(`
      INSERT INTO factory_admission (project_key, issue_id, active, revision, row_json)
      VALUES (?, ?, 1, ?, ?) ON CONFLICT DO NOTHING
    `).run(row.projectKey, factoryAdmissionKey(row), row.revision, JSON.stringify(row)).changes === 1);
  }

  update(previous: FactoryAdmissionRow, next: FactoryAdmissionRow): void {
    const changed = this.durable(() => this.state.raw.prepare(`
      UPDATE factory_admission SET active = ?, revision = ?, row_json = ?
      WHERE project_key = ? AND issue_id = ? AND revision = ?
    `).run(Number(next.phase !== "terminal"), next.revision, JSON.stringify(next),
      previous.projectKey, factoryAdmissionKey(previous), previous.revision).changes);
    if (changed !== 1) throw new Error("Factory state changed. Retry the command.");
  }

  private durable<T>(write: () => T): T {
    const db = this.state.raw;
    const synchronous = db.pragma("synchronous", { simple: true }) as number;
    // Intent and terminal proof must survive a crash before the next effect.
    db.pragma("synchronous = FULL");
    try { return db.transaction(write).immediate(); }
    finally { db.pragma(`synchronous = ${synchronous}`); }
  }
}
