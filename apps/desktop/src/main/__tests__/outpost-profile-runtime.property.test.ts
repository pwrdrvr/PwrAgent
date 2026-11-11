import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeLeaseManager as SharedManager } from "@pwragent/owner-core/runtime-lease-manager";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { RuntimeLeaseManager as DesktopManager } from "../runtime-lease-manager";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "outpost-profile-"));
  roots.push(root);
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  return { root, db, store: new AppRuntimeInstanceStore(db) };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("binds desktop to the functioning shared manager rather than another owner implementation", () => {
  expect(DesktopManager.prototype).toBeInstanceOf(SharedManager);
  expect(Object.getOwnPropertyNames(DesktopManager.prototype)).toEqual(["constructor"]);
});

// Independent model: each resource has at most one live owner. Only its owner
// may release it; a different process cannot take it while that owner is live.
it("matches live-owner exclusion across generated desktop/portable acquisitions and releases", () => {
  fc.assert(fc.property(fc.array(fc.record({
    actor: fc.integer({ min: 0, max: 2 }),
    kind: fc.constantFrom("federation", "messaging", "mcp_connections"),
    acquire: fc.boolean(),
  }), { minLength: 1, maxLength: 60 }), commands => {
    const { root, db } = fixture();
    const other = StateDb.open(path.join(root, "state.db"));
    const managers = [DesktopManager, SharedManager, SharedManager].map((Manager, actor) => new Manager({
      instanceId: `runtime-v2-actor-${actor}`, profileName: "fixture", processId: 100 + actor,
      startedAt: 1_000, cwd: root, now: () => 2_000, systemBootedAt: 0,
      store: new AppRuntimeInstanceStore(actor % 2 ? other : db), runtimeIdentityIsAlive: () => true,
    }));
    const model = new Map<string, number>();
    try {
      for (const command of commands) {
        const manager = managers[command.actor]!;
        const holder = model.get(command.kind);
        if (command.acquire) {
          const accepted = holder === undefined || holder === command.actor;
          expect(manager.acquire(command.kind).acquired).toBe(accepted);
          if (accepted) model.set(command.kind, command.actor);
        } else {
          expect(manager.release(command.kind)).toBe(holder === command.actor);
          if (holder === command.actor) model.delete(command.kind);
        }
        for (const [actor, observer] of managers.entries()) {
          expect(observer.snapshot(command.kind).leaseHeld).toBe(model.get(command.kind) === actor);
        }
      }
    } finally { other.close(); db.close(); }
  }), { numRuns: 35 });
});
