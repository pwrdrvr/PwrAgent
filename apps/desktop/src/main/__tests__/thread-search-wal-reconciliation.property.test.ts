import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { StateDb } from "../state/state-db";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const shapes = fc.record({
  entry: fc.constantFrom("slice", "single", "prune"),
  listing: fc.constantFrom("matching", "changed", "new"),
  damage: fc.constantFrom("none", "stale", "missing", "legacy", "reused"),
  peer: fc.constantFrom("none", "rename", "delete", "unrelated"),
  boundary: fc.constantFrom("preflight", "recheck"),
  tick: fc.integer({ min: 1, max: 9 }),
  reverse: fc.boolean(),
});
type Shape = typeof shapes extends fc.Arbitrary<infer Value> ? Value : never;

it("explores two-connection search reconciliation against a document and visibility model", () => {
  const temp = createTempStateDb("search-wal-model-");
  const reader = StateDb.open(temp.dbPath);
  const writer = StateDb.open(temp.dbPath);
  try {
    writer.raw.pragma("busy_timeout = 0");
    const write = new ThreadSearchStore(writer);
    const mapRowid = writer.raw.prepare("SELECT fts_rowid FROM thread_search_fts_rows WHERE identity_key = ?").pluck();
    const eraseFts = writer.raw.prepare("DELETE FROM thread_search_fts WHERE rowid = ?");
    const minimalFts = writer.raw.prepare("INSERT INTO thread_search_fts (rowid, identity_key, title, backend, thread_id) VALUES (?, ?, ?, ?, ?)");
    const selectDocuments = reader.raw.prepare("SELECT identity_key, title, summary, updated_at, archived_at FROM thread_search_documents ORDER BY identity_key");
    const run = (shape: Shape): string | undefined => {
      const { entry, listing, damage, peer, boundary, tick, reverse } = shape;
      const initial: AppServerThreadSummary = { id: "target", source: "codex", title: "Common baseline", titleSource: "explicit", updatedAt: tick, linkedDirectories: [] };
      const input = listing === "changed" ? { ...initial, title: "Common inventory" } : initial;
      const kept: AppServerThreadSummary = { ...initial, id: "keep", title: "Common retained" };
      const legacy: AppServerThreadSummary = { ...initial, id: "foreign", source: "claude", title: "Common foreign" };
      const renamed = { ...initial, title: "Common newer", summary: "Peer data", updatedAt: reverse ? tick : tick + 1 };
      const peerKept = { ...kept, title: "Common peerkept" };
      const key = (value: AppServerThreadSummary) => `${value.source}:${value.id}`;
      const model = new Map([kept, legacy, ...(listing === "new" ? [] : [initial])].map((row) => [key(row), row]));
      writer.raw.exec("DELETE FROM thread_search_fts; DELETE FROM thread_search_fts_rows; DELETE FROM thread_search_documents");
      write.upsertThreads([...model.values()]);
      if (listing !== "new" && damage !== "none") {
        const rowid = mapRowid.get(key(initial));
        if (damage === "stale") {
          writer.raw.prepare("UPDATE thread_search_fts SET title = ? WHERE rowid = ?").run("Common poisonous", rowid);
        } else {
          eraseFts.run(rowid);
          if (damage === "legacy") minimalFts.run(50, key(initial), initial.title, initial.source, initial.id);
          if (damage === "reused") {
            eraseFts.run(mapRowid.get(key(legacy)));
            minimalFts.run(rowid, key(legacy), legacy.title, legacy.source, legacy.id);
          }
        }
      }

      const read = new ThreadSearchStore(reader);
      let attempted = false;
      let committedTargetChange = false;
      let checks = 0;
      const attempt = () => {
        if (attempted || peer === "none") return;
        attempted = true;
        try {
          if (peer === "rename") {
            write.upsertThread(renamed, tick);
            model.set(key(initial), renamed);
            committedTargetChange = true;
          } else if (peer === "delete") {
            write.deleteThread({ backend: initial.source, threadId: initial.id });
            committedTargetChange = model.delete(key(initial));
          } else {
            write.upsertThread(peerKept, tick);
            model.set(key(kept), peerKept);
          }
        } catch (error) {
          if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
        }
      };
      const prepare = reader.raw.prepare;
      reader.raw.prepare = ((sql: string) => {
        const statement = prepare.call(reader.raw, sql);
        if (entry !== "prune" && sql.includes("FROM thread_search_documents d") && sql.includes("JOIN thread_search_fts f ON f.rowid = k.fts_rowid")) {
          const get = statement.get.bind(statement);
          statement.get = (projection: { identityKey?: string }) => {
            const result = get(projection);
            if (projection.identityKey === key(initial) && ++checks === (boundary === "preflight" ? 1 : 2)) attempt();
            return result;
          };
        }
        if (entry === "prune" && sql.includes("SELECT identity_key, backend, thread_id, archived_at")) {
          const all = statement.all.bind(statement);
          statement.all = (cursor: string) => {
            const result = all(cursor);
            attempt();
            return result;
          };
        }
        return statement;
      }) as typeof prepare;
      try {
        if (entry === "slice") read.upsertThreads(reverse ? [kept, input] : [input, kept]);
        if (entry === "single") read.upsertThread(input, tick);
        if (entry === "prune") read.pruneMissingThreads({ backend: "codex", includeArchived: true, retainedIdentityKeys: [key(kept)] });
      } catch (error) {
        return `${entry}:${(error as { code?: string }).code ?? String(error)}`;
      } finally {
        reader.raw.prepare = prepare;
      }
      const reachable = entry === "prune" || boundary === "preflight" || listing !== "matching" || damage !== "none";
      if (attempted !== (peer !== "none" && reachable)) return `${entry}:peer-attempt:${boundary}`;
      if (entry === "prune") {
        if (listing !== "new") model.delete(key(initial));
      } else if (!committedTargetChange) model.set(key(input), input);
      const expectedDocs = [...model.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([identity_key, row]) => ({
        identity_key, title: row.title, summary: row.summary ?? null, updated_at: row.updatedAt, archived_at: null,
      }));
      if (JSON.stringify(selectDocuments.all()) !== JSON.stringify(expectedDocs)) {
        return `${entry}:documents:${peer}:${listing}:${damage}`;
      }
      const identityKeys = [key(initial), key(kept)];
      for (const query of ["common", "baseline", "inventory", "newer", "retained", "peerkept", "poisonous"]) {
        const actual = read.search({ query: `"${query}"`, identityKeys, includeArchived: true, limit: 10 }).map((row) => row.identityKey).sort();
        const expected = [...model.entries()].filter(([id, row]) => identityKeys.includes(id) && row.title.toLowerCase().split(" ").includes(query)).map(([id]) => id).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) return `${entry}:match:${query}:${peer}:${listing}:${damage}`;
      }
      return undefined;
    };
    // Reuse the two WAL connections and keep the generated CI workload bounded.
    fc.assert(fc.property(shapes, (input) => {
      expect(run(input)).toBeUndefined();
    }), { numRuns: 5 });
  } finally {
    writer.close();
    reader.close();
    removeTempStateDbDir(temp.tempDir);
  }
});
