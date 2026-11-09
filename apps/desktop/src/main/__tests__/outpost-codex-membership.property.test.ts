import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

// A complete provider walk owns native membership. An imported owner not yet
// confirmed by that provider and a durable acceptance are independent facts.
it("models complete native Codex retirement without retiring pending imports or accepted-job identity across reopen", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("active", "archive", "absent", "reopen"), { minLength: 1, maxLength: 12 }),
    fc.boolean(), async (generated, acknowledged) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-codex-member-")));
      const directory = path.join(root, "headless");
      mkdirSync(path.join(directory, "jobs"), { recursive: true, mode: 0o700 });
      const identity = { version: 1 as const, workspace: root, codexHome: path.join(root, "codex") };
      writeFileSync(path.join(directory, "identity.json"), JSON.stringify(identity));
      writeFileSync(path.join(directory, "threads.json"), JSON.stringify({ version: 1, threads: [
        { id: "pending", title: "Pending imported title", titleSource: "derived", sandbox: "read-only" },
      ] }));
      writeFileSync(path.join(directory, "jobs/accepted.json"), JSON.stringify({ version: 1, id: "accepted", status: "completed",
        fingerprint: "confirmed-input", threadId: "accepted-thread", turnId: "confirmed-turn", sandbox: "read-only",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }));
      const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
      const overlay = new SqliteOverlayStore(db);
      const ref = { backend: "codex" as const, threadId: "native" };
      const facts = { pinnedRank: "1024", parent: { backend: "claude" as const, threadId: "parent" }, seenAt: 10,
        seenUpdatedAt: 2, model: "retained-model", reasoningEffort: "high", fastMode: true };
      await overlay.updateThreadMetadata(ref, { ...facts,
        ...(acknowledged ? { title: { text: "Native", source: "derived", nativeName: "Native" } as const } : {}) });
      await overlay.updateThreadMetadata({ backend: "claude", threadId: "native" }, { title: { text: "Other backend", source: "explicit" } });
      const native = { id: "native", source: "codex" as const, title: "Native", titleSource: "explicit" as const, createdAt: 1, updatedAt: 2, linkedDirectories: [] };
      new ProviderThreadSnapshotStore(db).replace({ backend: "codex", observedAt: 1, threads: [native] });
      let profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
      let state = "active";
      const create = () => {
        const store = new JobStore(directory, identity, profile);
        const runtime = { workspace: root, store, projects: { list: () => [] }, onFailure(error: unknown) { throw error; },
          codex: { listThreads: async ({ archived }: { archived: boolean }) => state !== "absent" && archived === (state === "archive") ? [native] : [],
            renameThread: async () => { throw new Error("An absent pending import must not be published"); } } };
        return { store, owner: new HeadlessBackend(runtime, () => {}) };
      };
      let { store, owner } = create();
      const accepted = store.get("accepted");
      try {
        await owner.initialize();
        // Include the named minimal counterexample in every generated history.
        for (const operation of ["absent", "reopen", ...generated]) {
          if (operation === "reopen") {
            profile.close();
            profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
            ({ store, owner } = create());
            await owner.initialize();
          } else { state = operation; await owner.refreshThreads(); }
          const resolved = (await owner.handle("resolveThread", ref)).thread;
          expect(Boolean(resolved)).toBe(state !== "absent");
          if (resolved) expect(resolved).toMatchObject({ pinnedRank: facts.pinnedRank, model: facts.model, fastMode: facts.fastMode,
            reasoningEffort: facts.reasoningEffort, parentThreadId: "parent", title: "Native",
            titleSource: acknowledged ? "derived" : "explicit" });
          expect([...owner.threads.values()].some((thread: { id: string }) => thread.id === "native")).toBe(state !== "absent");
          expect((await owner.handle("lookupArchivedThreads", { backend: "codex", threadIds: ["native"] })).threads.length).toBe(state === "archive" ? 1 : 0);
          expect((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity).toBe(state === "absent" ? "unresolved" : state === "archive" ? "archived" : "present");
          expect((await owner.handle("resolveThread", { threadId: "pending" })).thread).toMatchObject({ title: "Pending imported title", titleSource: "derived" });
          expect((await owner.handle("resolveThread", { threadId: "accepted-thread" })).thread).toBeDefined();
          expect(store.get("accepted")).toEqual(accepted);
          expect((await owner.handle("resolveThread", { backend: "claude", threadId: "native" })).thread.title).toBe("Other backend");
          expect(await overlay.getThreadMetadata(ref)).toMatchObject(facts);
        }
      } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
    }), { numRuns: 20 });
});
