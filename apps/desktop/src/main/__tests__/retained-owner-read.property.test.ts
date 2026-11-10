import fc from "fast-check";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { StateDb } from "../storage/state-db";
import { RetainedOwnerThreadStore } from "../storage/retained-owner-thread-store";
import { retainedOwnerFixture } from "./helpers/retained-owner-fixture";
import { outpostThreadProjection } from "@pwragent/sqlite-storage/legacy-outpost-owner-data";

it("matches the current owner's durable archive authority for retained imports and accepted identities", async () => {
  await fc.assert(fc.asyncProperty(fc.nat(10000), fc.array(fc.constantFrom("observe", "archive", "restore"), { maxLength: 10 }),
    async (start, commands) => {
      const f = retainedOwnerFixture(false);
      f.jobs.save({ version: 1, id: "accepted", status: "completed", fingerprint: "immutable-input", threadId: "accepted-owner",
        turnId: "confirmed-turn", createdAt: "2026-01-01T00:00:00Z" });
      try {
        for (const [index, command] of ["observe", ...commands].entries()) {
          const now = start + index;
          for (const threadId of ["imported", "accepted-owner"]) {
            const ref = { backend: "codex" as const, threadId };
            if (command === "observe") await f.overlay.observeArchivedThreads([ref], now);
            else await f.overlay.setThreadArchiveTombstone({ ...ref, ...(command === "archive" ? { archivedAt: now } : { restoredAt: now }) });
            const record = (await f.overlay.getThreadMetadata(ref))!;
            const owner = outpostThreadProjection(record);
            const retained = f.retained.list().find(thread => thread.id === threadId)!;
            expect(retained.archivedAt !== undefined).toBe(owner.archived);
            if (owner.archived) expect(retained.archivedAt).toBe(Math.max(record.archivedAt ?? -Infinity, record.archiveRetentionStartedAt ?? -Infinity));
          }
        }
      } finally { f.close(); }
    }), { numRuns: 25, examples: [[0, []], [0, ["restore", "observe"]]] });
});

// The model has two independent reasons for retention: a committed, still
// unconfirmed import and a durable acceptance with a confirmed thread identity.
it("models import confirmation and every accepted job boundary against live profile reads and reopen", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(true, false, "missing" as const), fc.array(fc.constantFrom("facts", "confirm", "retire", "name", "accept", "thread", "turn", "finish", "reopen"),
    { minLength: 1, maxLength: 18 }), async (titled, generated) => {
    const f = retainedOwnerFixture(titled);
    let confirmed = false;
    let named = false;
    let acceptedThread = false;
    let saved = false;
    let seen = 0;
    let job = { version: 1 as const, id: "accepted", status: "starting" as "starting" | "running" | "completed",
      fingerprint: "immutable-input", createdAt: "2026-01-01T00:00:00Z", threadId: undefined as string | undefined, turnId: undefined as string | undefined };
    try {
      await f.overlay.updateThreadMetadata({ backend: "claude", threadId: "imported" }, { title: { text: "Other backend", source: "explicit" } });
      for (const operation of ["facts", "accept", "thread", "turn", "finish", ...generated]) {
        if (operation === "facts") {
          seen++;
          await f.overlay.updateThreadMetadata({ backend: "codex", threadId: "imported" }, { pinnedRank: String(seen), seenAt: seen + 10,
            seenUpdatedAt: seen, model: "saved-model", fastMode: true, parent: { backend: "claude", threadId: "parent" } });
        } else if (operation === "confirm" || operation === "retire") {
          confirmed = true;
          if (operation === "confirm") f.retained.confirmNativeThreads(["imported"]);
          else await f.overlay.updateThreadMetadata({ backend: "codex", threadId: "imported" }, { nativeMembershipRetired: true });
        } else if (operation === "name") {
          named = true;
          await f.overlay.updateThreadMetadata({ backend: "codex", threadId: "imported" }, { title: { text: "Published title", source: "derived", nativeName: "Published title" } });
        } else if (operation === "accept") {
          // A receipt without a provider thread cannot manufacture an owner.
          f.jobs.save(job); saved = true;
        } else if (operation === "thread") {
          acceptedThread = true;
          job = { ...job, threadId: "accepted-owner" }; f.jobs.save(job);
        } else if (operation === "turn") {
          job = { ...job, status: "running", turnId: "confirmed-turn" }; f.jobs.save(job);
        } else if (operation === "finish") {
          job = { ...job, status: "completed" }; f.jobs.save(job);
        }
        // Arbitrary presentation rows have neither reason, even with a name.
        await f.overlay.updateThreadMetadata({ backend: "codex", threadId: "stale" }, { title: { text: "Stale", source: "explicit" }, pinnedRank: "1" });
        const read = (storage: RetainedOwnerThreadStore) => {
          const rows = storage.list();
          expect(rows.map(row => row.id).sort()).toEqual([
            ...(!confirmed && !named ? ["imported"] : []), ...(acceptedThread ? ["accepted-owner"] : []),
          ].sort());
          if (!confirmed && !named) expect(rows.find(row => row.id === "imported")).toMatchObject({
            title: titled === true ? "Pending imported title" : "Untitled thread", titleSource: titled === true ? "derived" : "fallback",
            pinnedRank: String(seen), parentThreadId: "parent", parentThreadBackend: "claude", model: "saved-model", fastMode: true,
          });
        };
        read(f.retained);
        if (operation === "reopen") {
          const reopened = StateDb.open(f.dbPath, { profileName: "fixture" });
          try { read(new RetainedOwnerThreadStore(reopened, f.directory)); } finally { reopened.close(); }
        }
        if (saved) expect(f.jobs.get(job.id)).toMatchObject({ fingerprint: "immutable-input",
          ...(job.threadId ? { threadId: job.threadId } : {}), ...(job.turnId ? { turnId: job.turnId } : {}) });
        else expect(f.jobs.get(job.id)).toBeUndefined();
      }
    } finally { f.close(); }
  }), { numRuns: 25 });
});

