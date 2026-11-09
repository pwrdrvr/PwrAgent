import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

it("actual Claude discovery and desktop metadata boundaries add no SQLite commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-claude-writes-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const sessions = new ClaudeSessionStore(path.join(root, "claude"));
    const owner = new HeadlessBackend({ workspace: root, store, projects: { list: () => [] },
      onFailure(error: unknown) { throw error; } }, () => {});
    const ref = { backend: "claude", threadId: "00000000-0000-4000-8000-000000000001" };
    const session = { cwd: root, thread: { id: ref.threadId, source: "claude" as const, title: "Before",
      titleSource: "explicit" as const, updatedAt: 2, linkedDirectories: [] } };
    const changes = await measureSqliteWrites(async () => {
      for (let index = 0; index < 100; index++) {
        await sessions.save({ ...session, thread: { ...session.thread, title: `Name ${index}`, archivedAt: index % 2 ? 3 : undefined } });
        expect((await owner.handle("resolveThread", ref)).thread.title).toBe(`Name ${index}`);
      }
    });
    expectSqliteWriteBudget({ budgetFile: "outpost-claude-profile-write-budgets.json", scenario: "claude-profile-metadata-boundaries",
      note: "100 actual desktop metadata saves and Outpost discoveries use the existing sidecar without SQLite writes (0 MB/day)", writes: changes.writes });
    const reads = await measureSqliteWrites(async () => {
      for (let index = 0; index < 1000; index++) {
        await owner.handle("resolveThread", ref);
        await owner.handle("listThreads", { backend: "claude" });
        await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
        await owner.handle("lookupArchivedThreads", { backend: "claude", threadIds: [ref.threadId] });
      }
    });
    expectSqliteWriteBudget({ budgetFile: "outpost-claude-profile-write-budgets.json", scenario: "claude-profile-passive-reads",
      note: "1000 rounds of actual Claude metadata resolve/list/detail/archive reads add no SQLite commits (0 MB/day)", writes: reads.writes });
  } finally { profile.close(); db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
