import path from "node:path";
import { afterEach } from "vitest";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { TokenMiserStore, type TokenMiserStoreOptions } from "../token-miser/token-miser-store";

const databases: StateDb[] = [];
const databasePaths = new Map<string, string>();
const databaseDirectories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of databaseDirectories.splice(0)) removeTempStateDbDir(directory);
  databasePaths.clear();
});

/** File-backed connections exercise visibility and restart semantics. */
export class TestTokenMiserStore extends TokenMiserStore {
  readonly stateDb: StateDb;
  constructor(root: string, options: Omit<TokenMiserStoreOptions, "stateDb"> = {}) {
    // Nested suite hooks can remove caller directories before our hook runs.
    // Own the database directory so Windows always sees close before deletion.
    const key = path.resolve(root);
    let dbPath = databasePaths.get(key);
    if (!dbPath) {
      const fixture = createTempStateDb("pwragent-miser-test-db-");
      databaseDirectories.push(fixture.tempDir);
      dbPath = fixture.dbPath;
      databasePaths.set(key, dbPath);
    }
    const stateDb = StateDb.open(dbPath);
    databases.push(stateDb);
    super(root, { ...options, stateDb });
    this.stateDb = stateDb;
  }
}
