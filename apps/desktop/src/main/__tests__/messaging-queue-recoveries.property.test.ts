import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MessagingQueueRecoveries } from "../messaging/core/messaging-queue-recoveries";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { messagingCanonicalQueueHarness } from "./fixtures/messaging-canonical-queue-harness";
import { messagingModules } from "./fixtures/messaging-controller-modules";

const binding: MessagingBindingRecord = { id: "fixture", backend: "codex", threadId: "fixture", authorizedActorIds: [],
  channel: { channel: "telegram", conversation: { id: "fixture", kind: "dm" } }, createdAt: 1, updatedAt: 1 };

describe("held messaging input recovery", () => {
  it("reaches exclusive claims and both retry outcomes for generated independent held inputs", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("same input", "edited input", "other input"), { minLength: 2, maxLength: 5 }), inputs => {
      const owner = new MessagingQueueRecoveries({ now: () => 1 });
      try {
        const entries = inputs.map(preview => owner.hold({ binding, threadKey: "codex:fixture", preview, input: [{ type: "text", text: preview }] })!);
        expect(new Set(entries.map(entry => entry.id)).size).toBe(inputs.length);
        for (const [index, entry] of entries.entries()) {
          const claim = owner.claim(entry.id)!;
          expect(claim).toBeDefined();
          expect(owner.get(entry.id)).toBeUndefined();
          expect(owner.claim(entry.id)).toBeUndefined();
          expect(owner.cancel(entry.id)).toBe(false);
          owner.surface(entry.id, { channel: "telegram", id: "late fixture surface" });
          expect(owner.get(entry.id)).toBeUndefined();
          expect(owner.settle(entry.id, Symbol(), true)).toBeUndefined();
          expect(owner.size).toBe(inputs.length - index);
          expect(owner.settle(entry.id, claim.receipt, false)).toBeUndefined();
          expect(owner.get(entry.id)?.input).toEqual([{ type: "text", text: inputs[index] }]);
          const retry = owner.claim(entry.id)!;
          expect(retry).toBeDefined();
          owner.settle(entry.id, claim.receipt, true);
          expect(owner.size).toBe(inputs.length - index);
          expect(owner.settle(entry.id, retry.receipt, true)?.surface).toEqual({ channel: "telegram", id: "late fixture surface" });
          owner.surface(entry.id, { channel: "telegram", id: "after acceptance" });
          expect(owner.get(entry.id)).toBeUndefined();
          expect(owner.size).toBe(inputs.length - index - 1);
        }
      } finally { owner.dispose(); }
    }));
  });

  it("models explicit claims, failed retries, late deliveries and cleanup without an admission FIFO", () => {
    type Model = { closed: boolean; rows: Array<{ id: string; held: boolean; removed: boolean; receipt?: symbol }> };
    type Real = { owner: MessagingQueueRecoveries };
    const operations = fc.tuple(fc.constantFrom("hold", "claim", "fail", "accept", "cancel", "surface", "stale", "dispose"), fc.nat({ max: 4 })).map(([operation, index]) => ({
      check: (model: Model) => operation === "hold" || operation === "dispose" || model.rows.length > 0,
      run: (model: Model, real: Real) => {
        const row = model.rows[index % model.rows.length];
        switch (operation) {
          case "hold": {
            const entry = real.owner.hold({ binding, threadKey: "codex:fixture", preview: "fixture", input: [{ type: "text", text: "fixture" }] });
            expect(Boolean(entry)).toBe(!model.closed);
            if (entry) model.rows.push({ id: entry.id, held: true, removed: false });
            break;
          }
          case "claim": {
            const claim = real.owner.claim(row!.id);
            expect(Boolean(claim)).toBe(row!.held && !row!.removed);
            if (claim) { row!.held = false; row!.receipt = claim.receipt; }
            break;
          }
          case "fail": case "accept":
            if (row!.receipt) {
              real.owner.settle(row!.id, row!.receipt, operation === "accept");
              if (!row!.removed) { row!.removed = operation === "accept"; row!.held = !row!.removed; }
              row!.receipt = undefined;
            }
            break;
          case "cancel":
            expect(real.owner.cancel(row!.id)).toBe(row!.held && !row!.removed);
            if (row!.held) row!.removed = true;
            break;
          case "surface": real.owner.surface(row!.id, { channel: "telegram", id: "late fixture surface" }); break;
          case "stale": real.owner.settle(row!.id, Symbol(), true); break;
          case "dispose":
            real.owner.dispose(); model.closed = true;
            model.rows.forEach(row => { row.removed = true; });
            break;
        }
        for (const candidate of model.rows) expect(Boolean(real.owner.get(candidate.id))).toBe(candidate.held && !candidate.removed);
        expect(real.owner.size).toBe(model.rows.filter(row => !row.removed).length);
      }, toString: () => `${operation}(${index})`,
    }));
    fc.assert(fc.property(fc.commands([operations], { maxCommands: 30, size: "max" }), commands => {
      const owner = new MessagingQueueRecoveries({ now: () => 1 });
      try { fc.modelRun(() => ({ model: { closed: false, rows: [] }, real: { owner } }), commands); }
      finally { owner.dispose(); }
    }));
  });

  it("reads the clock lazily, retains independent held inputs and retires a late surface after cancellation", () => {
    let reads = 0;
    let now = () => 10;
    const owner = new MessagingQueueRecoveries({ get now() { reads++; return now; } });
    expect(reads).toBe(0);
    const first = owner.hold({ binding, threadKey: "codex:fixture", preview: "first", input: [] })!;
    now = () => 20;
    const second = owner.hold({ binding, threadKey: "codex:fixture", preview: "second", input: [] })!;
    expect([first.createdAt, second.createdAt]).toEqual([10, 20]);
    expect(first.id).not.toBe(second.id);
    expect(owner.cancel(first.id)).toBe(true);
    owner.surface(first.id, { channel: "telegram", id: "late" });
    expect(owner.get(first.id)).toBeUndefined();
    expect(owner.get(second.id)).toEqual(second);
    expect(owner.size).toBe(1);
    owner.dispose();
    expect(owner.size).toBe(0);
  });

  it("cleans the actual recovery owner when its controller shuts down", async () => {
    const real = await messagingCanonicalQueueHarness();
    try {
      const recoveries = messagingModules(real.controller).queueRecoveries;
      recoveries.hold({ binding, threadKey: "codex:fixture", preview: "fixture", input: [] });
      expect(recoveries.size).toBe(1);
      real.controller.dispose();
      expect(recoveries.size).toBe(0);
    } finally { await real.close(); }
  });
});
