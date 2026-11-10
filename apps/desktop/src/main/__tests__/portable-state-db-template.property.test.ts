import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";

// Import only the implementation the portable bindings use. Importing the
// desktop compatibility module would accidentally install its old mock first.
it("portable imports receive independent template databases equivalent to the real opener", () => {
  const original = (StateDb as typeof StateDb & { [key: symbol]: typeof StateDb.open })[Symbol.for("pwragent.test.stateDbOriginalOpen")];
  expect(original).toBeTypeOf("function");
  const describe = (db: StateDb) => ({
    schema: db.raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all(),
    version: db.raw.pragma("user_version", { simple: true }),
    foreignKeys: db.raw.pragma("foreign_keys", { simple: true }),
    journal: db.raw.pragma("journal_mode", { simple: true }),
  });
  fc.assert(fc.property(fc.boolean(), fc.constantFrom("fixture", "work"), (memory, profileName) => {
    const root = mkdtempSync(path.join(tmpdir(), "pa-portable-template-"));
    const first = StateDb.open(memory ? ":memory:" : path.join(root, "first.db"), { profileName });
    const second = StateDb.open(memory ? ":memory:" : path.join(root, "second.db"), { profileName });
    const fresh = original!(memory ? ":memory:" : path.join(root, "fresh.db"), { profileName });
    try {
      expect(describe(first)).toEqual(describe(fresh));
      first.raw.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("isolated-template-probe", "private");
      expect(second.getMeta("isolated-template-probe")).toBeUndefined();
    } finally { first.close(); second.close(); fresh.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 12 });
});
