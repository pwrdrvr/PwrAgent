import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEDERATION_LEASE_HEARTBEAT_MS,
  RuntimeFederationLeaseCoordinator,
  type FederationLeaseRuntime,
} from "../runtime-federation-lease";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: AppRuntimeInstanceStore;
let tempDir: string;

function createRuntime(): FederationLeaseRuntime {
  return {
    stop: vi.fn(async () => {}),
  };
}

function recordInstance(
  instanceId: string,
  params: { processId: number; cwd: string; startedAt: number },
): void {
  store.recordInstanceStart({
    instanceId,
    profileName: "dev",
    processId: params.processId,
    cwd: params.cwd,
    startedAt: params.startedAt,
    desiredMessagingEnabled: false,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-federation-lease-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"), {
    profileName: "dev",
  });
  store = new AppRuntimeInstanceStore(stateDb);
});

afterEach(() => {
  vi.useRealTimers();
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("RuntimeFederationLeaseCoordinator", () => {
  it("acquires the profile lease when federation is enabled", async () => {
    const runtime = createRuntime();
    recordInstance("instance-a", {
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      startedAt: 1_000,
    });
    const coordinator = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });

    await expect(coordinator.applyMode(runtime, "client")).resolves
      .toMatchObject({ enabled: true });

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });
    expect(coordinator.snapshot()).toMatchObject({
      instanceId: "instance-a",
      leaseHeld: true,
    });

    coordinator.shutdownSync();
  });

  it.each(["gateway", "dual"] as const)(
    "acquires the profile lease in %s mode",
    async (mode) => {
      const runtime = createRuntime();
      const coordinator = new RuntimeFederationLeaseCoordinator({
        instanceId: "instance-a",
        now: () => 1_000,
        store,
      });

      await expect(coordinator.applyMode(runtime, mode)).resolves
        .toMatchObject({ enabled: true });

      expect(store.getFederationLease()).toMatchObject({
        ownerInstanceId: "instance-a",
        status: "active",
      });

      coordinator.shutdownSync();
    },
  );

  it("never acquires the lease when federation is disabled", async () => {
    const runtime = createRuntime();
    const coordinator = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });

    await expect(coordinator.applyMode(runtime, "disabled")).resolves
      .toMatchObject({
        enabled: false,
        disabledReasonKind: "saved_disabled",
      });

    expect(store.getFederationLease()).toBeUndefined();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("releases a held lease when federation is disabled", async () => {
    const runtime = createRuntime();
    const coordinator = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });

    await coordinator.applyMode(runtime, "dual");
    await expect(coordinator.applyMode(runtime, "disabled")).resolves
      .toMatchObject({
        enabled: false,
        disabledReasonKind: "saved_disabled",
      });

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "released",
      releasedAt: 1_000,
    });
    expect(coordinator.snapshot()).toMatchObject({ leaseHeld: false });
  });

  it("denies a second instance while the first holds the lease", async () => {
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    recordInstance("instance-a", {
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      startedAt: 1_000,
    });
    recordInstance("instance-b", {
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      startedAt: 2_000,
    });
    const first = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });
    const second = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-b",
      now: () => 2_000,
      store,
    });

    await expect(first.applyMode(firstRuntime, "client")).resolves
      .toMatchObject({ enabled: true });
    await expect(second.applyMode(secondRuntime, "client")).resolves
      .toMatchObject({
        enabled: false,
        disabledReasonKind: "lease_held",
        leaseHolder: {
          instanceId: "instance-a",
          processId: 123,
          cwdHint: "PwrAgnt-a",
          startedAt: 1_000,
        },
      });

    // The denied instance must not stop the holder's runtime or its lease.
    expect(firstRuntime.stop).not.toHaveBeenCalled();
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });
    expect(second.snapshot()).toMatchObject({
      leaseHeld: false,
      disabledReasonKind: "lease_held",
      leaseHolder: { instanceId: "instance-a" },
    });
    first.shutdownSync();
  });

  it("re-acquires the lease after the holder releases it", async () => {
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const first = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });
    const second = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-b",
      now: () => 2_000,
      store,
    });

    await first.applyMode(firstRuntime, "dual");
    first.shutdownSync();
    expect(store.getFederationLease()).toMatchObject({
      status: "released",
      releasedAt: 1_000,
    });

    await expect(second.applyMode(secondRuntime, "dual")).resolves
      .toMatchObject({ enabled: true });

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      acquiredAt: 2_000,
      status: "active",
    });
    second.shutdownSync();
  });

  it("re-acquires the lease after the holder's lease expires", async () => {
    let now = 1_000;
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const first = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => now,
      store,
    });
    const second = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-b",
      now: () => now,
      store,
    });

    await first.applyMode(firstRuntime, "gateway");
    now = 40_000;
    await expect(second.applyMode(secondRuntime, "gateway")).resolves
      .toMatchObject({ enabled: true });

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      acquiredAt: 40_000,
      expiresAt: 70_000,
      status: "active",
    });
    second.shutdownSync();
  });

  it("stops the runtime when the heartbeat loses the lease", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const first = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => now,
      store,
    });
    const second = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-b",
      now: () => now,
      store,
    });

    await first.applyMode(firstRuntime, "client");
    // The first instance stops renewing (busy event loop, debugger pause,
    // OS sleep) and the second takes the lease once it expires.
    now = 32_000;
    await second.applyMode(secondRuntime, "client");
    now = 33_000;
    await vi.advanceTimersByTimeAsync(FEDERATION_LEASE_HEARTBEAT_MS);

    expect(firstRuntime.stop).toHaveBeenCalledTimes(1);
    expect(first.snapshot()).toMatchObject({
      leaseHeld: false,
      disabledReasonKind: "lease_held",
      leaseHolder: { instanceId: "instance-b" },
    });
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
    second.shutdownSync();
  });

  it("releases the lease on shutdownSync", async () => {
    const runtime = createRuntime();
    const coordinator = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });

    await coordinator.applyMode(runtime, "client");
    coordinator.shutdownSync();

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "released",
      releasedAt: 1_000,
    });
  });

  it("releases the lease and stops the heartbeat when post-acquisition startup fails", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const coordinator = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });

    await coordinator.applyMode(runtime, "client");
    await coordinator.releaseAfterStartupFailure(runtime);

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "released",
      releasedAt: 1_000,
    });
    expect(coordinator.snapshot()).toMatchObject({
      leaseHeld: false,
      disabledReasonKind: "startup_error",
    });

    // The heartbeat must be stopped too: nothing may re-activate the lease.
    await vi.advanceTimersByTimeAsync(FEDERATION_LEASE_HEARTBEAT_MS * 3);
    expect(store.getFederationLease()).toMatchObject({
      status: "released",
      releasedAt: 1_000,
    });
  });

  it("lets another instance acquire after a startup-failure release", async () => {
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    recordInstance("instance-a", {
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      startedAt: 1_000,
    });
    recordInstance("instance-b", {
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      startedAt: 2_000,
    });
    const first = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });
    const second = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-b",
      now: () => 2_000,
      store,
    });

    await first.applyMode(firstRuntime, "dual");
    await first.releaseAfterStartupFailure(firstRuntime);
    await expect(second.applyMode(secondRuntime, "dual")).resolves
      .toMatchObject({ enabled: true });

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      acquiredAt: 2_000,
      status: "active",
    });
    second.shutdownSync();
  });

  it("releases the lease even when runtime stop fails during startup cleanup", async () => {
    const runtime: FederationLeaseRuntime = {
      stop: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    };
    const coordinator = new RuntimeFederationLeaseCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });

    await coordinator.applyMode(runtime, "client");
    await expect(
      coordinator.releaseAfterStartupFailure(runtime),
    ).resolves.toBeUndefined();

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "released",
      releasedAt: 1_000,
    });
  });
});
