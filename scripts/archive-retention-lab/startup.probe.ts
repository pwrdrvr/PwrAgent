// Opt-in diagnostic: this test never opens the live profile.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { StateDb } from "../../apps/desktop/src/main/state/state-db";

it("measures current startup and a legacy conversion on private copies", () => {
  const root = path.resolve(".local/archive-retention");
  const results = [];
  for (const legacy of [false, true]) {
    const file = path.join(root, legacy ? "startup-legacy.db" : "startup.db");
    expect(fs.existsSync(file)).toBe(false);
    fs.copyFileSync(path.join(root, "baseline.db"), file);
    if (legacy) {
      const fixture = StateDb.open(file);
      fixture.raw.pragma("auto_vacuum=NONE");
      fixture.raw.exec("VACUUM");
      expect(fixture.raw.pragma("auto_vacuum", { simple: true })).toBe(0);
      fixture.close();
    }
    const openStart = performance.now();
    const state = StateDb.open(file);
    const openMs = performance.now() - openStart;
    state.raw.pragma("wal_autocheckpoint=0");
    state.raw.pragma("wal_checkpoint(TRUNCATE)");
    const start = performance.now();
    const conversion = state.startGc();
    const gcMs = performance.now() - start;
    const bytes = fs.statSync(file + "-wal").size;
    const freePages = state.raw.pragma("freelist_count", { simple: true });
    expect(state.raw.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(state.raw.pragma("foreign_key_check")).toEqual([]);
    results.push({ legacy, openMs, gcMs, conversion, walBytes: bytes, freePages });
    state.close();
  }
  fs.writeFileSync(path.join(root, "startup.json"), JSON.stringify(results, null, 2));
}, 30_000);
