import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getNativeBinding } from "../state/native-binding";
import { StateDb } from "../state/state-db";
import {
  ensureProfileExists,
  getProcessRuntimeIdentity,
  resolveActiveProfilePath,
  resetCachedActiveProfileNameForTests,
  startProfileRuntimeHeartbeat,
  updateLastUsed,
} from "../profile";
import { migrateIfNeeded } from "../state/migration";
import { initializeAppState, resetAppStateForTests } from "../state/app-state";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { AutomationStore } from "../automations/automation-store";
import { ScheduledThreadActionStore } from "../scheduled-actions/scheduled-thread-action-store";

const rows: string[] = [];
const time = (label: string, reps: number, fn: () => void): void => {
  const t = performance.now();
  for (let i = 0; i < reps; i += 1) fn();
  const each = (performance.now() - t) / reps;
  rows.push(`${label.padEnd(46)} ${each.toFixed(1).padStart(9)} ms`);
};

const nb = getNativeBinding();
const newDb = (p: string) => new Database(p, nb ? { nativeBinding: nb } : {});

describe("PROBE", () => {
  it("measures", () => {
    rows.push(`platform=${process.platform} tmpdir=${os.tmpdir()} cwd=${process.cwd()}`);

    // --- filesystem primitives -------------------------------------------
    time("fs: mkdtemp + rmSync(empty dir)", 5, () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
      fs.rmSync(d, { recursive: true, force: true });
    });
    time("fs: mkdtemp + 10x4KB files + rmSync", 5, () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
      for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(d, `f${i}`), "x".repeat(4096));
      fs.rmSync(d, { recursive: true, force: true });
    });
    time("fs: mkdtemp + one 8MB file + rmSync", 5, () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
      fs.writeFileSync(path.join(d, "big"), Buffer.alloc(8 * 1024 * 1024, 1));
      fs.rmSync(d, { recursive: true, force: true });
    });

    // --- raw better-sqlite3 ----------------------------------------------
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "probe-sqlite-"));
    let n = 0;
    time("sqlite: new Database + close (no pragmas)", 5, () => {
      const p = path.join(scratch, `raw${n++}.db`);
      const db = newDb(p);
      db.exec("CREATE TABLE t(a)");
      db.close();
    });
    time("sqlite: + journal_mode=WAL", 5, () => {
      const p = path.join(scratch, `wal${n++}.db`);
      const db = newDb(p);
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE t(a)");
      db.close();
    });
    time("sqlite: 20000-row insert txn (WAL)", 3, () => {
      const p = path.join(scratch, `bulk${n++}.db`);
      const db = newDb(p);
      db.pragma("journal_mode = WAL");
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec("CREATE TABLE bulk(id INTEGER PRIMARY KEY, blob TEXT)");
      const ins = db.prepare("INSERT INTO bulk(blob) VALUES (?)");
      db.transaction(() => {
        for (let i = 0; i < 20000; i += 1) ins.run("x".repeat(400));
      })();
      db.close();
    });
    time("sqlite: 2000-row insert txn (WAL)", 3, () => {
      const p = path.join(scratch, `bulk2${n++}.db`);
      const db = newDb(p);
      db.pragma("journal_mode = WAL");
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec("CREATE TABLE bulk(id INTEGER PRIMARY KEY, blob TEXT)");
      const ins = db.prepare("INSERT INTO bulk(blob) VALUES (?)");
      db.transaction(() => {
        for (let i = 0; i < 2000; i += 1) ins.run("x".repeat(400));
      })();
      db.close();
    });
    time("sqlite: DELETE 18000 of 20000 rows", 3, () => {
      const p = path.join(scratch, `del${n++}.db`);
      const db = newDb(p);
      db.pragma("journal_mode = WAL");
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec("CREATE TABLE bulk(id INTEGER PRIMARY KEY, blob TEXT)");
      const ins = db.prepare("INSERT INTO bulk(blob) VALUES (?)");
      db.transaction(() => {
        for (let i = 0; i < 20000; i += 1) ins.run("x".repeat(400));
      })();
      const t = performance.now();
      db.prepare("DELETE FROM bulk WHERE id % 10 != 0").run();
      rows.push(`  (inner) DELETE only: ${(performance.now() - t).toFixed(1)} ms`);
      db.close();
    });

    // --- StateDb ----------------------------------------------------------
    time("StateDb.open FRESH + close", 5, () => {
      const p = path.join(scratch, `sdb${n++}.db`);
      StateDb.open(p).close();
    });
    const reopenPath = path.join(scratch, "reopen.db");
    StateDb.open(reopenPath).close();
    time("StateDb.open EXISTING + close", 5, () => {
      StateDb.open(reopenPath).close();
    });
    time("StateDb.startGc()", 5, () => {
      const p = path.join(scratch, `gc${n++}.db`);
      const db = StateDb.open(p);
      db.startGc();
      db.close();
    });
    time("new SqliteMessagingStore(db)", 5, () => {
      const db = StateDb.open(reopenPath);
      new SqliteMessagingStore(db);
      db.close();
    });
    time("all 5 store constructors", 5, () => {
      const db = StateDb.open(reopenPath);
      new SqliteMessagingStore(db);
      new SqliteOverlayStore(db);
      new AppRuntimeInstanceStore(db);
      new AutomationStore(db);
      new ScheduledThreadActionStore(db);
      db.close();
    });
    fs.rmSync(scratch, { recursive: true, force: true });

    // --- app-state pieces -------------------------------------------------
    const withHome = (fn: (home: string) => void): void => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "probe-home-"));
      process.env.PWRAGENT_HOME = home;
      resetCachedActiveProfileNameForTests();
      try {
        fn(home);
      } finally {
        resetAppStateForTests();
        delete process.env.PWRAGENT_HOME;
        fs.rmSync(home, { recursive: true, force: true });
      }
    };

    time("profile: ensureProfileExists", 5, () => {
      withHome(() => { ensureProfileExists(); });
    });
    time("profile: ensure + migrateIfNeeded", 5, () => {
      withHome(() => { ensureProfileExists(); migrateIfNeeded(); });
    });
    time("profile: ensure + migrate + StateDb.open", 5, () => {
      withHome(() => {
        ensureProfileExists();
        migrateIfNeeded();
        StateDb.open(resolveActiveProfilePath("state/state.db")).close();
      });
    });
    time("profile: updateLastUsed", 5, () => {
      withHome(() => { ensureProfileExists(); updateLastUsed("default"); });
    });
    time("profile: heartbeat start+stop", 5, () => {
      withHome(() => {
        ensureProfileExists();
        const id = getProcessRuntimeIdentity();
        startProfileRuntimeHeartbeat("default", {
          instanceId: id.instanceId,
          startedAt: id.startedAt,
        }).stop();
      });
    });
    time("FULL initializeAppState cycle", 5, () => {
      withHome(() => { initializeAppState(); });
    });
    time("mkdtemp home + rmSync only (baseline)", 5, () => {
      withHome(() => {});
    });

    console.log("\n===PROBE-BEGIN===\n" + rows.join("\n") + "\n===PROBE-END===\n");
    expect(true).toBe(true);
  }, 600_000);
});
