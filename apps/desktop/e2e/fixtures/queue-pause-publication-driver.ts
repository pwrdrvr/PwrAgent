import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { AgentEvent } from "@pwragent/shared";
import { DEFAULT_PROJECT_FORGE_AUTOMATION } from "@pwragent/shared";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { DesktopBackendRegistry } from "../../src/main/app-server/backend-registry";
import { CodexAppServerClient } from "../../src/main/codex-app-server/desktop-client";
import { DesktopConfigStore } from "../../src/main/settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../../src/main/storage/overlay-store-sqlite";
import { StateDb } from "../../src/main/storage/state-db";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../../src/main/storage/desktop-overlay-store";
import { OwnerConformanceCodexTransport } from "../../src/main/__tests__/fixtures/owner-conformance-codex-transport";
import { ProjectHeldWakeupStore } from "../../src/main/state/project-held-wakeup-store";
import { getProjectForgeAutomationIndex, resetProjectForgeAutomationIndexForTests } from "../../src/main/app-server/project-forge-automation-index";

// This separate owner uses actual desktop construction, native protocol fixture
// responses and real SQLite in Electron. It cannot reach an installed agent.
export async function exerciseDesktopPausePublication(root: string, initiallyPaused: boolean) {
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
    threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "invented-pause-owner",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  const events: AgentEvent[] = [];
  const stopEvents = registry.onEvent(event => { events.push(event); });
  try {
    const identity = await registry.startThread({ backend: "codex", cwd: root });
    const active = await registry.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const queueEntryId = "invented-pause-cancel";
    const input = [{ type: "text" as const, text: "Invented immutable pause input" }];
    await registry.submitTurn({ ...identity, queueEntryId, delivery: "new_turn", input });
    if (initiallyPaused) await registry.setQueuedTurnPaused({ queueEntryId, paused: true });
    const accepted = await registry.readQueuedTurn({ ...identity, queueEntryId });
    const offset = events.length;
    const pause = registry.setQueuedTurnPaused({ queueEntryId, paused: !initiallyPaused });
    await Promise.resolve();
    const cancelled = registry.cancelQueuedTurnWithDisposition(queueEntryId);
    await pause;
    await new Promise<void>(resolve => setImmediate(resolve));
    const statuses = events.slice(offset).flatMap(event => event.notification.method === "thread/turnQueue/updated"
      && event.notification.params.queueEntryId === queueEntryId ? [event.notification.params.status] : []);
    const waiting = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue.getQueuedEntries(identity);
    await registry.interruptTurn(active);
    return { cancelled, statuses, waiting: waiting.map(row => row.id), input: accepted.input,
      nativeStarts: OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start").length };
  } finally {
    stopEvents();
    await registry.close();
    await client.close();
    configStore.dispose();
    resetDesktopOverlayStoreForTests();
    db.close();
  }
}

export async function exerciseDesktopWakeupPauseDurability(root: string) {
  await mkdir(root, { recursive: true });
  const configPath = path.join(root, "config.toml");
  await writeFile(configPath, "");
  const db = StateDb.open(path.join(root, "state.db"));
  const overlayStore = new SqliteOverlayStore(db);
  const wakeups = new ProjectHeldWakeupStore(db.raw, { processId: 4_242, processAlive: () => false });
  setDesktopOverlayStoreForTests(overlayStore);
  const configStore = new DesktopConfigStore({ configPath });
  configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  OwnerConformanceCodexTransport.reset();
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const registry = new DesktopBackendRegistry({ codexClient: client, configStore, overlayStore, messagingStore: null,
    projectHeldWakeupStore: wakeups, threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "invented-wakeup-owner",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  let reopened: DesktopBackendRegistry | undefined;
  let reopenedClient: CodexAppServerClient | undefined;
  try {
    const identity = await registry.startThread({ backend: "codex", cwd: root });
    await registry.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const directoryKey = `directory:${root}`;
    const index = getProjectForgeAutomationIndex();
    index.set(directoryKey, { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true, pausedAt: 1_000 });
    index.rememberDirectories([{ key: directoryKey, kind: "directory", label: "Invented paused project", path: root,
      threadKeys: [`codex:${identity.threadId}`], needsAttentionCount: 0 }]);
    const queueEntryId = "invented-sent-wakeup";
    const input = [{ type: "text" as const, text: "Invented immutable monitor result" }];
    await registry.deliverProjectPausedWakeup({ ...identity, project: index.resolveThread(identity)!, queueEntryId, input,
      origin: "manual", source: "monitor", summary: "Invented monitor result" });
    await registry.resolveProjectHeldWakeups({ directoryKey, resolutions: [{ ...identity, entryId: queueEntryId, action: "send" }] });
    const accepted = await registry.readQueuedTurn({ ...identity, queueEntryId });
    const events: AgentEvent[] = [];
    registry.onEvent(event => { events.push(event); });
    await Promise.all([true, false].map(paused => registry.setQueuedTurnPaused({ queueEntryId, paused })));
    const durableRows = Number((db.raw.prepare("SELECT COUNT(*) AS count FROM project_held_wakeups").get() as { count: number }).count);
    const live = registry.getQueuedTurnsForThread(identity)[0]!;
    const last = events.flatMap(event => event.notification.method === "thread/turnQueue/updated"
      && event.notification.params.queueEntryId === queueEntryId ? [event.notification.params] : []).at(-1)!;
    const unchangedInput = JSON.stringify(await registry.readQueuedTurn({ ...identity, queueEntryId })) === JSON.stringify(accepted);
    await registry.close();
    await client.close();
    reopenedClient = new CodexAppServerClient({ directoryResolver: async () => [] });
    reopened = new DesktopBackendRegistry({ codexClient: reopenedClient, configStore, overlayStore, messagingStore: null,
      projectHeldWakeupStore: wakeups, threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "invented-wakeup-reopened",
      resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
    return { durableRows, restoredHolds: reopened.listProjectHeldWakeups(directoryKey).length, restoredWaiting: reopened.getQueuedTurnsForThread(identity).length,
      paused: Boolean(live.paused), publishedPaused: Boolean(last.paused), revision: live.pauseRevision, publishedRevision: last.pauseRevision,
      unchangedInput, nativeStarts: OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start").length };
  } finally {
    await registry.close();
    await client.close();
    await reopened?.close();
    await reopenedClient?.close();
    configStore.dispose();
    resetProjectForgeAutomationIndexForTests();
    resetDesktopOverlayStoreForTests();
    db.close();
  }
}
