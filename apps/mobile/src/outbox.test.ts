import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Outbox, type OutboxEntry, type OutboxStorage } from "./outbox";
const target = { instanceId: "owner-a", backend: "codex" as const, threadId: "thread-a" };
const identity = { gatewayId: "ingress-a", deviceId: "phone-a" };
function fixture() {
  let disk: OutboxEntry[] = [];
  let writes = 0;
  const storage: OutboxStorage = { read: async () => structuredClone(disk), write: async (entries) => { disk = structuredClone(entries); writes++; } };
  const hash = async (...data: unknown[]) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return { storage, outbox: new Outbox(storage, randomUUID, hash), hash, writes: () => writes };
}
describe("durable mobile outbox", () => {
  it("persists before dispatch and retries the same identity after ack loss and restart", async () => {
    const { outbox, storage, hash } = fixture();
    const entry = await outbox.enqueue(target, "Run the check", identity);
    let dispatches = 0; let ownerReceipt: { id: string; payloadHash: string; state: "dispatched" } | undefined;
    await outbox.deliver(entry, async (request) => {
      expect((await storage.read())[0]).toEqual(request);
      dispatches++; ownerReceipt = { id: request.id, payloadHash: request.payloadHash, state: "dispatched" };
      throw new Error("ack lost");
    });
    const restarted = new Outbox(storage, randomUUID, hash); await restarted.load();
    expect(restarted.entries[0]?.id).toBe(entry.id);
    expect(restarted.entries[0]?.payloadHash).toBe(entry.payloadHash);
    await restarted.deliver(restarted.entries[0]!, async (retry) => {
      expect(retry.request).toEqual(entry.request); return ownerReceipt!;
    });
    expect(dispatches).toBe(1); expect(restarted.entries[0]?.state).toBe("dispatched");
  });
  it("keeps intentional identical prompts distinct and serializes concurrent persistence", async () => {
    const { outbox, storage } = fixture();
    const [a, b] = await Promise.all([outbox.enqueue(target, "Again", identity), outbox.enqueue(target, "Again", identity)]);
    expect(a.id).not.toBe(b.id); expect(await storage.read()).toHaveLength(2);
  });
  it("does not submit if persistence failed", async () => {
    const outbox = new Outbox({ read: async () => [], write: async () => { throw new Error("disk full"); } }, randomUUID, async () => "hash");
    await expect(outbox.enqueue(target, "hello", identity)).rejects.toThrow("disk full"); expect(outbox.entries).toEqual([]);
  });
  it("refuses mismatched receipts and does not replay uncertain requests", async () => {
    const { outbox } = fixture(); const entry = await outbox.enqueue(target, "hello", identity);
    await expect(outbox.reconcile({ id: entry.id, payloadHash: "other", state: "dispatched" })).rejects.toThrow("hash mismatch");
    await outbox.reconcile({ id: entry.id, payloadHash: entry.payloadHash, state: "uncertain" });
    let calls = 0; await outbox.deliver(outbox.entries[0]!, async () => { calls++; throw new Error("must not run"); }); expect(calls).toBe(0);
  });
  it("coalesces overlapping sends but never content-deduplicates requests", async () => {
    const { outbox, writes } = fixture(); const entry = await outbox.enqueue(target, "hello", identity);
    let calls = 0;
    const submit = async () => { calls++; return { id: entry.id, payloadHash: entry.payloadHash, state: "accepted" as const }; };
    await Promise.all([outbox.deliver(entry, submit), outbox.deliver(entry, submit)]);
    expect(calls).toBe(1); expect(writes()).toBe(2);
  });
});

it("persists steer operation and expected turn across restart, with no uncertain replay", async () => {
  const { outbox, storage, hash } = fixture();
  const entry = await outbox.enqueue(target, "Focus on tests", identity, "turn-running");
  const restarted = new Outbox(storage, randomUUID, hash); await restarted.load();
  expect(restarted.entries[0]).toMatchObject({ operation: "steerTurn", request: { expectedTurnId: "turn-running" }, id: entry.id, payloadHash: entry.payloadHash });
  await restarted.reconcile({ id: entry.id, payloadHash: entry.payloadHash, state: "uncertain" });
  let called = false;
  await restarted.deliver(restarted.entries[0]!, async () => { called = true; throw new Error("unsafe replay"); });
  expect(called).toBe(false);
});
