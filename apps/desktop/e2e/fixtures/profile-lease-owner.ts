import os from "node:os";
import path from "node:path";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { RuntimeLeaseManager } from "@pwragent/owner-core/runtime-lease-manager";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { getProcessRuntimeIdentity, isProfileRuntimeIdentityLive, startProfileRuntimeHeartbeat } from "@pwragent/sqlite-storage/profile-runtime-markers";

/** A PID-owned lease actor for viewer tests, with no provider, queue or owner
 * runtime. Actual Node-owner boot and claims are covered by the boot oracle. */
export function openProfileLeaseOwnerFixture(params: { stateDirectory: string; profileName: string; cwd: string }) {
  const db = StateDb.open(path.join(params.stateDirectory, "state.db"), { profileName: params.profileName });
  const identity = getProcessRuntimeIdentity();
  const markerDir = path.join(params.stateDirectory, "runtime-instances");
  const heartbeat = startProfileRuntimeHeartbeat(params.profileName, { ...identity, markerDir });
  const manager = new RuntimeLeaseManager({ ...identity, profileName: params.profileName, processId: process.pid, cwd: params.cwd,
    systemBootedAt: Date.now() - os.uptime() * 1_000, store: new AppRuntimeInstanceStore(db),
    runtimeIdentityIsAlive: owner => isProfileRuntimeIdentityLive(owner.profileName, owner, { markerDir }) });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { manager.release("messaging", "thread_owner"); manager.release("federation", "thread_owner"); manager.markExited(); }
    finally { heartbeat.stop(); db.close(); }
  };
  try {
    for (const kind of ["federation", "messaging"] as const) {
      const result = manager.acquire(kind, "thread_owner");
      if (!result.acquired) throw new Error(`Profile ${kind} lease is held by another runtime.`);
    }
    return { close };
  } catch (error) { close(); throw error; }
}
