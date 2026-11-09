import fc from "fast-check";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

async function modules() {
  const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  return { JobStore, HeadlessBackend };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "outpost-owner-data-"));
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const identity = { version: 1, workspace: path.join(root, "workspace"), codexHome: path.join(root, "codex") };
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const desktop = new SqliteOverlayStore(db);
  return { root, directory, identity, db, desktop };
}

it("the real Outpost registry and desktop observe one canonical metadata model across alternating owners", async () => {
  const { JobStore, HeadlessBackend } = await modules();
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    id: fc.constantFrom("a", "b", "c"), title: fc.string({ maxLength: 40 }),
    rank: fc.string({ maxLength: 8 }), seen: fc.nat(10000), desktop: fc.boolean(),
  }), { minLength: 1, maxLength: 15 }), async commands => {
    const f = fixture();
    const profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
    try {
      const store = new JobStore(f.directory, f.identity, profile);
      const runtime = { workspace: f.identity.workspace, store, onFailure(error: unknown) { throw error; } };
      const backend = new HeadlessBackend(runtime, () => {});
      for (const command of commands) {
        const identity = { backend: "codex" as const, threadId: command.id };
        const patch = { title: { text: command.title, source: "explicit" as const }, pinnedRank: command.rank,
          seenAt: command.seen + 1, seenUpdatedAt: command.seen,
          parent: { backend: "codex" as const, threadId: "parent", instanceId: "owner" } };
        const writer = command.desktop ? f.desktop : backend.threadRegistry;
        await writer.updateThreadMetadata(identity, patch);
        expect(await backend.threadRegistry.getThreadMetadata(identity)).toEqual(await f.desktop.getThreadMetadata(identity));
        expect(await f.desktop.getThreadMetadata(identity)).toMatchObject(patch);
      }
      expect(existsSync(path.join(f.directory, "threads.json"))).toBe(false);
    } finally { profile.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  }), { numRuns: 20 });
});

it("imports legacy threads and jobs together, backs up bytes, retires JSON and preserves no-replay job identity", async () => {
  const { JobStore, HeadlessBackend } = await modules();
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("starting", "running", "completed", "failed", "unknown"), {
    minLength: 1, maxLength: 8,
  }), async statuses => {
    const f = fixture();
    const threads = statuses.map((_, i) => ({ id: `thread-${i}`, title: `Title ${i}`, titleSource: "explicit",
      createdAt: i, sandbox: "read-only", pinnedRank: `a${i}`, seenAt: i + 2, seenUpdatedAt: i,
      parentThreadId: "parent", messagingFileTools: true }));
    const jobs = statuses.map((status, i) => ({ version: 1, id: `job-${i}`, threadId: `thread-${i}`, status,
      fingerprint: `fingerprint-${i}`, createdAt: new Date(i).toISOString(), updatedAt: new Date(i).toISOString(), sandbox: "read-only" }));
    const bytes = JSON.stringify({ version: 1, threads });
    writeFileSync(path.join(f.directory, "identity.json"), JSON.stringify(f.identity));
    writeFileSync(path.join(f.directory, "threads.json"), bytes);
    mkdirSync(path.join(f.directory, "jobs"), { mode: 0o700 });
    for (const job of jobs) writeFileSync(path.join(f.directory, "jobs", `${job.id}.json`), JSON.stringify(job));
    let profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
    try {
      const store = new JobStore(f.directory, f.identity, profile);
      const backend = new HeadlessBackend({ workspace: f.identity.workspace, store, onFailure(error: unknown) { throw error; } }, () => {});
      expect((await f.desktop.listThreadMetadata()).length).toBe(threads.length);
      for (const [i, job] of jobs.entries()) {
        expect(store.get(job.id)).toMatchObject({ id: job.id, fingerprint: job.fingerprint,
          status: ["starting", "running"].includes(job.status) ? "unknown" : job.status });
        expect(await backend.threadRegistry.getThreadMetadata({ backend: "codex", threadId: job.threadId })).toMatchObject({ pinnedRank: `a${i}`, seenUpdatedAt: i });
        expect(existsSync(path.join(f.directory, "jobs", `${job.id}.json`))).toBe(false);
      }
      expect(readFileSync(path.join(f.directory, "legacy-owner-backup-v1", "threads.json"), "utf8")).toBe(bytes);
      expect(existsSync(path.join(f.directory, "threads.json"))).toBe(false);
      profile.close();
      profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
      const reopened = new JobStore(f.directory, f.identity, profile);
      expect([...reopened.jobs.values()]).toEqual([...store.jobs.values()]);
    } finally { profile.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  }), { numRuns: 12 });
});
