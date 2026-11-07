import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ScheduledThreadActionStorage } from "@pwragent/owner-core/scheduled-thread-action-storage";
import type { ScheduledThreadAction } from "@pwragent/shared";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

type Model = {
  action: ScheduledThreadAction;
  claim?: { ownerId: string; leaseExpiresAt: number };
  now: number;
};

const operation = fc.record({
  kind: fc.constantFrom("claim", "due", "queue", "start", "hold", "renew", "recover", "cancel", "update"),
  ownerId: fc.constantFrom("first", "second"),
  advance: fc.integer({ min: 0, max: 35_000 }),
  protectOwner: fc.boolean(),
});
type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never;

const expiredDispatchMessage =
  "The scheduler lease expired while this action was being dispatched. Check the thread before scheduling it again.";

class LifecycleCommand implements fc.AsyncCommand<Model, ScheduledThreadActionStorage> {
  constructor(private readonly op: Operation) {}
  check(): boolean { return true; }
  toString(): string { return JSON.stringify(this.op); }

  async run(model: Model, storage: ScheduledThreadActionStorage): Promise<void> {
    const op = this.op;
    model.now += op.advance;
    const now = model.now;
    const action = model.action;
    const claim = { ownerId: op.ownerId, now, leaseExpiresAt: now + 30_000 };
    const inFlight = action.status === "dispatching" || action.status === "queued";
    const owned = inFlight && model.claim?.ownerId === op.ownerId;
    const expired = inFlight && model.claim !== undefined && model.claim.leaseExpiresAt <= now;
    let actual: unknown;
    let expected: unknown;
    const transition = (patch: Partial<ScheduledThreadAction>, clearClaim = false) => {
      model.action = { ...action, ...patch, updatedAt: now };
      if (clearClaim) model.claim = undefined;
      return model.action;
    };

    // Model the public scheduler rules, without SQLite, payload refs or store
    // helpers: one claimant owns callbacks; only unprotected expired claims
    // recover; a held action always requires another explicit release.
    switch (op.kind) {
      case "claim":
      case "due": {
        actual = op.kind === "claim" ? storage.claim(action.id, claim) : storage.claimNextDue(claim);
        const eligible = op.kind === "claim"
          ? action.status === "held" || action.status === "scheduled"
          : action.status === "scheduled" && action.scheduledFor <= now;
        if (eligible) {
          model.claim = { ownerId: op.ownerId, leaseExpiresAt: claim.leaseExpiresAt };
          expected = transition({ status: "dispatching" });
        }
        break;
      }
      case "queue":
        actual = storage.markQueued(action.id, "queue-1", now, op.ownerId);
        if (owned && action.status === "dispatching") expected = transition({ status: "queued", queueEntryId: "queue-1" });
        break;
      case "start":
        actual = storage.markStarted(action.id, "turn-1", now, op.ownerId);
        if (owned) expected = transition({ status: "started", turnId: "turn-1", errorMessage: undefined }, true);
        break;
      case "hold":
        actual = storage.markHeld(action.id, "queue-1", "Thread is locked", now, op.ownerId);
        if (owned) expected = transition({ status: "held", queueEntryId: "queue-1",
          errorMessage: "Thread is locked", manualReleaseRequired: true }, true);
        break;
      case "renew":
        actual = storage.renewClaims(op.ownerId, now, claim.leaseExpiresAt);
        if (owned) {
          model.claim = { ownerId: op.ownerId, leaseExpiresAt: claim.leaseExpiresAt };
          transition({});
        }
        break;
      case "recover": {
        const protectedOwners = new Set<string>(op.protectOwner ? [op.ownerId] : []);
        actual = storage.recoverExpiredClaims(now, protectedOwners);
        expected = [];
        if (expired && !protectedOwners.has(model.claim!.ownerId)) {
          expected = [action.manualReleaseRequired
            ? transition({ status: "held", queueEntryId: undefined }, true)
            : action.status === "queued"
              ? transition({ status: "scheduled", queueEntryId: undefined }, true)
              : transition({ status: "failed", errorMessage: expiredDispatchMessage }, true)];
        }
        break;
      }
      case "cancel":
        actual = storage.cancel(action.id, now);
        if (action.status === "held" || action.status === "scheduled") expected = transition({ status: "cancelled" });
        break;
      case "update": {
        const displayText = `Updated at ${now}`;
        const turn = { input: [{ type: "text" as const, text: displayText }] };
        actual = storage.update(action.id, { displayText, turn, now });
        if (action.status === "scheduled") expected = transition({ displayText, turn });
        break;
      }
    }
    expect(actual, this.toString()).toEqual(expected);
    const { writes } = await measureSqliteWrites(() => {
      expect(storage.get(action.id)).toEqual(model.action);
      expect(storage.list({ includeTerminal: true })).toEqual([model.action]);
      expect(storage.nextScheduledAt()).toBe(model.action.status === "scheduled" ? model.action.scheduledFor : undefined);
      const leaseExpired = model.claim && model.claim.leaseExpiresAt <= now;
      expect(storage.expiredClaimOwnerIds(now)).toEqual(leaseExpired ? [model.claim!.ownerId] : []);
    });
    expect(writes.commits).toBe(0);
    expect(writes.rowsChanged).toBe(0);
  }
}

it("preserves payloads, claim ownership and recovery through the scheduled-action storage port", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const commands = fc.commands([operation.map(op => new LifecycleCommand(op))], { maxCommands: 40 });
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.string({ maxLength: 200 }), commands,
    async (manualReleaseRequired, displayText, sequence) => {
      const db = openInMemoryStateDb();
      const storage: ScheduledThreadActionStorage = new ScheduledThreadActionStore(db);
      const action: ScheduledThreadAction = {
        id: "action-1", backend: "codex", threadId: "thread-1", kind: "turn", origin: "desktop",
        status: manualReleaseRequired ? "held" : "scheduled", scheduledFor: 20_000,
        displayText, turn: { input: [{ type: "text", text: displayText }] },
        manualReleaseRequired, createdAt: 1_000, updatedAt: 1_000,
      };
      try {
        storage.create({ ...action, now: 1_000 });
        await fc.asyncModelRun(() => ({ model: { action, now: 1_000 }, real: storage }), sequence);
      } finally { db.close(); }
    }), { numRuns: 100 });
});
