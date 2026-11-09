import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalDurableTurnRequest } from "@pwragent/shared";
import { Outbox, type OutboxEntry } from "../../../../mobile/src/outbox";
import { DurableTurnRequestService } from "../federation/durable-turn-request-service";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

it("reconciles a real owner receipt after mobile and gateway restart without redispatching", async () => {
  const { dbPath, tempDir } = createTempStateDb("mobile-owner-integration-");
  let db = StateDb.open(dbPath); let dispatches = 0; let persisted: OutboxEntry[] = [];
  const storage = { read: async () => structuredClone(persisted), write: async (entries: OutboxEntry[]) => { persisted = structuredClone(entries); } };
  const mobile = () => new Outbox(storage, randomUUID, async (target, request, createdAt) => createHash("sha256").update(canonicalDurableTurnRequest(target.instanceId, { request, clientRequest: { version: 1, createdAt } })).digest("hex"));
  const owner = () => new DurableTurnRequestService({ stateDb: db, ownerInstanceId: "owner", authorize: async () => {}, dispatch: async (request) => { dispatches++; return { backend: request.backend, threadId: request.threadId, turnId: `turn-${dispatches}`, queueStatus: "started" }; } });
  try {
    let service = owner(); let outbox = mobile();
    const first = await outbox.enqueue({ instanceId: "owner", backend: "codex", threadId: "thread" }, "Run it", { gatewayId: "ingress", deviceId: "phone" });
    await outbox.deliver(first, async (entry) => {
      await service.submit("authenticated-phone", { clientRequest: { version: 1, id: entry.id, createdAt: entry.createdAt, payloadHash: entry.payloadHash }, request: entry.request });
      throw new Error("socket lost after durable dispatch receipt");
    });
    db.close(); db = StateDb.open(dbPath); service = owner(); outbox = mobile(); await outbox.load();
    const retry = outbox.entries[0]!;
    const receipt = await service.get("authenticated-phone", { id: retry.id, backend: retry.target.backend, threadId: retry.target.threadId });
    expect(receipt).not.toBeNull(); await outbox.reconcile(receipt!);
    expect(outbox.entries[0]?.turnId).toBe("turn-1"); expect(dispatches).toBe(1);
    const intentional = await outbox.enqueue(first.target, "Run it", { gatewayId: "ingress", deviceId: "phone" });
    await outbox.deliver(intentional, (entry) => service.submit("authenticated-phone", { clientRequest: { version: 1, id: entry.id, createdAt: entry.createdAt, payloadHash: entry.payloadHash }, request: entry.request }));
    expect(intentional.id).not.toBe(first.id); expect(dispatches).toBe(2);
  } finally { db.close(); removeTempStateDbDir(tempDir); }
});
