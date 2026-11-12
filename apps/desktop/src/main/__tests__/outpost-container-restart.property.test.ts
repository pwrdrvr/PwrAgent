import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { RuntimeLeaseManager, type RuntimeLeaseKind } from "../runtime-lease-manager";
import {
  acquireHeadlessOwnerLock,
  HEADLESS_OWNER_LOCK_MARKER,
  type HeadlessOwnerLock,
} from "../headless/owner-lock";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const OWNER_KINDS = ["federation", "messaging"] as const satisfies readonly RuntimeLeaseKind[];
const MARKER_TTL_MS = 45_000;

type Outpost = { instanceId: string; lock: HeadlessOwnerLock; manager: RuntimeLeaseManager };
type Desktop = { instanceId: string; manager: RuntimeLeaseManager; held: Set<RuntimeLeaseKind> };

/**
 * Rule: on one profile volume, an Outpost starts exactly when no other owner
 * is live. A dead Outpost, even one whose PID the replacement reuses (PID 1 in
 * every container) and whose runtime marker still looks fresh, never blocks
 * it; a live Outpost, or a live desktop app holding the profile leases,
 * always does. No lease ever has two live holders.
 *
 * Generations follow the daemon: take the headless lock, record the runtime
 * instance, then acquire the federation and messaging leases as
 * startOwnerServices does, naming the lock's earlier holders as exited. A
 * crash skips every release; the kernel frees the lock and `owner.lock`
 * stays behind. Liveness is pessimistic: a crashed owner's marker counts as
 * live for its whole 45-second TTL, and time never advances far enough for
 * the one-minute dead-owner grace to run out between a crash and a restart.
 */
it("starts a replacement Outpost exactly when no live owner holds the profile", () => {
  const operation = fc.record({
    action: fc.constantFrom("start", "start", "crash", "stop", "desktopStart", "desktopStop"),
    delta: fc.integer({ min: 0, max: 20_000 }),
  });
  fc.assert(fc.property(fc.boolean(), fc.array(operation, { minLength: 1, maxLength: 30 }), (containers, operations) => {
    const root = mkdtempSync(path.join(tmpdir(), "outpost-restart-"));
    roots.push(root);
    const lockDirectory = path.join(root, "headless");
    const db = StateDb.open(path.join(root, "state.db"), { profileName: "outpost" });
    const store = new AppRuntimeInstanceStore(db);
    let now = 1_000_000;
    let generation = 0;
    const live = new Set<string>();
    const lastSeen = new Map<string, number>();
    const runtimeIdentityIsAlive = (owner: { instanceId: string }) => live.has(owner.instanceId)
      || now - (lastSeen.get(owner.instanceId) ?? -Infinity) < MARKER_TTL_MS;
    const manager = (instanceId: string, processId: number, exitedInstanceIds: readonly string[] = []) =>
      new RuntimeLeaseManager({
        instanceId, processId, profileName: "outpost", startedAt: now, cwd: root, now: () => now,
        store, systemBootedAt: 0, runtimeIdentityIsAlive, exitedInstanceIds,
      });
    let outpost: Outpost | undefined;
    let desktop: Desktop | undefined;
    const managers = () => [outpost?.manager, desktop?.manager].filter(Boolean) as RuntimeLeaseManager[];
    mkdirSync(lockDirectory, { mode: 0o700 });
    try {
      for (const op of operations) {
        now += op.delta;
        switch (op.action) {
          case "start": {
            const instanceId = `runtime-v2-outpost-${generation++}`;
            const desktopHolds = Boolean(desktop?.held.size);
            let lock: HeadlessOwnerLock;
            try {
              lock = acquireHeadlessOwnerLock(lockDirectory, { processId: containers ? 1 : 1_000 + generation });
            } catch (error) {
              expect(outpost, String(error)).toBeDefined();
              break;
            }
            expect(outpost).toBeUndefined();
            lock.record(instanceId);
            live.add(instanceId);
            const started = manager(instanceId, containers ? 1 : 1_000 + generation, lock.previousInstanceIds);
            const acquired = OWNER_KINDS.every(kind => started.acquire(kind, "thread_owner").acquired);
            expect(acquired).toBe(!desktopHolds);
            if (acquired) {
              outpost = { instanceId, lock, manager: started };
            } else {
              for (const kind of OWNER_KINDS) started.release(kind, "thread_owner");
              started.markExited();
              live.delete(instanceId);
              lock.release();
            }
            break;
          }
          case "crash": {
            if (!outpost) break;
            // The kernel frees the lock; nothing else is cleaned up.
            outpost.lock.release();
            writeFileSync(path.join(lockDirectory, HEADLESS_OWNER_LOCK_MARKER), `${JSON.stringify({ pid: 1, lock: "sqlite-exclusive" })}\n`);
            live.delete(outpost.instanceId);
            lastSeen.set(outpost.instanceId, now);
            outpost = undefined;
            break;
          }
          case "stop": {
            if (!outpost) break;
            for (const kind of OWNER_KINDS) outpost.manager.release(kind, "thread_owner");
            outpost.manager.markExited();
            outpost.lock.release();
            live.delete(outpost.instanceId);
            outpost = undefined;
            break;
          }
          case "desktopStart": {
            if (desktop) break;
            const instanceId = `runtime-v2-desktop-${generation++}`;
            live.add(instanceId);
            desktop = { instanceId, manager: manager(instanceId, 50), held: new Set() };
            for (const kind of OWNER_KINDS) if (desktop.manager.acquire(kind).acquired) desktop.held.add(kind);
            break;
          }
          case "desktopStop": {
            if (!desktop) break;
            for (const kind of desktop.held) desktop.manager.release(kind);
            desktop.manager.markExited();
            live.delete(desktop.instanceId);
            desktop = undefined;
            break;
          }
        }
        for (const kind of OWNER_KINDS) {
          expect(managers().filter(observer => observer.snapshot(kind).leaseHeld).length).toBeLessThanOrEqual(1);
        }
        if (outpost) for (const kind of OWNER_KINDS) expect(outpost.manager.snapshot(kind).leaseHeld).toBe(true);
      }
    } finally {
      outpost?.lock.release();
      db.close();
    }
  }), {
    numRuns: 60,
    // 2026-11-11: a replacement container (PID 1 again) right after a crash.
    examples: [[true, [{ action: "start", delta: 0 }, { action: "crash", delta: 0 }, { action: "start", delta: 1_000 }]]],
  });
});
