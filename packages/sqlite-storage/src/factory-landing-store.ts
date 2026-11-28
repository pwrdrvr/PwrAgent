import { durableFactoryWrite, type FactoryPublicationRow } from "./factory-publication-store";
import type { StateDb } from "./state-db";

export class SqliteFactoryLandingStore {
  constructor(private readonly state: StateDb) {}

  read(approvalId: string): { revision: number; stateJson: string } | undefined {
    return this.state.raw.prepare(`
      SELECT revision, state_json AS stateJson FROM factory_landings WHERE approval_id = ?
    `).get(approvalId) as { revision: number; stateJson: string } | undefined;
  }

  compareAndSet(publication: FactoryPublicationRow, revision: number, stateJson: string): boolean {
    return durableFactoryWrite(this.state, () => {
      const { approvalId, planId, prId, prNumber } = publication;
      if (!this.state.raw.prepare(`
        SELECT 1 FROM factory_publications WHERE approval_id = ? AND plan_id = ? AND pr_id = ? AND pr_number = ?
          AND creation_state IN ('none', 'returned')
      `).get(approvalId, planId, prId, prNumber)) return false;
      if (revision === 0) {
        return this.state.raw.prepare(`
          INSERT INTO factory_landings (approval_id, revision, state_json) VALUES (?, 1, ?)
          ON CONFLICT DO NOTHING
        `).run(approvalId, stateJson).changes === 1;
      }
      return this.state.raw.prepare(`
        UPDATE factory_landings SET revision = revision + 1, state_json = ?
        WHERE approval_id = ? AND revision = ?
      `).run(stateJson, approvalId, revision).changes === 1;
    });
  }
}
