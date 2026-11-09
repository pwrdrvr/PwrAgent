import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateDb } from "../../storage/state-db";
import { SqliteOverlayStore } from "../../storage/overlay-store-sqlite";
import { RetainedOwnerThreadStore } from "../../storage/retained-owner-thread-store";
import { adoptOutpostOwnerData } from "@pwragent/sqlite-storage/legacy-outpost-owner-data";
import { SqliteOwnerJobStore } from "@pwragent/sqlite-storage/owner-job-store";

export function retainedOwnerFixture(titled: boolean | "missing" = true, ids = ["imported"]) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-retained-")));
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const identity = { version: 1 as const, workspace: root, codexHome: path.join(root, "codex") };
  writeFileSync(path.join(directory, "identity.json"), JSON.stringify(identity));
  writeFileSync(path.join(directory, "threads.json"), JSON.stringify({ version: 1, threads: ids.map(id =>
    ({ id, ...(titled === "missing" ? {} : { title: titled ? "Pending imported title" : "Untitled thread", titleSource: titled ? "derived" : "fallback" }),
      sandbox: "read-only" })) }));
  const dbPath = path.join(root, "state.db");
  const db = StateDb.open(dbPath, { profileName: "fixture" });
  adoptOutpostOwnerData(db, directory, identity);
  return { root, directory, dbPath, db, overlay: new SqliteOverlayStore(db), jobs: new SqliteOwnerJobStore(db),
    retained: new RetainedOwnerThreadStore(db, directory),
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
