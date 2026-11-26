import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { ToastHistoryPhase } from "../../shared/operator-alert-history";
import { OperatorAlertHistoryRecorder } from "../storage/operator-alert-history";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const BASE = Date.UTC(2026, 0, 1);
const fixture = {
  identity: "fixture-private-thread:/fixture/account/provider-response",
  category: "approval",
  surface: "durable-toast",
} as const;

describe("operator alert history", () => {
  it("exports a contrived sequence across two writers, a restart, and profile isolation", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("pwragent-alert-history-");
    let db = StateDb.open(dbPath);
    const anotherWindowProcess = StateDb.open(dbPath);
    const otherProfile = openInMemoryStateDb();
    let now = BASE;
    const recorder = new OperatorAlertHistoryRecorder(() => db.raw, () => now);
    const anotherRecorder = new OperatorAlertHistoryRecorder(() => anotherWindowProcess.raw, () => now);
    try {
      const { writes } = await measureSqliteWrites(async () => {
        recorder.recordToast({ ...fixture, phase: "queued", message: "fixture-provider-secret" });
        recorder.recordToast({ ...fixture, phase: "displayed" });
        recorder.recordToast({
          ...fixture, category: "thread-action", surface: "transient-toast", phase: "queued",
        });
        recorder.recordToast({
          ...fixture, category: "thread-action", surface: "transient-toast", phase: "displayed",
        });
        now += 9_000;
        recorder.recordToast({
          ...fixture, category: "thread-action", surface: "transient-toast", phase: "expired",
        });
        recorder.recordNative({
          identity: "fixture-native-attempt", category: "turn-failed", surface: "native", phase: "submitted",
        });
        recorder.recordNative({
          identity: "fixture-native-attempt", category: "turn-failed", surface: "native", phase: "failed",
        });
        recorder.flushBestEffort();
      });
      expectSqliteWriteBudget({
        scenario: "operator-alert-history-batch",
        note: "One flush batches two toast lifecycles and a native display failure, including first-use correlation salt.",
        writes,
      });

      // A later window sees the same pending approval. It must add an
      // acknowledgement to the retained episode and keep the first display.
      now += 1_000;
      anotherRecorder.recordToast({ ...fixture, phase: "queued" });
      anotherRecorder.recordToast({ ...fixture, phase: "displayed" });
      anotherRecorder.recordToast({ ...fixture, phase: "dismissed" });
      anotherRecorder.flushBestEffort();
      db.close();
      db = StateDb.open(dbPath);
      const restarted = new OperatorAlertHistoryRecorder(() => db.raw, () => now + 1_000);
      restarted.recordToast({ ...fixture, phase: "queued" });
      restarted.recordToast({ ...fixture, phase: "displayed" });
      restarted.recordToast({ ...fixture, category: "/fixture/private", phase: "queued" });

      const evidence = restarted.read();
      expect(evidence).toEqual({
        version: 1,
        capacity: 512,
        evictedCount: 0,
        droppedObservationCount: 0,
        alerts: [
          { category: "turn-failed", surface: "native", milestones: { submitted: BASE + 9_000, failed: BASE + 9_000 } },
          { category: "thread-action", surface: "transient-toast", milestones: { queued: BASE, displayed: BASE, expired: BASE + 9_000 } },
          { category: "approval", surface: "durable-toast", milestones: { queued: BASE, displayed: BASE, dismissed: BASE + 10_000 } },
        ],
      });
      expect(JSON.stringify(evidence)).not.toMatch(/fixture|correlation|identity|sequence|salt/);
      const persisted = db.raw.prepare("SELECT * FROM operator_alert_history").all();
      expect(JSON.stringify(persisted)).not.toContain("fixture");
      expect(new OperatorAlertHistoryRecorder(() => otherProfile.raw).read().alerts).toEqual([]);

      // A fresh use of the same UI slot after the replay period is a new episode.
      now += 31_000;
      restarted.recordToast({ ...fixture, phase: "queued" });
      expect(restarted.read().alerts[0]?.milestones).toEqual({ queued: now + 1_000 });
    } finally {
      anotherWindowProcess.close();
      db.close();
      otherProfile.close();
      removeTempStateDbDir(tempDir);
      vi.unstubAllEnvs();
    }
  });

  it("retains the newest episodes and never recreates an evicted row for a late acknowledgement", () => {
    const db = openInMemoryStateDb();
    const recorder = new OperatorAlertHistoryRecorder(() => db.raw, () => BASE);
    try {
      const total = 515;
      for (let index = 0; index < total; index += 1) {
        recorder.recordToast({ ...fixture, identity: String(index), phase: "queued" });
      }
      recorder.flushBestEffort();
      recorder.recordToast({ ...fixture, identity: "0", phase: "dismissed" });
      const result = recorder.read();
      expect(result.alerts).toHaveLength(512);
      expect(result.evictedCount).toBe(3);
      expect(result.alerts.some((alert) => alert.milestones.dismissed !== undefined)).toBe(false);
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM operator_alert_history").get()).toEqual({ count: 512 });
    } finally {
      db.close();
    }
  });

  it("flushes only once for a burst and does not write again while idle", () => {
    vi.useFakeTimers();
    const db = openInMemoryStateDb();
    const getDb = vi.fn(() => db.raw);
    const recorder = new OperatorAlertHistoryRecorder(getDb, () => BASE);
    try {
      recorder.recordToast({ ...fixture, phase: "queued" });
      recorder.recordToast({ ...fixture, phase: "displayed" });
      vi.advanceTimersByTime(4_999);
      expect(getDb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(getDb).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10_000);
      expect(getDb).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("retains first observations of each milestone across window redelivery and flush reordering", () => {
    const phases = ["queued", "displayed", "dismissed", "withdrawn", "action-invoked"] as const;
    const event = fc.record({ phase: fc.constantFrom(...phases), window: fc.constantFrom(0, 1) });
    fc.assert(fc.property(fc.array(event, { minLength: 10, maxLength: 32 }), (events) => {
      const db = openInMemoryStateDb();
      let now = BASE;
      try {
        const recorder = new OperatorAlertHistoryRecorder(() => db.raw, () => now);
        const windows = [0, 1].map(() => new OperatorAlertHistoryRecorder(() => db.raw, () => now));
        recorder.recordToast({ ...fixture, phase: "queued" });
        recorder.flushBestEffort();
        const expected = new Map<ToastHistoryPhase, number>([["queued", now]]);
        for (const event of events) {
          now += 1;
          if (!expected.has(event.phase)) expected.set(event.phase, now);
          windows[event.window]!.recordToast({ ...fixture, phase: event.phase });
        }
        for (const window of windows.reverse()) window.flushBestEffort();
        expect(recorder.read().alerts).toEqual([
          { category: fixture.category, surface: fixture.surface, milestones: Object.fromEntries(expected) },
        ]);
      } finally {
        db.close();
      }
    }), { numRuns: 5 });
  });
});
