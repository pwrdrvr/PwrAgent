// Pins the a11y gate's PR watch seeder against the real overlay store.
//
// The seeder writes through the store's own writers, so the risk is not a
// stale row format but a writer that quietly declines: a registration that
// merges into an earlier watch, or a Stop that finds nothing to end. Either
// leaves the a11y block auditing a shorter list than it asserts on, and the
// block can only notice after a full Electron launch. This costs none.
//
// It lives here rather than beside the fixture because `e2e/` is Playwright's.
import { afterEach, describe, expect, it } from "vitest";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import {
  PR_WATCH_AUDIT_THREAD_ID,
  PR_WATCH_AUDIT_UNWATCHED_PR,
  PR_WATCH_AUDIT_WATCHED_PR,
  seedPrWatchAuditState,
} from "../../../e2e/fixtures/pr-watch-state-seeding";
import { stateDbPathForHomeRoot } from "../../../e2e/fixtures/readme-state-seeding";

const tempDirs: string[] = [];
const databases: StateDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) removeTempStateDbDir(dir);
});

function freshHomeRoot(): string {
  const { tempDir } = createTempStateDb("pr-watch-seed-");
  tempDirs.push(tempDir);
  return tempDir;
}

function openStore(homeRoot: string): SqliteOverlayStore {
  const db = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
  databases.push(db);
  return new SqliteOverlayStore(db);
}

const thread = { backend: "codex" as const, threadId: PR_WATCH_AUDIT_THREAD_ID };

describe("seedPrWatchAuditState", () => {
  it("leaves a CI watch on attempt 2 and a merge watch active", async () => {
    const homeRoot = freshHomeRoot();
    const now = Date.UTC(2026, 9, 1, 15, 0, 0);
    await seedPrWatchAuditState(homeRoot, now);

    const active = await openStore(homeRoot).listAllActivePrStatusWatches();
    expect(active.map((watch) => [watch.watchId, watch.kind, watch.runAttempt])).toEqual([
      ["watch-audit-merge", "terminal", undefined],
      ["watch-audit-ci", "checks", 2],
    ]);
    expect(active.every((watch) => watch.prNumber === PR_WATCH_AUDIT_WATCHED_PR.number)).toBe(true);
  });

  it("ends one watch by the operator and one by the agent, newest first", async () => {
    const homeRoot = freshHomeRoot();
    const now = Date.UTC(2026, 9, 1, 15, 0, 0);
    await seedPrWatchAuditState(homeRoot, now);

    const history = await openStore(homeRoot).listThreadPrStatusWatchHistory({
      ...thread,
      limit: 20,
    });
    expect(history.map((entry) => [entry.watchId, entry.status, entry.endedReason])).toEqual([
      ["watch-audit-ended-operator", "cancelled", "cancelled_by_operator"],
      ["watch-audit-ended-agent", "cancelled", "cancelled_by_agent"],
    ]);
  });

  it("attaches both PRs and opts the thread into Auto-fix", async () => {
    const homeRoot = freshHomeRoot();
    await seedPrWatchAuditState(homeRoot);

    const overlay = await openStore(homeRoot).getThreadOverlayState(thread);
    expect(overlay?.prAutoDispatchEnabled).toBe(true);
    expect(overlay?.prs?.map((pr) => pr.number)).toEqual([
      PR_WATCH_AUDIT_WATCHED_PR.number,
      PR_WATCH_AUDIT_UNWATCHED_PR.number,
    ]);
  });
});
