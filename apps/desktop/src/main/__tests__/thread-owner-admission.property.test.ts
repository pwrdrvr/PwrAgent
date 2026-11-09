import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { RuntimeLeaseManager } from "@pwragent/owner-core/runtime-lease-manager";
import { ProfileThreadOwnerAdmission } from "@pwragent/owner-core/thread-owner-admission";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { measureSqliteWrites } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { openInMemoryStateDb, createTempStateDb } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

function fixture(db = openInMemoryStateDb({ profileName: "fixture" })) {
  const store = new AppRuntimeInstanceStore(db);
  const managers = [0, 1].map(actor => new RuntimeLeaseManager({
    instanceId: `actor-${actor}`, processId: 100 + actor, startedAt: 1_000,
    profileName: "fixture", cwd: "/fixture", now: () => 2_000, systemBootedAt: 0,
    store, runtimeIdentityIsAlive: () => true,
  }));
  return { db, store, managers };
}

// Viewers can be constructed before profile storage is ready. Only the first
// owner action may resolve it; viewer close must never create an owner.
it("resolves profile lease storage only for an admitted owner across viewer lifecycles", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom("read", "admit", "close"), { minLength: 1, maxLength: 40 }), commands => {
    const { db, managers } = fixture();
    const resolve = vi.fn(() => managers[0]!);
    const admission = new ProfileThreadOwnerAdmission(resolve);
    let closed = false;
    let admitted = false;
    try {
      expect(resolve).not.toHaveBeenCalled();
      for (const command of commands) {
        if (command === "admit") {
          if (closed) expect(() => admission.assertOwnership()).toThrow(/closed/);
          else { admission.assertOwnership(); admitted = true; }
        } else if (command === "close") {
          admission.close();
          closed = true;
        }
        expect(resolve).toHaveBeenCalledTimes(admitted ? 1 : 0);
        expect(managers[0]!.snapshot("federation").leaseHeld).toBe(admitted && !closed);
      }
    } finally { admission.close(); db.close(); }
  }), { numRuns: 35 });
});

// The independent owner is the actor with at least one retained claim. Service
// stops cannot erase a provider claim, and closing providers cannot stop a service.
it("matches a two-consumer owner model across generated admission and service lifecycles", () => {
  fc.assert(fc.property(fc.array(fc.record({
    actor: fc.integer({ min: 0, max: 1 }), claim: fc.constantFrom("runtime", "thread_owner"), acquire: fc.boolean(),
  }), { minLength: 1, maxLength: 80 }), commands => {
    const { db, managers } = fixture();
    let owner: number | undefined;
    const claims = new Set<string>();
    try {
      for (const command of commands) {
        const manager = managers[command.actor]!;
        if (command.acquire) {
          const allowed = owner === undefined || owner === command.actor;
          expect(manager.acquire("federation", command.claim).acquired).toBe(allowed);
          if (allowed) { owner = command.actor; claims.add(command.claim); }
        } else {
          const released = owner === command.actor && ![...claims].some(claim => claim !== command.claim);
          expect(manager.release("federation", command.claim)).toBe(released);
          if (owner === command.actor) {
            claims.delete(command.claim);
            if (claims.size === 0) owner = undefined;
          }
        }
        for (const [actor, observer] of managers.entries()) {
          expect(observer.snapshot("federation").leaseHeld).toBe(owner === actor);
        }
      }
    } finally { db.close(); }
  }), { numRuns: 40 });
});

it("leaves passive readers unclaimed, retries refused admission, and closes exactly once", () => {
  const { db, store, managers } = fixture();
  const first = new ProfileThreadOwnerAdmission(managers[0]!);
  const second = new ProfileThreadOwnerAdmission(managers[1]!);
  try {
    expect(store.getFederationLease()).toBeUndefined();
    expect(store.getInstance("actor-0")).toBeUndefined();
    first.assertOwnership();
    expect(() => second.assertOwnership()).toThrow(/another PwrAgent runtime/);
    first.close();
    second.assertOwnership();
    first.close();
    expect(managers[1]!.snapshot("federation").leaseHeld).toBe(true);
    expect(() => first.assertOwnership()).toThrow(/closed/);
    second.close();
    expect(store.getFederationLease()?.status).toBe("released");
  } finally { db.close(); }
});

it("retains claims after refused release so shutdown cannot free a live owner", () => {
  const { db, store, managers } = fixture();
  const admission = new ProfileThreadOwnerAdmission(managers[0]!);
  try {
    admission.assertOwnership();
    db.raw.exec("CREATE TRIGGER refuse_release BEFORE UPDATE ON messaging_runtime_lease BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
    expect(() => admission.close()).toThrow("fixture refusal");
    expect(managers[0]!.snapshot("federation").leaseHeld).toBe(true);
    expect(() => new ProfileThreadOwnerAdmission(managers[1]!).assertOwnership()).toThrow(/another PwrAgent runtime/);
    db.raw.exec("DROP TRIGGER refuse_release");
    admission.close();
    expect(store.getFederationLease()?.status).toBe("released");
  } finally { db.close(); }
});

it("budgets one owner lifetime and zero writes for repeated turn admission and passive reads", async () => {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const { dbPath, tempDir } = createTempStateDb("owner-admission-budget-");
  const { db, managers } = fixture(StateDb.open(dbPath, { profileName: "fixture" }));
  const admission = new ProfileThreadOwnerAdmission(managers[0]!);
  const budgetFile = "profile-owner-admission-write-budgets.json";
  try {
    const passive = await measureSqliteWrites(() => managers[0]!.snapshot("federation"));
    expectSqliteWriteBudget({ budgetFile, scenario: "passive-owner-read", note: "A passive viewer checks the profile without registering or claiming it", writes: passive.writes });
    const lifecycle = await measureSqliteWrites(async () => {
      admission.assertOwnership();
      const repeated = await measureSqliteWrites(() => {
        for (let turn = 0; turn < 1_000; turn++) admission.assertOwnership();
      });
      expectSqliteWriteBudget({ budgetFile, scenario: "repeated-owner-admission", note: "One thousand thread/turn/provider admissions after the first claim", writes: repeated.writes });
      admission.close();
      admission.close();
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "profile-owner-lifetime", note: "First owner admission registers the runtime and claims federation; provider shutdown releases it, schema excluded", writes: lifecycle.writes });
  } finally { db.close(); rmSync(tempDir, { force: true, recursive: true }); vi.unstubAllEnvs(); }
});
