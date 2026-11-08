import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import {
  disposeAppState, hadExistingAppStateDatabase, initializeDesktopState, isAppStateInitialized,
  recordBootDecision, stopProfileRuntimeHeartbeatRefresh, type AutoVacuumConversion,
} from "../storage/desktop-state-lifecycle";
import { getAppStateDb, getAppStateMode, getBootDecision, resetAppStateForTests } from "../state/app-state";
import { findLiveProfileRuntimeMarkers, resetCachedActiveProfileNameForTests } from "../profile";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";

afterEach(() => {
  resetAppStateForTests(); resetCachedActiveProfileNameForTests(); vi.unstubAllEnvs();
});

it("keeps initialization, mode rejection and shutdown owned by the existing state lifecycle without returning handles", async () => {
  expectTypeOf<ReturnType<typeof initializeDesktopState>>().toEqualTypeOf<{ autoVacuum: AutoVacuumConversion | null }>();
  await fc.assert(fc.asyncProperty(fc.constantFrom("bootstrap" as const, "active-profile" as const), fc.boolean(), async (mode, stopHeartbeat) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-state-lifecycle-"));
    resetAppStateForTests(); resetCachedActiveProfileNameForTests();
    vi.stubEnv("PWRAGENT_HOME", root);
    vi.stubEnv("PWRAGENT_PROFILE", "fixture");
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    try {
      const decision = mode === "bootstrap"
        ? { kind: "no-profile-configured" as const }
        : { kind: "open" as const, profileName: "fixture", profileDir: path.join(root, "profiles/fixture"), source: "env" as const };
      recordBootDecision(decision);
      expect(isAppStateInitialized()).toBe(false);
      const result = initializeDesktopState(mode);
      expect(Object.keys(result)).toEqual(["autoVacuum"]);
      expect(result.autoVacuum).toBeNull();
      expect(getBootDecision()).toBe(decision);
      expect(getAppStateMode()).toBe(mode);
      expect(hadExistingAppStateDatabase()).toBe(false);
      const db = getAppStateDb();
      const repeat = await measureSqliteWrites(() => initializeDesktopState(mode));
      expect(repeat.result).toEqual(result);
      expect(repeat.writes.commits).toBe(0);
      expect(getAppStateDb()).toBe(db);
      expect(() => initializeDesktopState(mode === "bootstrap" ? "active-profile" : "bootstrap")).toThrow("already initialized");
      expect(findLiveProfileRuntimeMarkers("fixture")).toHaveLength(mode === "bootstrap" ? 0 : 1);
      if (stopHeartbeat) {
        stopProfileRuntimeHeartbeatRefresh();
        expect(findLiveProfileRuntimeMarkers("fixture")).toHaveLength(mode === "bootstrap" ? 0 : 1);
      }
      disposeAppState();
      expect(isAppStateInitialized()).toBe(false);
      expect(getAppStateMode()).toBeNull();
      expect(findLiveProfileRuntimeMarkers("fixture")).toHaveLength(0);
      expect(() => db.raw.prepare("SELECT 1")).toThrow();
      expect(() => getAppStateDb()).toThrow("App state not initialized");
      disposeAppState();
    } finally {
      resetAppStateForTests(); resetCachedActiveProfileNameForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }), { numRuns: 25 });
});