it("atomically confirms an imported batch, rolls it back on refusal and fences late confirmation after retirement", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async reverse => {
    const f = retainedOwnerFixture(false, ["imported", "second"]);
    const ids = reverse ? ["second", "imported"] : ["imported", "second"];
    try {
      const before = await f.overlay.listThreadMetadata();
      f.db.raw.exec(reverse
        ? "CREATE TRIGGER refuse_confirmation BEFORE INSERT ON threads WHEN json_extract(NEW.payload, '$.threadId') = 'imported' BEGIN SELECT RAISE(ABORT, 'confirmation refused'); END"
        : "CREATE TRIGGER refuse_confirmation BEFORE INSERT ON threads WHEN json_extract(NEW.payload, '$.threadId') = 'second' BEGIN SELECT RAISE(ABORT, 'confirmation refused'); END");
      expect(() => f.retained.confirmNativeThreads(ids)).toThrow("confirmation refused");
      expect(await f.overlay.listThreadMetadata()).toEqual(before);
      f.db.raw.exec("DROP TRIGGER refuse_confirmation");
      f.retained.confirmNativeThreads(ids);
      expect(f.retained.list()).toEqual([]);
      await f.overlay.updateThreadMetadata({ backend: "codex", threadId: ids[0]! }, { nativeMembershipRetired: true });
      f.retained.confirmNativeThreads(ids);
      expect((await f.overlay.getThreadMetadata({ backend: "codex", threadId: ids[0]! }))?.nativeMembershipRetired).toBe(true);
    } finally { f.close(); }
  }), { numRuns: 20 });
});

it("requires committed, byte-verified import provenance and does not repair a changed backup", () => {
  const f = retainedOwnerFixture();
  try {
    const file = path.join(f.directory, "legacy-owner-backup-v1/threads.json");
    const original = readFileSync(file);
    writeFileSync(file, JSON.stringify({ version: 1, threads: [{ id: "arbitrary" }] }));
    expect(() => f.retained.list()).toThrow("backup is missing or changed");
    writeFileSync(file, original);
    expect(f.retained.list().map(thread => thread.id)).toEqual(["imported"]);
    f.db.raw.prepare("DELETE FROM meta WHERE key = ?").run("outpost_owner_json_import_v1");
    expect(f.retained.list()).toEqual([]);
  } finally { f.close(); }
});
