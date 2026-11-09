import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { OwnerThreadIdentity, OwnerThreadMetadataPatch, OwnerThreadRecord, OwnerThreadRegistry } from "@pwragent/owner-core/thread-storage";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

type Fixture = {
  registry: OwnerThreadRegistry;
  reopen(): OwnerThreadRegistry;
  close(): void;
};

function desktop(): Fixture {
  const { dbPath, tempDir } = createTempStateDb("owner-storage-");
  let db = StateDb.open(dbPath);
  return {
    registry: new SqliteOverlayStore(db),
    reopen() { db.close(); db = StateDb.open(dbPath); return new SqliteOverlayStore(db); },
    close() { db.close(); rmSync(tempDir, { recursive: true, force: true }); },
  };
}

async function outpost(records: OwnerThreadRecord[] = []): Promise<Fixture> {
  const url = pathToFileURL(path.join(process.cwd(), "packages/pwragent/src/federation-backend.js")).href;
  const { HeadlessBackend } = await import(/* @vite-ignore */ url);
  const root = mkdtempSync(path.join(os.tmpdir(), "owner-storage-sqlite-"));
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  const storage = profile.openOwnerStorage(directory, { version: 1, workspace: root, codexHome: path.join(root, "codex") });
  for (const { backend, threadId, ...metadata } of records) {
    storage.threads.updateThreadMetadata({ backend, threadId }, metadata);
  }
  const runtime = { workspace: root, store: { directory: path.join(directory, "jobs"), jobs: new Map(), threadRegistry: storage.threads },
    onFailure(error: unknown) { throw error; } };
  const open = () => new HeadlessBackend(runtime, () => {}).threadRegistry as OwnerThreadRegistry;
  return { registry: open(), reopen: open, close() { profile.close(); rmSync(root, { recursive: true, force: true }); } };
}

const identity: OwnerThreadIdentity = { backend: "codex", threadId: "thread-a" };
const timestamp = fc.integer({ min: 0, max: 2_000_000_000_000 });
const optional = <T>(value: fc.Arbitrary<T>) => fc.oneof(fc.constant(undefined), fc.constant(null), value);
const patch: fc.Arbitrary<OwnerThreadMetadataPatch> = fc.record({
  title: optional(fc.record({ text: fc.string(), source: fc.constantFrom("fallback" as const, "derived" as const, "explicit" as const) })),
  createdAt: optional(timestamp), updatedAt: optional(timestamp), cwd: optional(fc.string()),
  executionMode: optional(fc.constantFrom("default" as const, "auto" as const, "full-access" as const)),
  model: optional(fc.string()), reasoningEffort: optional(fc.string()), serviceTier: optional(fc.string()), fastMode: optional(fc.boolean()),
  executionModeUpdatedAt: optional(timestamp), reasoningEffortsByModel: optional(fc.dictionary(fc.string(), fc.string())),
  modelMigrationRevision: optional(fc.string()), modelSettingsManuallyUpdatedAt: optional(timestamp),
  pinnedRank: optional(fc.string()), seenAt: optional(timestamp), seenUpdatedAt: optional(timestamp),
  archived: optional(fc.boolean()), archivedAt: optional(timestamp), restoredAt: optional(timestamp),
  archiveRetentionStartedAt: optional(timestamp),
  parent: optional(fc.record({ backend: fc.constantFrom("codex" as const, "claude" as const), threadId: fc.string(), instanceId: fc.string() })),
  subthreadOrder: optional(fc.array(fc.string(), { maxLength: 5 })), subthreadsCollapsed: optional(fc.boolean()), messagingFileTools: optional(fc.boolean()),
});

