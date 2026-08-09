import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeLeaseManager } from "../runtime-lease-manager";
import {
  AppRuntimeInstanceStore,
  RUNTIME_LEASE_DEAD_OWNER_GRACE_MS,
} from "../state/app-runtime-instance-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: AppRuntimeInstanceStore;
let tempDir: string;
let liveProcessIds: Set<number>;

function createManager(params: {
  instanceId: string;
  processId: number;
  now?: () => number;
}): RuntimeLeaseManager {
  liveProcessIds.add(params.processId);
  return new RuntimeLeaseManager({
    cwd: `/tmp/${params.instanceId}`,
    instanceId: params.instanceId,
    now: params.now ?? (() => 1_000),
    processId: params.processId,
    processIsAlive: (processId) => liveProcessIds.has(processId),
    profileName: "dev",
    store,
  });
}

beforeEach(() => {
  liveProcessIds = new Set<number>();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-runtime-leases-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"), {
    profileName: "dev",
  });
  store = new AppRuntimeInstanceStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("RuntimeLeaseManager", () => {
  it("uses one process registration for messaging and federation", () => {
    const manager = createManager({
      instanceId: "instance-a",
      processId: 123,
    });

    expect(manager.acquire("messaging")).toEqual({ acquired: true });
    expect(manager.acquire("federation")).toEqual({ acquired: true });

    expect(store.getInstance("instance-a")).toMatchObject({
      instanceId: "instance-a",
      processId: 123,
    });
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });
  });

  it("denies both leases while their registered owner PID is alive", () => {
    const owner = createManager({ instanceId: "instance-a", processId: 123 });
    const challenger = createManager({
      instanceId: "instance-b",
      processId: 456,
    });
    owner.acquire("messaging");
    owner.acquire("federation");

    expect(challenger.acquire("messaging")).toMatchObject({
      acquired: false,
      holder: { instanceId: "instance-a", processId: 123 },
    });
    expect(challenger.acquire("federation")).toMatchObject({
      acquired: false,
      holder: { instanceId: "instance-a", processId: 123 },
    });
  });

  it("persists a dead observation before reclaiming a recycled PID", () => {
    let now = 2_000;
    const owner = createManager({ instanceId: "instance-a", processId: 123 });
    const challenger = createManager({
      instanceId: "instance-b",
      processId: 456,
      now: () => now,
    });
    owner.acquire("federation");
    liveProcessIds.delete(123);

    expect(challenger.acquire("federation")).toMatchObject({
      acquired: false,
      holder: { instanceId: "instance-a", processId: 123 },
    });
    expect(store.getInstance("instance-a")).toMatchObject({ exitedAt: 2_000 });
    expect(store.getFederationLease()).toMatchObject({
      expiresAt: 2_000 + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS,
      ownerInstanceId: "instance-a",
      status: "active",
    });

    // A different process may reuse the PID during the grace period. The
    // durable dead observation remains authoritative, so it cannot revive the
    // original owner after the reclaim deadline.
    liveProcessIds.add(123);
    now = 2_000 + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS - 1;
    expect(challenger.acquire("federation")).toMatchObject({ acquired: false });
    now += 1;
    expect(challenger.acquire("federation")).toEqual({ acquired: true });
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
  });

  it("reclaims a stale instance that used the current process PID", () => {
    let now = 2_000;
    const staleOwner = createManager({
      instanceId: "instance-a",
      processId: 123,
    });
    staleOwner.acquire("messaging");

    const currentProcess = createManager({
      instanceId: "instance-b",
      processId: 123,
      now: () => now,
    });

    expect(currentProcess.acquire("messaging")).toMatchObject({
      acquired: false,
    });
    now += RUNTIME_LEASE_DEAD_OWNER_GRACE_MS;
    expect(currentProcess.acquire("messaging")).toEqual({ acquired: true });
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
  });
});
