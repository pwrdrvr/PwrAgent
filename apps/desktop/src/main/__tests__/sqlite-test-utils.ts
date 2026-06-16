import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateDb } from "../state/state-db";

export function openInMemoryStateDb(): StateDb {
  return StateDb.open(":memory:");
}

export function createTempStateDb(prefix: string): {
  dbPath: string;
  tempDir: string;
} {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dbPath: path.join(tempDir, "state.db"),
    tempDir,
  };
}

export function removeTempStateDbDir(tempDir: string): void {
  rmSync(tempDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
