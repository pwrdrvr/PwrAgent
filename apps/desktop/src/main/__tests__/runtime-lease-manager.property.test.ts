import os from "node:os";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeLeaseManager, type RuntimeLeaseKind } from "../runtime-lease-manager";
import { AppRuntimeInstanceStore, RUNTIME_LEASE_DEAD_OWNER_GRACE_MS } from "../state/app-runtime-instance-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

beforeEach(() => {
  vi.spyOn(os, "uptime").mockImplementation(() => {
    throw Object.assign(new Error("uv_uptime returned EPERM"), { code: "EPERM" });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

it("starts a messaging owner when macOS denies uv_uptime", () => {
  const db = openInMemoryStateDb({ profileName: "fixture" });
  try {
    const manager = new RuntimeLeaseManager({
      store: new AppRuntimeInstanceStore(db), profileName: "fixture", cwd: "/tmp/fixture",
      instanceId: "owner", processId: 123, startedAt: 0, now: () => 100_000,
      runtimeIdentityIsAlive: () => false,
    });
    expect(manager.acquire("messaging")).toEqual({ acquired: true });
  } finally { db.close(); }
});

// An unavailable boot clock provides no evidence that an owner predates boot.
// The identity oracle and the ordinary dead-owner grace must still govern all
// three leases, regardless of the owner's wall-clock start time.
it("preserves identity and the full dead-owner grace when OS uptime is denied", () => {
  fc.assert(fc.property(
    fc.integer({ min: -2_000_000_000_000, max: 2_000_000_000_000 }),
    fc.constantFrom<RuntimeLeaseKind>("messaging", "federation", "mcp_connections"),
    fc.integer({ min: 0, max: RUNTIME_LEASE_DEAD_OWNER_GRACE_MS - 1 }),
    (startedAt, kind, elapsed) => {
      const db = openInMemoryStateDb({ profileName: "fixture" });
      try {
        const store = new AppRuntimeInstanceStore(db);
        let now = startedAt + 100_000;
        let ownerAlive = true;
        const common = { store, profileName: "fixture", cwd: "/tmp/fixture", now: () => now,
          runtimeIdentityIsAlive: () => ownerAlive };
        const owner = new RuntimeLeaseManager({ ...common, instanceId: "owner", processId: 123,
          startedAt, systemBootedAt: startedAt - 100_000 });
        expect(owner.acquire(kind).acquired).toBe(true);
        const challenger = new RuntimeLeaseManager({ ...common, instanceId: "challenger", processId: 456, startedAt: now });
        expect(challenger.acquire(kind).acquired).toBe(false);
        expect(store.getInstance("owner")?.exitedAt).toBeUndefined();
        ownerAlive = false;
        const observedDeadAt = now;
        expect(challenger.acquire(kind).acquired).toBe(false);
        expect(store.getInstance("owner")?.exitedAt).toBe(observedDeadAt);
        now += elapsed;
        expect(challenger.acquire(kind).acquired).toBe(false);
        now = observedDeadAt + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS - 1;
        expect(challenger.acquire(kind).acquired).toBe(false);
        now += 1;
        expect(challenger.acquire(kind).acquired).toBe(true);
      } finally { db.close(); }
    },
  ), { numRuns: 25 });
});
