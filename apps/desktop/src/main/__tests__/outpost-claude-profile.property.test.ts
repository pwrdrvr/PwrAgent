import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { ClaudeSessionStore } from "../claude/claude-session-store";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/);

it("discovers actual Claude metadata without inventory and follows desktop title, archive and settings changes", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.array(fc.record({ name: word, archived: fc.boolean(), seen: fc.boolean(),
    executionMode: fc.constantFrom("default" as const, "auto" as const, "full-access" as const),
  }), { minLength: 1, maxLength: 8 }), async (id, commands) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-claude-profile-")));
    mkdirSync(path.join(root, "headless"), { mode: 0o700 });
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
    const overlay = new SqliteOverlayStore(db);
    const sessions = new ClaudeSessionStore(path.join(root, "claude"));
    const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const owner = new HeadlessBackend({ workspace: root, store, projects: { list: () => [] },
        onFailure(error: unknown) { throw error; } }, () => {});
      const ref = { backend: "claude", threadId: id };
      for (const [index, command] of commands.entries()) {
        const updatedAt = 100 + index;
        await sessions.save({ cwd: root, sdkSessionId: "private-sdk-id", sdkSessionDir: "/private/provider-project",
          thread: { id, source: "claude", title: command.name, titleSource: "derived", createdAt: 1, updatedAt,
            linkedDirectories: [], model: command.name, executionMode: command.executionMode,
            ...(command.archived ? { archivedAt: updatedAt + 1 } : {}) } });
        await overlay.updateThreadMetadata(ref, { pinnedRank: `${index}`, parent: { backend: "codex", threadId: "parent" },
          seenAt: 10000, seenUpdatedAt: command.seen ? updatedAt : updatedAt - 1 });
        const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
        expect(detail.identity).toBe(command.archived ? "archived" : "present");
        expect(detail.thread).toMatchObject({ id, source: "claude", title: command.name, titleSource: "derived", model: command.name,
          executionMode: command.executionMode, pinnedRank: `${index}`, parentThreadId: "parent", parentThreadBackend: "codex",
          inbox: { inInbox: !command.seen } });
        expect(JSON.stringify(detail)).not.toContain("private-sdk-id");
        expect((await owner.handle("resolveThread", ref)).thread).toEqual(detail.thread);
        expect((await owner.handle("listThreads", { backend: "claude" })).threads.map((row: { id: string }) => row.id))
          .toEqual(command.archived ? [] : [id]);
        expect((await owner.handle("lookupArchivedThreads", { backend: "claude", threadIds: [id] })).threads.map((row: { id: string }) => row.id))
          .toEqual(command.archived ? [id] : []);
        await expect(owner.handle("readThread", ref)).rejects.toThrow("executes Codex only");
      }
    } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 25 });
});
