import { afterEach, expect, it, vi } from "vitest";
import type { NavigationResumeState } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { parseBootstrapNavigationPreferencesArg, serializeBootstrapNavigationPreferences } from "../navigation-browse-mode-bootstrap";

vi.mock("../state/app-state", () => ({ getAppOverlayStore: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

it.each(["inbox", "recents", "attention", "drafts", "directories"] as const)("round-trips %s and its resume metadata through the bootstrap", (browseMode) => {
  const preferences = { browseMode, pinnedGroupCollapsed: true, pinnedThreadsOnTop: true,
    resumeState: { version: 1 as const, selection: { backend: "codex" as const, threadId: "selected" },
      expandedByKey: { project: false }, unpinnedExpandedByKey: {}, loadedRowsByQuery: { inbox: 210 } } };
  expect(parseBootstrapNavigationPreferencesArg([serializeBootstrapNavigationPreferences(preferences)])).toEqual(preferences);
  expect(parseBootstrapNavigationPreferencesArg([serializeBootstrapNavigationPreferences({ ...preferences,
    resumeState: { ...preferences.resumeState, version: 2 } as unknown as NavigationResumeState })])?.resumeState).toBeUndefined();
});

it("reopens the saved session and commits only changed snapshots", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("pwragent-navigation-resume-");
  let db = StateDb.open(dbPath);
  const state: NavigationResumeState = { version: 1, selection: { backend: "codex", threadId: "off-page", ownerInstanceId: "peer" },
    expandedByKey: { open: true, closed: false }, unpinnedExpandedByKey: { open: true }, loadedRowsByQuery: { lens: 210 } };
  try {
    const store = new SqliteOverlayStore(db);
    expect(store.getNavigationResumeStateSync()).toBeUndefined();
    const { writes } = await measureSqliteWrites(async () => {
      store.setNavigationResumeState(state);
      store.setNavigationResumeState(state);
      store.setNavigationResumeState({ ...state, expandedByKey: { closed: false, open: true } });
      for (let i = 0; i < 10; i += 1) expect(store.getNavigationResumeStateSync()).toEqual(state);
    });
    expectSqliteWriteBudget({ scenario: "navigation-resume-state", writes,
      note: "one changed session, duplicate/reordered snapshots and ten reads: one commit; at 1000 navigation actions/day the measured WAL cost is about 8 MB/day" });
    db.close();
    db = StateDb.open(dbPath);
    const reopened = new SqliteOverlayStore(db);
    expect(reopened.getNavigationResumeStateSync()).toEqual(state);
    reopened.setNavigationResumeState({ ...state, selection: null });
    expect(reopened.getNavigationResumeStateSync()?.selection).toBeNull();
    db.setMeta("navigation_resume_state", "broken JSON");
    expect(reopened.getNavigationResumeStateSync()).toBeUndefined();
    db.setMeta("navigation_resume_state", JSON.stringify({ ...state, version: 2 }));
    expect(reopened.getNavigationResumeStateSync()).toBeUndefined();
    expect(() => reopened.setNavigationResumeState({ ...state, version: 2 } as unknown as NavigationResumeState)).toThrow();
  } finally {
    db.close();
    removeTempStateDbDir(tempDir);
  }
});
