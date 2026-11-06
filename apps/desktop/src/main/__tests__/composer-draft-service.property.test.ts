import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDraftStorage } from "@pwragent/owner-core/composer-draft-storage";
import { buildOwnedComposerScopeKey, type ComposerDraftSnapshotRecord } from "@pwragent/shared";
import {
  clearComposerDraft,
  listComposerDraftLatest,
  listComposerDraftRecoveryCandidates,
  recordComposerDraftHistory,
  saveComposerDraft,
} from "../composer-drafts/composer-draft-service";
import { ComposerDraftRecoveryStore } from "../state/composer-draft-recovery-store";
import type { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createComposerDraftStorage } from "../storage/desktop-composer-draft-storage";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({
  getAppStateDb: () => {
    if (!active.db) throw new Error("App state not initialized. Call initializeAppState() first.");
    return active.db;
  },
}));

afterEach(() => {
  active.db = undefined;
  vi.unstubAllEnvs();
});

function draft(scope: "legacy" | "local" | "peer" | "launchpad", text = "Draft"): ComposerDraftSnapshotRecord {
  const threadOwner = {
    backend: "codex" as const,
    threadId: "same-thread",
    target: scope === "peer"
      ? { scope: "remote" as const, instanceId: "peer" }
      : { scope: "local" as const },
  };
  return {
    scopeKey: scope === "launchpad" ? "launchpad:directory:/project"
      : scope === "legacy" ? "thread:codex:same-thread" : buildOwnedComposerScopeKey(threadOwner),
    scopeKind: scope === "launchpad" ? "launchpad" : "thread",
    ...(scope === "launchpad" ? {} : { threadOwner, threadId: threadOwner.threadId }),
    backend: "codex",
    directoryKey: "directory:/project",
    text,
    skillTokens: [],
    imageAttachments: [],
    status: "unsent",
    createdAt: 1,
    updatedAt: 2,
    contentHash: "",
    charCount: text.length,
  };
}

function seed(db: StateDb): void {
  new ComposerDraftRecoveryStore(db).save({ draft: draft("legacy"), recordHistory: true });
  const launchpad = { directoryKey: "directory:/project", backend: "codex", prompt: "Legacy launchpad",
    createdAt: 1, updatedAt: 2 };
  db.raw.prepare("INSERT INTO directory_launchpads(directory_path, payload, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(launchpad.directoryKey, JSON.stringify(launchpad), 1, 2);
}

const operation = fc.record({
  kind: fc.constantFrom("save", "history", "clear", "latest", "candidates"),
  profile: fc.constantFrom(0, 1),
  scope: fc.constantFrom("legacy" as const, "local" as const, "peer" as const, "launchpad" as const),
  text: fc.string({ maxLength: 30 }),
  status: fc.constantFrom("unsent" as const, "sent" as const, "abandoned" as const, "cleared" as const),
  recordHistory: fc.boolean(),
  migrateKnownOwners: fc.boolean(),
  migrateLegacyLaunchpads: fc.boolean(),
  includeSent: fc.boolean(),
  limit: fc.integer({ min: 0, max: 60 }),
});

describe("composer draft application storage oracle", () => {
  it("preserves results, persisted rows and commits across profile changes and explicit migrations", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    // The unchanged SQLite store is the oracle for the routing refactor.
    // Every generated application call must have exactly its former effect,
    // including viewer-local drafts for local and peer owners of the same ID.
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 30 }), async (operations) => {
      const profiles = [0, 1].map(() => ({ db: openInMemoryStateDb(), oracle: openInMemoryStateDb() }));
      try {
        for (const { db, oracle } of profiles) { seed(db); seed(oracle); }
        for (const [index, op] of operations.entries()) {
          const profile = profiles[op.profile]!;
          active.db = profile.db;
          const oracle: ComposerDraftStorage = new ComposerDraftRecoveryStore(profile.oracle);
          const record = { ...draft(op.scope, op.text), status: op.status, updatedAt: index + 10 };
          const query = { scopeKey: record.scopeKey, includeSent: op.includeSent, limit: op.limit };
          const actual = await measureSqliteWrites(() => {
            if (op.kind === "save") return saveComposerDraft({ draft: record, recordHistory: op.recordHistory });
            if (op.kind === "history") return recordComposerDraftHistory({ draft: record });
            if (op.kind === "clear") return clearComposerDraft({ scopeKey: record.scopeKey });
            if (op.kind === "candidates") return listComposerDraftRecoveryCandidates(query);
            return listComposerDraftLatest(op);
          });
          const expected = await measureSqliteWrites(() => {
            if (op.kind === "save") return { draft: oracle.save({ draft: record, recordHistory: op.recordHistory }) };
            if (op.kind === "history") return { candidate: oracle.recordHistory(record) };
            if (op.kind === "clear") { oracle.clear(record.scopeKey); return { scopeKey: record.scopeKey }; }
            if (op.kind === "candidates") return { candidates: oracle.listCandidates(query) };
            if (op.migrateKnownOwners) oracle.migrateKnownOwnerScopes();
            if (op.migrateLegacyLaunchpads) oracle.migrateLegacyLaunchpadDrafts();
            return { drafts: oracle.listLatest() };
          });
          expect(actual).toEqual(expected);
          for (const pair of profiles) {
            for (const sql of [
              "SELECT * FROM composer_draft_latest ORDER BY scope_key",
              "SELECT * FROM composer_draft_journal ORDER BY id",
              "SELECT * FROM directory_launchpads ORDER BY directory_path",
            ]) {
              expect(pair.db.raw.prepare(sql).all()).toEqual(pair.oracle.raw.prepare(sql).all());
            }
          }
          expect(listComposerDraftRecoveryCandidates()).toEqual({ candidates: oracle.listCandidates() });
        }
      } finally {
        active.db = undefined;
        for (const { db, oracle } of profiles) { db.close(); oracle.close(); }
      }
    }), { numRuns: 25 });
  });

  it("binds only at each call and retains the uninitialized-state failure", () => {
    expect(() => listComposerDraftLatest()).toThrow("App state not initialized");
    const db = openInMemoryStateDb();
    try {
      active.db = db;
      const storage: ComposerDraftStorage = createComposerDraftStorage();
      expect(storage.listLatest()).toEqual([]);
      saveComposerDraft({ draft: draft("peer") });
      expect(listComposerDraftLatest().drafts).toHaveLength(1);
      active.db = undefined;
      expect(() => saveComposerDraft({ draft: draft("local") })).toThrow("App state not initialized");
      expect(() => listComposerDraftLatest()).toThrow("App state not initialized");
    } finally { db.close(); }
  });
});