/** One contract, run against each real durable implementation. */
for (const [name, create] of [["desktop SQLite", desktop], ["Outpost profile SQLite", outpost]] as const) {
  describe(`owner storage contract: ${name}`, () => {
    it("matches a metadata map after arbitrary patches and reopen, without aliasing", async () => {
      await fc.assert(fc.asyncProperty(fc.array(fc.record({
        threadId: fc.constantFrom("a", "b", "c"), patch,
      }), { minLength: 1, maxLength: 25 }), async (commands) => {
        const fixture = await create();
        const model = new Map<string, OwnerThreadRecord>();
        try {
          expect(await fixture.registry.getThreadMetadata(identity)).toBeUndefined();
          expect(await fixture.registry.listThreadMetadata()).toEqual([]);
          for (const command of commands) {
            const ref = { backend: "codex" as const, threadId: command.threadId };
            const expected: OwnerThreadRecord = structuredClone(model.get(ref.threadId) ?? { ...ref, executionMode: "default" });
            // Independent model: null deletes, undefined is not an observation.
            for (const [key, value] of Object.entries(command.patch)) {
              if (value === null) Reflect.deleteProperty(expected, key);
              else if (value !== undefined) Reflect.set(expected, key, structuredClone(value));
            }
            expected.executionMode ??= "default";
            model.set(ref.threadId, expected);
            const input = structuredClone(command.patch);
            const result = await fixture.registry.updateThreadMetadata(ref, input);
            expect(result).toEqual(expected);
            if (input.title) input.title.text = "mutated input";
            if (input.subthreadOrder) input.subthreadOrder.push("mutated input");
            result.title = { text: "mutated output", source: "explicit" };
            result.subthreadOrder?.push("mutated output");
            expect(await fixture.registry.getThreadMetadata(ref)).toEqual(expected);
            const rows = await fixture.registry.listThreadMetadata();
            expect(rows.sort(byId)).toEqual([...model.values()].sort(byId));
            rows[0]!.pinnedRank = "mutated listing";
          }
          const reopened = fixture.reopen();
          expect((await reopened.listThreadMetadata()).sort(byId)).toEqual([...model.values()].sort(byId));
        } finally { fixture.close(); }
      }), { numRuns: 30 });
    });

    it("keeps title/source atomic and distinguishes seen time from its watermark", async () => {
      const fixture = await create();
      try {
        await fixture.registry.updateThreadMetadata(identity, { title: { text: "First", source: "derived" }, seenAt: 10, seenUpdatedAt: 5 });
        await fixture.registry.updateThreadMetadata(identity, { title: { text: "Renamed", source: "explicit" }, seenAt: 20 });
        expect(await fixture.reopen().getThreadMetadata(identity)).toEqual({ ...identity,
          executionMode: "default",
          title: { text: "Renamed", source: "explicit" }, seenAt: 20, seenUpdatedAt: 5 });
      } finally { fixture.close(); }
    });

    it("merges concurrent disjoint commands into the latest stored row", async () => {
      const fixture = await create();
      try {
        await Promise.all([
          fixture.registry.updateThreadMetadata(identity, { title: { text: "Named", source: "explicit" } }),
          fixture.registry.updateThreadMetadata(identity, { pinnedRank: "a0" }),
          fixture.registry.updateThreadMetadata(identity, { seenUpdatedAt: 123 }),
        ]);
        expect(await fixture.reopen().getThreadMetadata(identity)).toEqual({ ...identity, executionMode: "default",
          title: { text: "Named", source: "explicit" }, pinnedRank: "a0", seenUpdatedAt: 123 });
      } finally { fixture.close(); }
    });

    it("round trips parent fields and child order without normalizing or sharing them", async () => {
      const fixture = await create();
      try {
        const metadata = { parent: { backend: "codex" as const, threadId: "", instanceId: "" }, subthreadOrder: [] as string[] };
        const result = await fixture.registry.updateThreadMetadata(identity, metadata);
        result.subthreadOrder!.push("changed");
        expect(await fixture.reopen().getThreadMetadata(identity)).toEqual({ ...identity, executionMode: "default", ...metadata });
      } finally { fixture.close(); }
    });
  });
}

function byId(a: OwnerThreadRecord, b: OwnerThreadRecord): number {
  return a.threadId.localeCompare(b.threadId);
}

it("preserves SQLite host metadata and isolates identical IDs on different providers", async () => {
  const fixture = desktop();
  try {
    const store = fixture.registry as SqliteOverlayStore;
    await store.setThreadExecutionMode({ ...identity, executionMode: "auto" });
    await store.setThreadTokenMiser({ ...identity, enabled: true });
    await store.updateThreadMetadata(identity, { title: { text: "Codex", source: "explicit" } });
    await store.updateThreadMetadata({ ...identity, backend: "claude" }, { title: { text: "Claude", source: "derived" } });
    expect((await store.getThreadOverlayState(identity))?.executionMode).toBe("auto");
    expect((await store.getThreadOverlayState(identity))?.tokenMiserEnabled).toBe(true);
    expect((await store.listThreadMetadata()).map((row) => row.title?.text).sort()).toEqual(["Claude", "Codex"]);
  } finally { fixture.close(); }
});

