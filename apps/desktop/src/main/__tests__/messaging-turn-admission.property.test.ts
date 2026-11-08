import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { MessagingTurnAdmission, threadKeyForBinding, type MessagingQueuedTurnEntry } from "../messaging/core/messaging-turn-admission";

type Phase = "queued" | "steering" | "submitting" | "done" | "cancelled";
type Model = { entries: { id: string; phase: Phase }[] };
type Real = { admission: MessagingTurnAdmission; binding: MessagingBindingRecord; threadKey: string; receipts: Map<string, MessagingQueuedTurnEntry> };
type Operation = "enqueue" | "steer" | "submit" | "cancel" | "finish" | "fail" | "shift" | "surface";

class QueueCommand implements fc.Command<Model, Real> {
  constructor(private readonly operation: Operation, private readonly index: number) {}

  check(): boolean { return true; }

  run(model: Model, real: Real): void {
    const { admission, binding, threadKey } = real;
    const selected = model.entries[this.index % Math.max(1, model.entries.length)];
    const actual = selected ? admission.findQueuedEntry(selected.id) : undefined;
    switch (this.operation) {
      case "enqueue": {
        const entry = admission.enqueue({ binding, threadKey, preview: "fixture", input: [{ type: "text", text: "fixture" }] });
        model.entries.push({ id: entry.id, phase: "queued" });
        real.receipts.set(entry.id, entry);
        break;
      }
      case "surface":
        if (selected) admission.updateQueuedEntry(real.receipts.get(selected.id)!, { surface: { channel: "telegram", id: "delivered" } });
        break;
      case "steer":
      case "submit":
      case "cancel":
        // Automatic submission can claim only the FIFO head; a person can
        // steer or cancel any still-queued card.
        if (selected?.phase === "queued" && (this.operation !== "submit"
          || model.entries.find((entry) => !["done", "cancelled"].includes(entry.phase)) === selected)) {
          selected.phase = this.operation === "steer" ? "steering" : this.operation === "submit" ? "submitting" : "cancelled";
          admission.updateQueuedEntry(actual!, { status: selected.phase });
        }
        break;
      case "finish":
      case "fail":
        if (selected?.phase === "steering" || selected?.phase === "submitting") {
          const wasSteering = selected.phase === "steering";
          selected.phase = this.operation === "fail" ? "queued" : "done";
          admission.updateQueuedEntry(actual!, { status: this.operation === "fail" ? "queued" : wasSteering ? "steered" : "submitted" });
        }
        break;
      case "shift": {
        const head = model.entries.find((entry) => !["done", "cancelled"].includes(entry.phase));
        expect(admission.shiftNextQueued(threadKey)?.id).toBe(head?.phase === "queued" ? head.id : undefined);
        if (head?.phase === "queued") head.phase = "done";
        break;
      }
    }
    // Oracle: a FIFO list with an exclusive in-flight owner. Neither a read
    // nor a drain removes that owner or advances past it before settlement.
    const head = model.entries.find((entry) => !["done", "cancelled"].includes(entry.phase));
    expect(admission.peekNextQueued(threadKey)?.id).toBe(head?.phase === "queued" ? head.id : undefined);
    for (const entry of model.entries.filter((entry) => entry.phase === "steering" || entry.phase === "submitting")) {
      expect(admission.findQueuedEntry(entry.id)?.status).toBe(entry.phase);
    }
  }

  toString(): string { return `${this.operation}(${this.index})`; }
}

describe("MessagingTurnAdmission ownership model", () => {
  it("does not revive cancellation when delivery finishes with an older entry snapshot", () => {
    const binding: MessagingBindingRecord = {
      id: "fixture", backend: "codex", threadId: "fixture", authorizedActorIds: ["fixture"],
      channel: { channel: "telegram", conversation: { id: "fixture", kind: "dm" } }, createdAt: 1000, updatedAt: 1000,
    };
    const admission = new MessagingTurnAdmission({ debounceMs: 0, now: () => 1000, onBundleReady: () => undefined });
    const threadKey = threadKeyForBinding(binding);
    const snapshot = admission.enqueue({ binding, threadKey, preview: "fixture", input: [] });
    admission.updateQueuedEntry(snapshot, { status: "cancelled" });
    admission.updateQueuedEntry(snapshot, { surface: { channel: "telegram", id: "late-delivery" } });
    expect(admission.findQueuedEntry(snapshot.id)?.status).toBe("cancelled");
    expect(admission.peekNextQueued(threadKey)).toBeUndefined();
    admission.dispose();
  });

  it.each(["steering", "submitting"] as const)("retains a %s head until its owner settles", (status) => {
    const binding: MessagingBindingRecord = {
      id: "fixture", backend: "codex", threadId: "fixture", authorizedActorIds: ["fixture"],
      channel: { channel: "telegram", conversation: { id: "fixture", kind: "dm" } }, createdAt: 1000, updatedAt: 1000,
    };
    const admission = new MessagingTurnAdmission({ debounceMs: 0, now: () => 1000, onBundleReady: () => undefined });
    const threadKey = threadKeyForBinding(binding);
    const entry = admission.enqueue({ binding, threadKey, preview: "fixture", input: [] });
    admission.enqueue({ binding, threadKey, preview: "next", input: [] });
    admission.updateQueuedEntry(entry, { status });
    expect(admission.peekNextQueued(threadKey)).toBeUndefined();
    expect(admission.shiftNextQueued(threadKey)).toBeUndefined();
    expect(admission.findQueuedEntry(entry.id)?.status).toBe(status);
    admission.updateQueuedEntry(entry, { status: "queued" });
    expect(admission.peekNextQueued(threadKey)?.id).toBe(entry.id);
    admission.dispose();
  });

  it("preserves FIFO and in-flight claims through generated cancellation and settlement sequences", () => {
    const commands = fc.commands([fc.tuple(fc.constantFrom<Operation>(
      "enqueue", "steer", "submit", "cancel", "finish", "fail", "shift", "surface",
    ), fc.nat({ max: 15 })).map(([operation, index]) => new QueueCommand(operation, index))], { maxCommands: 50 });
    fc.assert(fc.property(commands, (sequence) => {
      const binding: MessagingBindingRecord = {
        id: "fixture", backend: "codex", threadId: "fixture", authorizedActorIds: ["fixture"],
        channel: { channel: "telegram", conversation: { id: "fixture", kind: "dm" } }, createdAt: 1000, updatedAt: 1000,
      };
      const admission = new MessagingTurnAdmission({ debounceMs: 0, now: () => 1000, onBundleReady: () => undefined });
      try {
        fc.modelRun(() => ({ model: { entries: [] }, real: { admission, binding, threadKey: threadKeyForBinding(binding), receipts: new Map() } }), sequence);
      } finally {
        admission.dispose();
      }
    }));
  });
});
