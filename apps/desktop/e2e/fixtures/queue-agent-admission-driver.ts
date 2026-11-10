import { installTestOwnerHost } from "../../src/main/shell/testing/owner-host-fixture";
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

// This separate owner uses actual desktop construction, native protocol fixture
// responses and real SQLite in Electron. It cannot reach an installed agent.
export async function exerciseDesktopAgentAdmission(root: string, grouped: boolean) {
  await installTestOwnerHost();
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
    const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
    // Legacy grouped entries still support the completed replacement contract.
    // Additional production messages below use the actual registry callers.
    const queued = grouped
      ? await queue.submitGroupedSteer({ ...identity, origin: "manual", input: [{ type: "text", text: "Original Alice input" }], messageOrigin })
      : await registry.submitTurn({ ...identity, delivery: "new_turn", input: [{ type: "text", text: "Original Alice input" }], messageOrigin });
    if (grouped) await queue.submitGroupedSteer({ ...identity, origin: "manual", input: [{ type: "text", text: "Unchanged Bob input" }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } });
    const additional: Array<{ id: string; snapshot: Awaited<ReturnType<typeof registry.readQueuedTurn>> }> = [];
    if (grouped) {
      for (const sender of ["alice", "bob", "alice"]) {
        const input = [{ type: "text" as const, text: `Additional ${sender} input ${additional.length}` }];
        const origin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: sender } };
        const result = additional.length % 2
          ? await registry.controlActiveTurn({ ...identity, operation: "steer", expectedTurnId: active.turnId,
              requestId: `admission-${additional.length}`, input, messageOrigin: origin })
          : await registry.submitTurn({ ...identity, input, messageOrigin: origin });
        const id = "entry" in result ? result.entry.id : result.ok ? result.turnId! : "";
        const snapshot = await registry.readQueuedTurn({ ...identity, queueEntryId: id });
        if (JSON.stringify(snapshot.input) !== JSON.stringify(input)) throw new Error("Additional acceptance changed input");
        additional.push({ id, snapshot });
        for (const entry of additional) {
          if (JSON.stringify(await registry.readQueuedTurn({ ...identity, queueEntryId: entry.id })) !== JSON.stringify(entry.snapshot)) {
            throw new Error("A later message changed an earlier acceptance");
          }
        }
        if (new Set(additional.map(entry => entry.id)).size !== additional.length) throw new Error("Additional messages reused an identity");
      }
    }
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
      additionalIds: additional.map(entry => entry.id), waiting: waiting.map(entry => entry.id), text: current.input.flatMap(item => item.type === "text" ? [item.text] : []).join("\n"),
      paused: row.paused, pauseRevision: row.pauseRevision, held: row.manualReleaseRequired,
      nativeStarts: OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start").length,
      untouchedSenderText: "", cancelledReceipt: "" };
    if (JSON.stringify(original.input) !== originalInput) throw new Error("Original accepted input changed");
    if (grouped) {
      const bob = await registry.replaceQueuedAgentMessage({ ...identity, queueEntryId: queued.entry.id,
        input: [{ type: "text", text: "Fresh Bob input" }], messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } });
      const currentBob = await registry.readQueuedTurn({ ...identity, queueEntryId: bob.queueEntryId! });
      result.untouchedSenderText = currentBob.input.flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
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
