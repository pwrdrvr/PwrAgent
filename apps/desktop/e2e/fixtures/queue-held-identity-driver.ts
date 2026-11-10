import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DesktopBackendRegistry } from "../../src/main/app-server/backend-registry";
import { CodexAppServerClient } from "../../src/main/codex-app-server/desktop-client";
import { DesktopConfigStore } from "../../src/main/settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../../src/main/storage/overlay-store-sqlite";
import { StateDb } from "../../src/main/storage/state-db";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../../src/main/storage/desktop-overlay-store";
import { OwnerConformanceCodexTransport } from "../../src/main/__tests__/fixtures/owner-conformance-codex-transport";
import { ScheduledThreadActionService } from "../../src/main/scheduled-actions/scheduled-thread-action-service";
import { ScheduledThreadActionStore } from "../../src/main/storage/scheduled-thread-action-store";

export async function exerciseHeldQueueIdentity(root: string) {
  await mkdir(root, { recursive: true });
  const configPath = path.join(root, "config.toml");
  await writeFile(configPath, "");
  const db = StateDb.open(path.join(root, "state.db"));
  const overlayStore = new SqliteOverlayStore(db);
  setDesktopOverlayStoreForTests(overlayStore);
  const configStore = new DesktopConfigStore({ configPath });
  configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  OwnerConformanceCodexTransport.reset();
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const registry = new DesktopBackendRegistry({ codexClient: client, configStore, overlayStore, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "invented-held-owner",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  const scheduler = new ScheduledThreadActionService({ registry, store: new ScheduledThreadActionStore(db) });
  scheduler.start();
  try {
    const created = await registry.startThread({ backend: "codex", cwd: root });
    const identity = { backend: "codex" as const, threadId: created.threadId };
    const active = await registry.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const ordinary = { ...identity, queueEntryId: "ordinary-identity", delivery: "new_turn" as const,
      input: [{ type: "text" as const, text: "Original ordinary acceptance" }] };
    await registry.submitTurn(ordinary);
    const snapshot = await registry.readQueuedTurn(ordinary);
    let ordinaryRefused = false;
    try { await registry.submitHeldTurn({ ...ordinary, holdReason: "Review required" }); }
    catch (error) { ordinaryRefused = error instanceof Error && error.message.includes("reused"); }
    if (JSON.stringify(await registry.readQueuedTurn(ordinary)) !== JSON.stringify(snapshot)) throw new Error("Foreign admission changed ordinary input");
    const request = { ...identity, queueEntryId: "held-identity", origin: "scheduled" as const,
      input: [{ type: "text" as const, text: "Alice's accepted review" }], holdReason: "Alice review",
      messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "alice" } } };
    const admissions = await Promise.all([registry.submitHeldTurn(request), registry.submitHeldTurn(request), registry.submitHeldTurn(request)]);
    const before = registry.getQueuedTurnsForThread(identity);
    let ownerRefused = false, causeRefused = false;
    try { await registry.submitHeldTurn({ ...request, messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } }); }
    catch (error) { ownerRefused = error instanceof Error && error.message.includes("reused"); }
    try { await registry.submitHeldTurn({ ...request, holdReason: "Bob review" }); }
    catch (error) { causeRefused = error instanceof Error && error.message.includes("reused"); }
    await registry.submitHeldTurn(request);
    const unchanged = JSON.stringify(registry.getQueuedTurnsForThread(identity)) === JSON.stringify(before);
    const scheduledId = "electron-held-collision";
    const scheduledEntry = { ...ordinary, queueEntryId: `scheduled-turn:${scheduledId}` };
    await registry.submitTurn(scheduledEntry);
    const scheduledSnapshot = await registry.readQueuedTurn(scheduledEntry);
    await scheduler.create({ ...identity, kind: "turn", scheduledFor: Date.now() + 60_000,
      manualReleaseRequired: true, displayText: "Invented held collision", turn: { input: ordinary.input } }, { id: scheduledId });
    let scheduledRefused = false;
    try { await scheduler.sendNow({ id: scheduledId }); }
    catch (error) { scheduledRefused = error instanceof Error && error.message.includes("reused"); }
    if (scheduler.get(scheduledId)?.status !== "failed") throw new Error("Collision did not fail the scheduled action");
    await scheduler.cancel({ id: scheduledId });
    if (JSON.stringify(await registry.readQueuedTurn(scheduledEntry)) !== JSON.stringify(scheduledSnapshot)) throw new Error("Scheduled dismissal cancelled another acceptance");
    registry.cancelQueuedTurnWithDisposition("held-identity");
    registry.cancelQueuedTurnWithDisposition("ordinary-identity");
    registry.cancelQueuedTurnWithDisposition(scheduledEntry.queueEntryId);
    await registry.interruptTurn(active);
    return { ordinaryRefused, ownerRefused, causeRefused, scheduledRefused, ids: admissions.map(result => result.entry.id), unchanged,
      nativeStarts: OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start").length };
  } finally {
    scheduler.dispose();
    await registry.close();
    await client.close();
    configStore.dispose();
    resetDesktopOverlayStoreForTests();
    db.close();
  }
}
