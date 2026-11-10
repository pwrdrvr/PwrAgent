import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { AgentEvent } from "@pwragent/shared";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { DesktopBackendRegistry } from "../../src/main/app-server/backend-registry";
import { CodexAppServerClient } from "../../src/main/codex-app-server/desktop-client";
import { DesktopConfigStore } from "../../src/main/settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../../src/main/storage/overlay-store-sqlite";
import { StateDb } from "../../src/main/storage/state-db";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../../src/main/storage/desktop-overlay-store";
import { OwnerConformanceCodexTransport } from "../../src/main/__tests__/fixtures/owner-conformance-codex-transport";
import { ThreadCorrespondenceStore } from "../../src/main/app-server/thread-correspondence-store";

// This separate owner uses actual desktop construction, native protocol fixture
// responses and real SQLite in Electron. It cannot reach an installed agent.
export async function exerciseDesktopAgentReplacement(root: string, grouped: boolean) {
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
  const correspondenceDirectory = path.join(root, "correspondence");
  const registry = new DesktopBackendRegistry({ codexClient: client, configStore, overlayStore, messagingStore: null,
    correspondenceStore: new ThreadCorrespondenceStore(correspondenceDirectory),
    threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "invented-replacement-owner",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  const events: AgentEvent[] = [];
  const stopEvents = registry.onEvent(event => { events.push(event); });
  try {
    const created = await registry.startThread({ backend: "codex", cwd: root });
    const identity = { backend: "codex" as const, threadId: created.threadId };
    const active = await registry.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
    const messageOrigin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "alice" } };
    if (grouped) await registry.submitHeldTurn({ ...identity, queueEntryId: "group-review", input: [{ type: "text", text: "Explicit review" }], holdReason: "Independent review" });
    const queued = await registry.submitTurn({ ...identity, ...(grouped ? {} : { delivery: "new_turn" as const }),
      input: [{ type: "text", text: "Original Alice input" }], messageOrigin });
    if (grouped) await registry.submitTurn({ ...identity, input: [{ type: "text", text: "Unchanged Bob input" }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } });
    await registry.submitTurn({ ...identity, queueEntryId: "replacement-neighbor", delivery: "new_turn", input: [{ type: "text", text: "Neighbor input" }] });
    if (!grouped) await registry.setQueuedTurnPaused({ queueEntryId: queued.entry.id, paused: true });
    const original = await registry.readQueuedTurn({ ...identity, queueEntryId: queued.entry.id });
    const originalInput = JSON.stringify(original.input);
    if (grouped && !originalInput.includes("Unchanged Bob input")) throw new Error("Expected one grouped batch before replacement");
    const offset = events.length;
    const replacement = await registry.replaceQueuedAgentMessage({ ...identity, queueEntryId: queued.entry.id,
      input: [{ type: "text", text: "Fresh Alice input" }], messageOrigin });
    const current = await registry.readQueuedTurn({ ...identity, queueEntryId: replacement.queueEntryId! });
    let retired = false;
    try { await registry.readQueuedTurn({ ...identity, queueEntryId: queued.entry.id }); } catch { retired = true; }
    const waiting = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue.getQueuedEntries(identity);
    const statuses = events.slice(offset).flatMap(event => event.notification.method === "thread/turnQueue/updated"
      ? [[event.notification.params.queueEntryId, event.notification.params.status]] : []);
    const row = waiting.find(entry => entry.id === replacement.queueEntryId)!;
    const result = { originalId: queued.entry.id, replacementId: replacement.queueEntryId!, retired, statuses,
      waiting: waiting.map(entry => entry.id), text: current.input.flatMap(item => item.type === "text" ? [item.text] : []).join("\n"),
      paused: row.paused, pauseRevision: row.pauseRevision, held: row.manualReleaseRequired,
      nativeStarts: OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start").length,
      untouchedSenderText: "", cancelledReceipt: "" };
    if (JSON.stringify(original.input) !== originalInput) throw new Error("Original accepted input changed");
    if (grouped) {
      const bob = await registry.replaceQueuedAgentMessage({ ...identity, queueEntryId: queued.entry.id,
        input: [{ type: "text", text: "Fresh Bob input" }], messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } });
      const currentBob = await registry.readQueuedTurn({ ...identity, queueEntryId: bob.queueEntryId! });
      result.untouchedSenderText = currentBob.input.flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
    } else {
      const sender = await registry.startThread({ backend: "codex", cwd: root });
      const senderTurn = await registry.startTurn({ backend: "codex", threadId: sender.threadId, input: [{ type: "text", text: "slow" }] });
      // The pending start has its own notification; tools belong to the native returned turn.
      const senderStarted = (event: AgentEvent) => {
        if (event.notification.method !== "turn/started") return false;
        const params = event.notification.params as { threadId: string; turnId?: string; turn?: { id: string } };
        return params.threadId === sender.threadId && (params.turnId ?? params.turn?.id) === senderTurn.turnId;
      };
      if (!events.some(senderStarted)) await new Promise<void>(resolve => {
        const stop = registry.onEvent(event => { if (senderStarted(event)) { stop(); resolve(); } });
      });
      const send = async (prompt: string, replaceQueueEntryId?: string) => {
        const response = await registry["sendMessageToThread"]({ operation: "send_message_to_thread",
          context: { backend: "codex", threadId: sender.threadId, turnId: senderTurn.turnId },
          args: { ...identity, prompt, ...(replaceQueueEntryId ? { replaceQueueEntryId } : {}) } });
        if (!response.ok) throw new Error(`Actual sender admission refused: ${JSON.stringify(response)}`);
        return response.data as { queueEntryId: string };
      };
      const receipt = await send("Original receipt input");
      const stopCancellation = registry.onEvent(event => {
        if (event.notification.method === "thread/turnQueue/updated" && event.notification.params.status === "queued"
          && typeof event.notification.params.queueEntryId === "string" && event.notification.params.queueEntryId !== receipt.queueEntryId) registry.cancelQueuedTurn(event.notification.params.queueEntryId);
      });
      try { await send("Fresh receipt input", receipt.queueEntryId); } finally { stopCancellation(); }
      const replay = new ThreadCorrespondenceStore(correspondenceDirectory).appendToReplay({ backend: "codex", threadId: sender.threadId }, {
        entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
      });
      result.cancelledReceipt = replay.messages.at(-1)!.text;
    }
    await registry.interruptTurn(active);
    return result;
  } finally {
    stopEvents();
    await registry.close();
    await client.close();
    configStore.dispose();
    resetDesktopOverlayStoreForTests();
    db.close();
  }
}
