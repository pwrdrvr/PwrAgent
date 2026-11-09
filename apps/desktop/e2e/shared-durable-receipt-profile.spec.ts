import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDurableTurnRequest } from "@pwragent/shared";
import type { DurableTurnReceipt, SubmitDurableTurnRequest } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteDurableTurnRequestStore } from "@pwragent/sqlite-storage/durable-turn-request-store";
import { durableFederationCallerScope, FEDERATION_BACKEND_METHODS } from "../src/main/federation/federation-backend-bridge";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { startInProcessFederationGateway } from "./fixtures/federation-gateway";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("desktop reconciles portable receipts and returns a new committed receipt through the real federation owner", async ({ browserName: _browserName }, testInfo) => {
  const gateway = await startInProcessFederationGateway({ threads: [] });
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  const now = Date.now();
  const callerScope = "invented-device";
  const scope = durableFederationCallerScope(gateway.instanceId, callerScope);
  const completedId = randomUUID();
  const ambiguousId = randomUUID();
  const fixture = JSON.parse(await readFile(path.join(specDir, "fixtures/smoke/replay.fixture.json"), "utf8")) as ReplayFixture;
  fixture.steps.push({ id: "portable-receipt-turn", kind: "response", method: "turn/start",
    result: { threadId: "thread-smoke", turnId: "durable-electron-turn" } });
  const fixturePath = testInfo.outputPath("durable-receipt.fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture));
  try {
    app = await launchElectronApp({ fixturePath, secretStorage: "memory", preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new SqliteDurableTurnRequestStore(db);
        store.transaction(() => {
          for (const id of [completedId, ambiguousId]) store.insert(scope, {
            version: 1, id, payloadHash: "portable-hash", ownerInstanceId: "portable-owner", backend: "codex",
            threadId: "thread-smoke", queueEntryId: `portable:${id}`, acceptedAt: now - 600_000,
            updatedAt: now - 600_000, expiresAt: now + 86_400_000,
            ...(id === completedId ? { state: "completed", outcome: "completed" } : { state: "dispatching" }),
          });
        });
      } finally { db.close(); }
    } });
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    await app.window.getByRole("button", { name: "Open settings" }).click();
    await app.window.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Federation", exact: true }).click();
    await app.window.getByLabel("Import invite").fill(gateway.invite);
    await app.window.getByRole("button", { name: "Import invite" }).click();
    await gateway.waitForConnection();
    await expect(app.window.getByRole("region", { name: "Connection" }).getByText("Connected", { exact: true })).toBeVisible();
    const { instanceId, rpc } = gateway.desktopPeer();
    const lookup = (id: string, caller = callerScope) => rpc.request<DurableTurnReceipt | null>({
      method: FEDERATION_BACKEND_METHODS.getTurnRequest,
      params: { id, backend: "codex", threadId: "thread-smoke", callerScope: caller },
    });
    expect(await lookup(completedId)).toMatchObject({ state: "completed", outcome: "completed" });
    expect(await lookup(ambiguousId)).toMatchObject({ state: "uncertain" });
    expect(await lookup(completedId, "other-invented-device")).toBeNull();
    const submission: SubmitDurableTurnRequest = {
      clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
      request: { backend: "codex", threadId: "thread-smoke", input: [{ type: "text", text: "Invented durable Electron input" }] },
    };
    submission.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(instanceId, submission)).digest("hex");
    const submit = () => rpc.request<DurableTurnReceipt>({ method: FEDERATION_BACKEND_METHODS.submitTurnRequest,
      params: { ...submission, callerScope } });
    const receipt = await submit();
    expect(receipt).toMatchObject({ state: "dispatched", ownerInstanceId: instanceId,
      result: { threadId: "thread-smoke", turnId: "durable-electron-turn" } });
    // turn/start has a single-use replay response. Repeating a provider send
    // would fail; every retry must instead return this persisted acceptance.
    expect(await submit()).toEqual(receipt);
    expect(await lookup(receipt.id)).toEqual(receipt);
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new SqliteDurableTurnRequestStore(db);
      expect(store.read(scope, receipt.id)).toEqual(receipt);
      expect(store.read(scope, ambiguousId)).toMatchObject({ state: "uncertain" });
      expect(store.read(scope, completedId)).toMatchObject({ state: "completed", outcome: "completed" });
      expect(store.findQueueReceipt(receipt.queueEntryId)).toEqual({ scope, receipt });
      expect(store.count(scope)).toBe(3);
    } finally { db.close(); }
  } finally { await app?.close(); await gateway.close(); }
});
