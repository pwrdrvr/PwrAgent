import type { StateDb } from "./state-db";

export type FactoryPublicationRow = {
  approvalId: string;
  planId: string;
  planJson: string;
  prNumber: number | null;
  prId: string | null;
  creationState: "none" | "pending" | "returned" | "fenced" | "refused";
};

export class SqliteFactoryPublicationStore {
  constructor(private readonly state: StateDb) {}

  read(approvalId: string): FactoryPublicationRow | undefined {
    return this.state.raw.prepare(`
      SELECT approval_id AS approvalId, plan_id AS planId, plan_json AS planJson,
        pr_number AS prNumber, pr_id AS prId, creation_state AS creationState
      FROM factory_publications WHERE approval_id = ?
    `).get(approvalId) as FactoryPublicationRow | undefined;
  }

  arm(row: FactoryPublicationRow, previous?: FactoryPublicationRow): boolean {
    if (previous?.creationState === "pending") return false;
    return durableFactoryWrite(this.state, () => {
      const current = this.read(row.approvalId);
      if (current?.planId !== previous?.planId || current?.creationState !== previous?.creationState || current?.prId !== previous?.prId) return false;
      if ((row.creationState === "pending" || row.prId !== null) && this.otherCreationOwnsBranch(row)) return false;
      if (previous) return this.state.raw.prepare(`
        UPDATE OR IGNORE factory_publications
        SET plan_id = ?, plan_json = ?, pr_number = ?, pr_id = ?, creation_state = ?
        WHERE approval_id = ? AND plan_id = ? AND creation_state = ? AND pr_id IS ?
          AND NOT EXISTS (
            SELECT 1 FROM factory_landings WHERE approval_id = factory_publications.approval_id
              AND json_extract(state_json, '$.state.phase') IS NOT 'ready'
          )
      `).run(row.planId, row.planJson, row.prNumber, row.prId, row.creationState,
        row.approvalId, previous.planId, previous.creationState, previous.prId).changes === 1;
      return this.state.raw.prepare(`
        INSERT INTO factory_publications (approval_id, plan_id, plan_json, pr_number, pr_id, creation_state)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).run(row.approvalId, row.planId, row.planJson, row.prNumber, row.prId, row.creationState).changes === 1;
    });
  }

  settle(row: FactoryPublicationRow, state: FactoryPublicationRow["creationState"], pr?: { number: number; id: string }): boolean {
    return durableFactoryWrite(this.state, () => {
      const current = this.read(row.approvalId);
      if (current?.planId !== row.planId || current.creationState !== row.creationState || current.prId !== null) return false;
      if (pr && this.otherCreationOwnsBranch(row)) return false;
      return this.state.raw.prepare(`
        UPDATE OR IGNORE factory_publications SET pr_number = ?, pr_id = ?, creation_state = ?
        WHERE approval_id = ? AND plan_id = ? AND creation_state = ? AND pr_id IS NULL
      `).run(pr?.number ?? null, pr?.id ?? null, state, row.approvalId, row.planId, row.creationState).changes === 1;
    });
  }

  private otherCreationOwnsBranch(row: FactoryPublicationRow): boolean {
    return !!this.state.raw.prepare(`
      SELECT 1 FROM factory_publications
      WHERE creation_state IN ('pending', 'returned', 'fenced') AND approval_id <> ?
        AND json_extract(plan_json, '$.repositoryId') = json_extract(?, '$.repositoryId')
        AND json_extract(plan_json, '$.selection.branch') = json_extract(?, '$.selection.branch')
    `).get(row.approvalId, row.planJson, row.planJson);
  }
}

export function durableFactoryWrite<T>(state: StateDb, write: () => T): T {
  const db = state.raw;
  const synchronous = db.pragma("synchronous", { simple: true }) as number;
  db.pragma("synchronous = FULL");
  try { return db.transaction(write).immediate(); }
  finally { db.pragma(`synchronous = ${synchronous}`); }
}
