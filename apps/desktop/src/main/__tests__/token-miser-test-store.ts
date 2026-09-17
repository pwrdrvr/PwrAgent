import { rmSync } from "node:fs";
import { afterEach } from "vitest";
import { StateDb } from "../state/state-db";
import { TokenMiserStore, type TokenMiserStoreOptions } from "../token-miser/token-miser-store";

const databases: Array<{ db: StateDb; path: string }> = [];
afterEach(() => {
  const opened = databases.splice(0);
  for (const entry of opened) entry.db.close();
  for (const file of new Set(opened.map((entry) => entry.path))) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  }
});

/** File-backed connections exercise visibility and restart semantics. */
export class TestTokenMiserStore extends TokenMiserStore {
  readonly stateDb: StateDb;
  constructor(root: string, options: Omit<TokenMiserStoreOptions, "stateDb"> = {}) {
    const dbPath = `${root}.sqlite`;
    const stateDb = StateDb.open(dbPath);
    databases.push({ db: stateDb, path: dbPath });
    super(root, { ...options, stateDb });
    this.stateDb = stateDb;
  }
}
