import fc from "fast-check";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { StateDb } from "../storage/state-db";
import { RetainedOwnerThreadStore } from "../storage/retained-owner-thread-store";
import { retainedOwnerFixture } from "./helpers/retained-owner-fixture";

// The model has two independent reasons for retention: a committed, still
// unconfirmed import and a durable acceptance with a confirmed thread identity.
it("models import confirmation and every accepted job boundary against live profile reads and reopen", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(fc.constantFrom("facts", "confirm", "retire", "name", "accept", "thread", "turn", "finish", "reopen"),
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
          await f.overlay.updateThreadMetadata({ backend: "codex", threadId: "imported" }, { nativeMembershipRetired: operation === "retire" });
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
            title: titled ? "Pending imported title" : "Untitled thread", titleSource: titled ? "derived" : "fallback",
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
