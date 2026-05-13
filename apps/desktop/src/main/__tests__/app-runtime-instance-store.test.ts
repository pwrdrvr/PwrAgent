import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: AppRuntimeInstanceStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-runtime-instance-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"), {
    profileName: "dev",
  });
  store = new AppRuntimeInstanceStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AppRuntimeInstanceStore", () => {
  it("records startup and acquires the profile messaging lease", () => {
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/Users/example/PwrAgnt",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });

    const result = store.acquireMessagingLease({
      instanceId: "instance-a",
      now: 1_000,
      ttlMs: 30_000,
    });

    expect(result.acquired).toBe(true);
    expect(store.getInstance("instance-a")).toMatchObject({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwdHint: "PwrAgnt",
      cwdHash: "c976f17804e892f9",
      startedAt: 1_000,
      heartbeatAt: 1_000,
      desiredMessagingEnabled: true,
      effectiveMessagingEnabled: true,
    });
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      acquiredAt: 1_000,
      heartbeatAt: 1_000,
      expiresAt: 31_000,
      status: "active",
    });
  });

  it("stores the same cwd hash for equivalent absolute paths", () => {
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: path.join(tempDir, "..", path.basename(tempDir)),
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });
    store.recordInstanceStart({
      instanceId: "instance-b",
      profileName: "dev",
      processId: 456,
      cwd: tempDir,
      startedAt: 2_000,
      desiredMessagingEnabled: true,
    });

    expect(store.getInstance("instance-a")?.cwdHash).toBe(
      store.getInstance("instance-b")?.cwdHash,
    );
  });

  it("renews the current holder lease without changing the original acquisition time", () => {
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });
    expect(
      store.acquireMessagingLease({
        instanceId: "instance-a",
        now: 1_000,
        ttlMs: 30_000,
      }).acquired,
    ).toBe(true);

    expect(
      store.renewMessagingLease({
        instanceId: "instance-a",
        now: 11_000,
        ttlMs: 30_000,
      }),
    ).toBe(true);

    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      acquiredAt: 1_000,
      heartbeatAt: 11_000,
      expiresAt: 41_000,
      status: "active",
    });
    expect(store.getInstance("instance-a")).toMatchObject({
      heartbeatAt: 11_000,
      effectiveMessagingEnabled: true,
    });
  });

  it("denies a second instance while the current lease holder is live", () => {
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });
    store.recordInstanceStart({
      instanceId: "instance-b",
      profileName: "dev",
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      startedAt: 2_000,
      desiredMessagingEnabled: true,
    });
    store.acquireMessagingLease({
      instanceId: "instance-a",
      now: 1_000,
      ttlMs: 30_000,
    });

    const result = store.acquireMessagingLease({
      instanceId: "instance-b",
      now: 2_000,
      ttlMs: 30_000,
    });

    expect(result).toMatchObject({
      acquired: false,
      reason: "held",
      holder: {
        ownerInstanceId: "instance-a",
        expiresAt: 31_000,
      },
    });
    expect(store.getInstance("instance-b")).toMatchObject({
      desiredMessagingEnabled: true,
      effectiveMessagingEnabled: false,
      disabledReason: "lease_held",
    });
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });
  });

  it("lets another instance acquire after the previous holder expires", () => {
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });
    store.recordInstanceStart({
      instanceId: "instance-b",
      profileName: "dev",
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      startedAt: 40_000,
      desiredMessagingEnabled: true,
    });
    store.acquireMessagingLease({
      instanceId: "instance-a",
      now: 1_000,
      ttlMs: 30_000,
    });

    const result = store.acquireMessagingLease({
      instanceId: "instance-b",
      now: 40_000,
      ttlMs: 30_000,
    });

    expect(result.acquired).toBe(true);
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      acquiredAt: 40_000,
      heartbeatAt: 40_000,
      expiresAt: 70_000,
      status: "active",
    });
    const instance = store.getInstance("instance-b");
    expect(instance).toMatchObject({
      effectiveMessagingEnabled: true,
    });
    expect(instance).not.toHaveProperty("disabledReason");
  });

  it("does not release a live holder when a non-holder asks to release", () => {
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });
    store.recordInstanceStart({
      instanceId: "instance-b",
      profileName: "dev",
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      startedAt: 2_000,
      desiredMessagingEnabled: false,
    });
    store.acquireMessagingLease({
      instanceId: "instance-a",
      now: 1_000,
      ttlMs: 30_000,
    });

    expect(
      store.releaseMessagingLease({
        instanceId: "instance-b",
        now: 2_000,
      }),
    ).toBe(false);

    const lease = store.getMessagingLease();
    expect(lease).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });
    expect(lease).not.toHaveProperty("releasedAt");
  });

  it("sanitizes instance metadata instead of storing raw paths or secrets", () => {
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/Users/example/Projects/token-secret-value",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
      disabledReason: "PWRAGENT_DISABLE_MESSAGING=token-secret-value",
    });

    const row = stateDb.raw
      .prepare(
        "SELECT cwd_hint, disabled_reason FROM app_runtime_instances WHERE instance_id = ?",
      )
      .get("instance-a") as {
      cwd_hint: string;
      disabled_reason: string;
    };

    expect(row.cwd_hint).toBe("token-secret-value");
    expect(row.cwd_hint).not.toContain("/Users/example");
    expect(row.disabled_reason).toBe("explicit_override");
    expect(row.disabled_reason).not.toContain("token-secret-value");
  });

  it("preserves rows across database reopen and still uses expiry as authority", () => {
    const dbPath = path.join(tempDir, "state.db");
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });
    store.acquireMessagingLease({
      instanceId: "instance-a",
      now: 1_000,
      ttlMs: 30_000,
    });
    stateDb.close();

    stateDb = StateDb.open(dbPath, { profileName: "dev" });
    store = new AppRuntimeInstanceStore(stateDb);
    store.recordInstanceStart({
      instanceId: "instance-b",
      profileName: "dev",
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      startedAt: 40_000,
      desiredMessagingEnabled: true,
    });

    expect(
      store.acquireMessagingLease({
        instanceId: "instance-b",
        now: 40_000,
        ttlMs: 30_000,
      }).acquired,
    ).toBe(true);
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
  });

  it("repairs missing runtime lease tables when user_version already advanced", () => {
    const dbPath = path.join(tempDir, "state.db");
    stateDb.raw.exec(`
      DROP TABLE IF EXISTS messaging_runtime_lease;
      DROP TABLE IF EXISTS app_runtime_instances;
      PRAGMA user_version = 4;
    `);
    stateDb.close();

    stateDb = StateDb.open(dbPath, { profileName: "dev" });
    store = new AppRuntimeInstanceStore(stateDb);
    store.recordInstanceStart({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/Users/example/PwrAgnt",
      startedAt: 1_000,
      desiredMessagingEnabled: true,
    });

    expect(store.getInstance("instance-a")).toMatchObject({
      instanceId: "instance-a",
      cwdHash: "c976f17804e892f9",
    });
  });

  it("removes exited runtime instance rows after one hour", () => {
    const now = 2 * 60 * 60 * 1000;
    store.recordInstanceStart({
      instanceId: "recent-exited",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      startedAt: now - 59 * 60 * 1000,
      desiredMessagingEnabled: true,
    });
    store.markInstanceExited({
      instanceId: "recent-exited",
      now: now - 59 * 60 * 1000,
    });
    store.recordInstanceStart({
      instanceId: "old-exited",
      profileName: "dev",
      processId: 456,
      cwd: "/tmp/PwrAgnt",
      startedAt: now - 61 * 60 * 1000,
      desiredMessagingEnabled: true,
    });
    store.markInstanceExited({
      instanceId: "old-exited",
      now: now - 61 * 60 * 1000,
    });

    stateDb.cleanupExpired(now);

    expect(store.getInstance("recent-exited")).toBeDefined();
    expect(store.getInstance("old-exited")).toBeUndefined();
  });
});
