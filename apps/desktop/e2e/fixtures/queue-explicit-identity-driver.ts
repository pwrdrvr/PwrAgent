import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DesktopBackendRegistry } from "../../src/main/app-server/backend-registry";
import { CodexAppServerClient } from "../../src/main/codex-app-server/desktop-client";
import { DesktopConfigStore } from "../../src/main/settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../../src/main/storage/overlay-store-sqlite";
import { StateDb } from "../../src/main/storage/state-db";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../../src/main/storage/desktop-overlay-store";
import { OwnerConformanceCodexTransport } from "../../src/main/__tests__/fixtures/owner-conformance-codex-transport";

export async function exerciseExplicitQueueIdentity(root: string) {
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
    threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "invented-explicit-owner",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  const statuses: string[] = [];
  const stop = registry.onEvent(event => {
    if (event.notification.method === "thread/turnQueue/updated" && event.notification.params.queueEntryId === "explicit-identity"
      && typeof event.notification.params.status === "string") {
      statuses.push(event.notification.params.status);
    }
  });
  try {
    const created = await registry.startThread({ backend: "codex", cwd: root });
    const identity = { backend: "codex" as const, threadId: created.threadId };
    const active = await registry.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const request = { ...identity, queueEntryId: "explicit-identity", delivery: "new_turn" as const,
      input: [{ type: "text" as const, text: "Original immutable acceptance" }] };
    const admissions = await Promise.all([registry.submitTurn(request), registry.submitTurn(request), registry.submitTurn(request)]);
    const original = await registry.readQueuedTurn(request);
    await registry.setQueuedTurnPaused({ queueEntryId: request.queueEntryId, paused: true });
    await registry.submitTurn(request);
    let changedRefused = false;
    try { await registry.submitTurn({ ...request, input: [{ type: "text", text: "Different acceptance" }] }); }
    catch (error) { changedRefused = error instanceof Error && error.message.includes("reused"); }
    const current = await registry.readQueuedTurn(request);
    if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error("A retry changed the accepted snapshot");
    const cancelled = registry.cancelQueuedTurnWithDisposition(request.queueEntryId, undefined, original.contentHash);
    let retired = false;
    try { await registry.readQueuedTurn(request); } catch { retired = true; }
    await registry.interruptTurn(active);
    return { ids: admissions.map(result => result.entry.id), changedRefused, retired, cancelled: cancelled.disposition,
      statuses, nativeStarts: OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start").length };
  } finally {
    stop();
    await registry.close();
    await client.close();
    configStore.dispose();
    resetDesktopOverlayStoreForTests();
    db.close();
  }
}