it("preserves Outpost tool metadata across canonical reopen", async () => {
  const fixture = await outpost();
  try {
    const registry = fixture.registry;
    await registry.updateThreadMetadata(identity, { title: { text: "Native", source: "derived" }, executionMode: "auto",
      seenAt: 20, seenUpdatedAt: 10, archived: true, messagingFileTools: true });
    await registry.updateThreadMetadata(identity, { pinnedRank: "a0" });
    expect(await fixture.reopen().getThreadMetadata(identity)).toMatchObject({ messagingFileTools: true, executionMode: "auto", pinnedRank: "a0" });
    await expect(registry.getThreadMetadata({ ...identity, backend: "claude" })).resolves.toBeUndefined();
    await expect(registry.updateThreadMetadata({ ...identity, backend: "claude" }, { pinnedRank: "b0" })).rejects.toThrow("Codex threads only");
  } finally { fixture.close(); }
});

it("reads backend-qualified canonical metadata without enabling unsupported-provider writes", async () => {
  const metadata = fc.record({
    title: fc.record({ text: fc.string(), source: fc.constantFrom("derived" as const, "explicit" as const) }),
    pinnedRank: fc.string(), seenAt: timestamp, seenUpdatedAt: timestamp, archived: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(fc.tuple(metadata, metadata, metadata), async (facts) => {
    const records: OwnerThreadRecord[] = (["codex", "claude", "acp:fixture"] as const).map((backend, index) => ({
      ...identity, backend, executionMode: "auto", ...facts[index]!,
    }));
    // Seed the owner's port, as a desktop using this same profile would.
    const fixture = await outpost(records);
    try {
      for (const registry of [fixture.registry, fixture.reopen()]) {
        expect((await registry.listThreadMetadata()).sort((a, b) => a.backend.localeCompare(b.backend)))
          .toEqual([...records].sort((a, b) => a.backend.localeCompare(b.backend)));
        for (const record of records) {
          expect(await registry.getThreadMetadata(record)).toEqual(record);
          const returned = (await registry.getThreadMetadata(record))!;
          returned.title!.text = "mutated read";
          expect(await registry.getThreadMetadata(record)).toEqual(record);
          if (record.backend !== "codex") {
            await expect(registry.updateThreadMetadata(record, { title: { text: "Rejected", source: "explicit" } }))
              .rejects.toThrow("Codex threads only");
            expect(await registry.getThreadMetadata(record)).toEqual(record);
          }
        }
      }
    } finally { fixture.close(); }
  }), { numRuns: 25 });
});

it("budgets one atomic metadata command and zero writes for unchanged facts and reads", async () => {
  const previous = process.env[SQLITE_WRITE_METRICS_ENV];
  process.env[SQLITE_WRITE_METRICS_ENV] = "1";
  const fixture = desktop();
  try {
    await fixture.registry.updateThreadMetadata(identity, { title: { text: "Initial", source: "fallback" } });
    const change = { title: { text: "Named", source: "explicit" as const }, pinnedRank: "a0", seenAt: 100, seenUpdatedAt: 90 };
    const { writes } = await measureSqliteWrites(async () => { await fixture.registry.updateThreadMetadata(identity, change); });
    expectSqliteWriteBudget({ scenario: "owner-thread-metadata-command", note: "One owner metadata command merges all changed fields in one transaction; no lifecycle callers yet.", writes });
    const unchanged = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i++) {
        await fixture.registry.updateThreadMetadata(identity, change);
        await fixture.registry.getThreadMetadata(identity);
        await fixture.registry.listThreadMetadata();
      }
    });
    expectSqliteWriteBudget({ scenario: "owner-thread-metadata-unchanged", note: "100 unchanged metadata commands and reads make no commits.", writes: unchanged.writes });
  } finally {
    fixture.close();
    if (previous === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
    else process.env[SQLITE_WRITE_METRICS_ENV] = previous;
  }
});
