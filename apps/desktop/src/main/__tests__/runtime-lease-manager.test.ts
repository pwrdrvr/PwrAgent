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
let liveRuntimeIdentities: Map<number, string>;

function runtimeIdentityKey(params: {
  instanceId: string;
  startedAt: number;
}): string {
  return `${params.instanceId}:${params.startedAt}`;
}

function createManager(params: {
  instanceId: string;
  processId: number;
  now?: () => number;
  systemBootedAt?: number;
}): RuntimeLeaseManager {
  const now = params.now ?? (() => 1_000);
  const startedAt = now();
  liveRuntimeIdentities.set(
    params.processId,
    runtimeIdentityKey({ instanceId: params.instanceId, startedAt }),
  );
  return new RuntimeLeaseManager({
    cwd: `/tmp/${params.instanceId}`,
    instanceId: params.instanceId,
    now,
    processId: params.processId,
    profileName: "dev",
    runtimeIdentityIsAlive: (owner) =>
      liveRuntimeIdentities.get(owner.processId)
      === runtimeIdentityKey(owner),
    startedAt,
    store,
    systemBootedAt: params.systemBootedAt,
  });
}

beforeEach(() => {
  liveRuntimeIdentities = new Map<number, string>();
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

  it("denies both leases while their registered owner identity is alive", () => {
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
    liveRuntimeIdentities.delete(123);

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
    liveRuntimeIdentities.set(123, "unrelated-process:3_000");
    now = 2_000 + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS - 1;
    expect(challenger.acquire("federation")).toMatchObject({ acquired: false });
    now += 1;
    expect(challenger.acquire("federation")).toEqual({ acquired: true });
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
  });

  it("immediately reclaims a federation owner from before the current boot", () => {
    const owner = createManager({
      instanceId: "instance-a",
      processId: 123,
      now: () => 1_000,
    });
    const challenger = createManager({
      instanceId: "instance-b",
      processId: 456,
      now: () => 20_000,
      systemBootedAt: 10_000,
    });
    owner.acquire("federation");

    // The old marker and recycled PID can still make the runtime identity
    // look live. Its pre-boot start time is the conclusive signal.

    expect(challenger.acquire("federation")).toEqual({ acquired: true });
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
  });

  it("reclaims a pre-boot owner after an earlier dead observation", () => {
    const owner = createManager({
      instanceId: "instance-a",
      processId: 123,
      now: () => 1_000,
    });
    const challenger = createManager({
      instanceId: "instance-b",
      processId: 456,
      now: () => 20_000,
      systemBootedAt: 10_000,
    });
    owner.acquire("federation");
    store.markInstanceExited({ instanceId: "instance-a", now: 2_000 });

    expect(challenger.acquire("federation")).toEqual({ acquired: true });
    expect(store.getFederationLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
  });

  it("starts reclaim grace when a PID was recycled before observation", () => {
    let now = 2_000;
    const owner = createManager({ instanceId: "instance-a", processId: 123 });
    const challenger = createManager({
      instanceId: "instance-b",
      processId: 456,
      now: () => now,
    });
    owner.acquire("messaging");

    // The original owner crashes and an unrelated process receives its PID
    // before any challenger observes an empty PID slot.
    liveRuntimeIdentities.set(123, "unrelated-process:1_500");

    expect(challenger.acquire("messaging")).toMatchObject({ acquired: false });
    expect(store.getInstance("instance-a")).toMatchObject({ exitedAt: 2_000 });

    now += RUNTIME_LEASE_DEAD_OWNER_GRACE_MS;
    expect(challenger.acquire("messaging")).toEqual({ acquired: true });
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
