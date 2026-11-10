import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { publishSelfStartedWakes } from "./self-started-wake-publication";
import type { AgentEvent } from "@pwragent/shared";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { DesktopBackendRegistry } from "../../src/main/app-server/backend-registry";
import { CodexAppServerClient } from "../../src/main/codex-app-server/desktop-client";
import { DesktopConfigStore } from "../../src/main/settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../../src/main/storage/overlay-store-sqlite";
import { StateDb } from "../../src/main/storage/state-db";
import { ClaudeSessionStore } from "../../src/main/claude/claude-session-store";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../../src/main/storage/desktop-overlay-store";

/** Real Electron registry, SQLite and installed SDK; only the CLI is a wire fixture. */
export async function exerciseDesktopSelfStartedAdmission(root: string, cliFixture: string) {
  await mkdir(root, { recursive: true });
  const configPath = path.join(root, "config.toml");
  await writeFile(configPath, "");
  await writeFile(path.join(root, "claude.js"), cliFixture);
  const db = StateDb.open(path.join(root, "state.db"));
  const overlayStore = new SqliteOverlayStore(db);
  setDesktopOverlayStoreForTests(overlayStore);
  const configStore = new DesktopConfigStore({ configPath });
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const registry = new DesktopBackendRegistry({ codexClient: client, configStore, overlayStore, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "invented-self-started-owner",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [],
    claudeBackendOptions: { store: new ClaudeSessionStore(path.join(root, "sessions")),
      inspectInstallation: async () => ({ executable: path.join(root, "claude.js"), authStatus: "signed-in" }),
      discoverModels: async () => [], readCommands: async () => [], readMcpServers: async () => [], getSessionInfo: async () => undefined } });
  const events: AgentEvent[] = [];
  const initialCompleted = Promise.withResolvers<void>();
  const stopEvents = registry.onEvent(event => {
    events.push(event);
    if (event.backend === "claude" && event.notification.method === "turn/completed") initialCompleted.resolve();
  });
  const readLines = (name: string): string[] => existsSync(path.join(root, name))
    ? readFileSync(path.join(root, name), "utf8").trim().split("\n").filter(Boolean) : [];
  const waitForLines = (name: string, count: number) => new Promise<void>(resolve => {
    const watcher = watch(root, () => check());
    const check = () => { if (readLines(name).length >= count) { watcher.close(); resolve(); } };
    check();
  });
  try {
    const created = await registry.startThread({ backend: "claude", cwd: root });
    const ref = { backend: "claude" as const, threadId: created.threadId };
    await registry.startTurn({ ...ref, input: [{ type: "text", text: "Invented background launch" }] });
    await initialCompleted.promise;
    await registry.setThreadLock({ ...ref, locked: true }, { source: "operator" });
    await registry.submitHeldTurn({ ...ref, queueEntryId: "independent-review", input: [{ type: "text", text: "Review" }], holdReason: "Independent review" });
    const wakes = [
      { source: "system", prompt: "Invented task completion" },
      { source: "loop_wakeup", prompt: "Invented loop wake" },
      { source: "schedule_wakeup", prompt: "Invented cron wake" },
      { source: "schedule_wakeup", prompt: "Invented cron wake" },
    ];
    const snapshots = new Map<string, Awaited<ReturnType<typeof registry.readQueuedTurn>>>();
    const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
    for (const [index, wake] of wakes.entries()) {
      const observed = waitForLines("hook-results.jsonl", index + 1);
      await publishSelfStartedWakes(root, wakes.slice(0, index + 1));
      await observed;
      const waiting = queue.getQueuedEntries(ref);
      assert.equal(waiting.length, 1 + Math.min(index + 1, 3));
      if (index < 3) {
        const id = waiting.at(-1)!.id;
        assert.equal(snapshots.has(id), false);
        const snapshot = await registry.readQueuedTurn({ ...ref, queueEntryId: id });
        assert.deepEqual(snapshot.input, [{ type: "text", text: wake.prompt }]);
        snapshots.set(id, snapshot);
      }
      for (const [queueEntryId, snapshot] of snapshots) assert.deepEqual(await registry.readQueuedTurn({ ...ref, queueEntryId }), snapshot);
    }
    assert.ok(readLines("hook-results.jsonl").every(line => JSON.parse(line).outputs.some((output: { decision?: string }) => output.decision === "block")));
    await registry.setThreadLock({ ...ref, locked: false }, { source: "operator" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(readLines("native-inputs.jsonl").length, 1);
    assert.ok(queue.getQueuedEntries(ref).every(entry => entry.manualReleaseRequired));
    for (const [queueEntryId, snapshot] of snapshots) {
      assert.equal((await registry.setQueuedTurnPaused({ queueEntryId, paused: true })).disposition, "held");
      assert.deepEqual(await registry.readQueuedTurn({ ...ref, queueEntryId }), snapshot);
    }
    const ids = [...snapshots.keys()];
    const first = snapshots.get(ids[0]!)!;
    assert.equal(registry.cancelQueuedTurnWithDisposition(ids[0]!).disposition, "cancelled");
    await registry.setThreadLock({ ...ref, locked: true }, { source: "operator" });
    await registry.holdBackendSelfStartedTurn({ ...ref, prompt: wakes[0]!.prompt, source: "task_notification" });
    const fresh = queue.getQueuedEntries(ref).at(-1)!;
    assert.notEqual(fresh.id, ids[0]);
    assert.deepEqual((await registry.readQueuedTurn({ ...ref, queueEntryId: fresh.id })).input, first.input);
    assert.equal(readLines("native-inputs.jsonl").length, 1);
    return { ids, freshId: fresh.id, held: queue.getQueuedEntries(ref).map(entry => entry.id),
      hookResults: readLines("hook-results.jsonl").length, nativeInputs: readLines("native-inputs.jsonl").length,
      cancelled: events.some(event => event.notification.method === "thread/turnQueue/updated"
        && event.notification.params.queueEntryId === ids[0] && event.notification.params.status === "cancelled") };
  } finally {
    stopEvents();
    await registry.close();
    await client.close();
    configStore.dispose();
    resetDesktopOverlayStoreForTests();
    db.close();
  }
}
