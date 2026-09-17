import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { StateDb } from "../state/state-db";
import { TokenMiserStore, type TokenMiserStoreOptions } from "../token-miser/token-miser-store";

const databases: StateDb[] = [];
const databasePaths = new Map<string, string>();
let databaseDirectory: string | undefined;
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  if (databaseDirectory) rmSync(databaseDirectory, { recursive: true, force: true });
  databaseDirectory = undefined;
  databasePaths.clear();
});

/** File-backed connections exercise visibility and restart semantics. */
export class TestTokenMiserStore extends TokenMiserStore {
  readonly stateDb: StateDb;
  constructor(root: string, options: Omit<TokenMiserStoreOptions, "stateDb"> = {}) {
    // Nested suite hooks can remove caller directories before our hook runs.
    // Own the database directory so Windows always sees close before deletion.
    databaseDirectory ??= mkdtempSync(path.join(os.tmpdir(), "pwragent-miser-test-db-"));
    const key = path.resolve(root);
    let dbPath = databasePaths.get(key);
    if (!dbPath) {
      dbPath = path.join(databaseDirectory, `${databasePaths.size}.sqlite`);
      databasePaths.set(key, dbPath);
    }
    const stateDb = StateDb.open(dbPath);
    databases.push(stateDb);
    super(root, { ...options, stateDb });
    this.stateDb = stateDb;
  }
}
