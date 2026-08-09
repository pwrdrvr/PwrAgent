import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeFederationLeaseCoordinator,
  type FederationLeaseRuntime,
} from "../runtime-federation-lease";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: AppRuntimeInstanceStore;
let tempDir: string;
let liveProcessIds: Set<number>;
const activeCoordinators: RuntimeFederationLeaseCoordinator[] = [];

function createRuntime(): FederationLeaseRuntime {
  return {
    stop: vi.fn(async () => {}),
  };
}

function createCoordinator(
  options: NonNullable<
    ConstructorParameters<typeof RuntimeFederationLeaseCoordinator>[0]
  >,
): RuntimeFederationLeaseCoordinator {
  const processId =
    options.processId
    ?? (options.instanceId === "instance-b" ? 456 : 123);
  liveProcessIds.add(processId);
  const coordinator = new RuntimeFederationLeaseCoordinator({
    profileName: "dev",
    processId,
    cwd:
      options.cwd
      ?? (options.instanceId === "instance-b"
        ? "/tmp/PwrAgnt-b"
        : "/tmp/PwrAgnt-a"),
    processIsAlive: (candidateProcessId) =>
      liveProcessIds.has(candidateProcessId),
    ...options,
  });
  activeCoordinators.push(coordinator);
  return coordinator;
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
  liveProcessIds = new Set<number>();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-federation-lease-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"), {
    profileName: "dev",
  });
  store = new AppRuntimeInstanceStore(stateDb);
});

afterEach(() => {
  vi.useRealTimers();
  // Release ownership before closing the shared test database.
  for (const coordinator of activeCoordinators.splice(0)) {
    try {
      coordinator.shutdownSync();
    } catch {
      // Ignore teardown races; the store may already be closed.
    }
  }
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
    const coordinator = createCoordinator({
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
      const coordinator = createCoordinator({
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
    const coordinator = createCoordinator({
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
    const coordinator = createCoordinator({
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
    const first = createCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });
    const second = createCoordinator({
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
    const first = createCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });
    const second = createCoordinator({
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

  it("re-acquires the lease after the holder process exits", async () => {
    let now = 1_000;
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const first = createCoordinator({
      instanceId: "instance-a",
      now: () => now,
      store,
    });
    const second = createCoordinator({
      instanceId: "instance-b",
      now: () => now,
      store,
    });

    await first.applyMode(firstRuntime, "gateway");
    liveProcessIds.delete(123);
    now = 40_000;
    await expect(second.applyMode(secondRuntime, "gateway")).resolves
      .toMatchObject({ enabled: true });

    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      acquiredAt: 40_000,
      status: "active",
    });
    second.shutdownSync();
  });

  it("lets a live challenger replace a dead owner without waiting for a TTL", async () => {
    let now = 1_000;
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const first = createCoordinator({
      instanceId: "instance-a",
      now: () => now,
      store,
    });
    const second = createCoordinator({
      instanceId: "instance-b",
      now: () => now,
      store,
    });

    await first.applyMode(firstRuntime, "client");
    liveProcessIds.delete(123);
    now = 2_000;
    await expect(second.applyMode(secondRuntime, "client")).resolves
      .toMatchObject({ enabled: true });

    expect(firstRuntime.stop).not.toHaveBeenCalled();
    expect(first.snapshot()).toMatchObject({
      leaseHeld: false,
      leaseHolder: { instanceId: "instance-b" },
    });
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
    second.shutdownSync();
  });

  it("does not renew a PID-owned lease on a timer", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });

    await coordinator.applyMode(runtime, "client");
    const acquiredLease = store.getFederationLease();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

    expect(store.getFederationLease()).toEqual(acquiredLease);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({
      leaseHeld: true,
    });
  });

  it("releases the lease on shutdownSync", async () => {
    const runtime = createRuntime();
    const coordinator = createCoordinator({
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

  it("releases the lease when post-acquisition startup fails", async () => {
    const runtime = createRuntime();
    const coordinator = createCoordinator({
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
    const first = createCoordinator({
      instanceId: "instance-a",
      now: () => 1_000,
      store,
    });
    const second = createCoordinator({
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
    const coordinator = createCoordinator({
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
