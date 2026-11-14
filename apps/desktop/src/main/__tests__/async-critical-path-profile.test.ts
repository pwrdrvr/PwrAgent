import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { NavigationDetailService, type NavigationDetailRegistry } from "../app-server/navigation-detail-service";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Opt-in, real-clock dependency experiment, not a production latency claim.
// Keep the same service delays before/after a scheduling change. Cold means
// the first request on a fresh registry; warm reuses it, its DB and caches.
// Without PWRAGENT_PROFILE_CRITICAL_PATHS=1 the same paths run with zero
// delays and print nothing, so CI fails when a stand-in falls behind the code
// it stands in for instead of the profile rotting unseen.
const PROFILING = process.env.PWRAGENT_PROFILE_CRITICAL_PATHS === "1";
const delay = (ms: number) => sleep(PROFILING ? ms : 0);

describe("async critical path profile", () => {
  it.each(["send", "first-send"])("reports %s acceptance, first token, transcript and detail independently", async (operation) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-critical-path-"));
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    setDesktopOverlayStoreForTests(store);
    const samples: Record<string, number | string>[] = [];
    let nextThread = 0;
    let firstToken: Promise<void> = Promise.resolve();
    let firstTokenAt = 0;
    let providerAcceptedAt = 0;
    const replay = { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } };
    const registry = createDesktopBackendRegistry({
      overlayStore: store,
      threadTitleGenerationService: null,
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
        listThreads: async () => [],
        listModels: async () => { await delay(20); return [{ id: "fixture-model", label: "Fixture" }]; },
        startThread: async () => { await delay(15); return { threadId: `created-${++nextThread}` }; },
        startTurn: async ({ threadId }: { threadId: string }) => {
          await delay(10);
          providerAcceptedAt = performance.now();
          firstToken = delay(60).then(() => { firstTokenAt = performance.now(); });
          return { threadId, turnId: `turn-${threadId}` };
        },
        readThread: async () => { await delay(15); return replay; },
        readConfiguredMcpServerNames: async () => { await delay(25); return []; },
      } as never,
      mcpConnectionService: {
        registerBridge: async (id: string) => {
          await delay(30);
          return { server: { name: id, command: "fixture", args: [], env: {} }, bindThread: () => {}, revoke: () => {} };
        },
      } as never,
    });
    const internals = registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
      repairCodexThreadDirectoryRelationship(): Promise<void>;
      restoreCodexNativeSubAgentsFromReplay(): Promise<void>;
      emitThreadPricingUpdated(): Promise<void>;
    };
    vi.spyOn(internals, "repairCodexThreadDirectoryRelationship").mockImplementation(async () => { await delay(20); });
    vi.spyOn(internals, "restoreCodexNativeSubAgentsFromReplay").mockImplementation(async () => { await delay(20); });
    vi.spyOn(internals, "emitThreadPricingUpdated").mockImplementation(async () => { await delay(40); });
    const connections = Array.from({ length: 6 }, (_, index) => `fixture-${index}`);
    try {
      for (const threadId of ["background-a", "background-b"]) {
        await internals.emit({ backend: "codex", notification: { method: "turn/started", params: {
          threadId, turnId: `turn-${threadId}`, turn: { id: `turn-${threadId}`, status: "in_progress" },
        } } } as AgentEvent);
      }
      for (const temperature of ["cold", "warm", "warm", "warm"]) {
        let threadId = `selected-${samples.length}`;
        await store.setThreadMcpConnectionIds({ backend: "codex", threadId, connectionIds: connections });
        const submittedAt = performance.now();
        if (operation === "first-send") {
          const response = await registry.materializeDirectoryLaunchpad({
            directoryKey: "fixture-directory",
            launchpad: {
              backend: "codex", directoryKey: "fixture-directory", directoryKind: "directory",
              directoryLabel: "Fixture", directoryPath: directory, executionMode: "default", workMode: "local",
              prompt: "Fixture prompt", mcpConnectionIds: connections, createdAt: 1, updatedAt: 1,
            },
          });
          expect(response.turnStartFailure).toBeUndefined();
          threadId = response.threadId;
        } else {
          await registry.startTurn({ backend: "codex", threadId, input: [{ type: "text", text: "Fixture prompt" }] });
        }
        const acceptanceMs = performance.now() - submittedAt;
        await firstToken;
        samples.push({ operation, temperature, acceptanceMs,
          providerAcceptanceMs: providerAcceptedAt - submittedAt, firstTokenMs: firstTokenAt - submittedAt });

        // Already-arrived live events from several active threads enter the
        // same durability batch as the selected transcript's hydration.
        for (const id of ["background-a", "background-b", threadId]) {
          await internals.emit({ backend: "codex", notification: { method: "thread/tokenUsage/updated", params: {
            threadId: id, turnId: `turn-${id}`,
            tokenUsage: { last: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, total: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
          } } } as AgentEvent);
        }
        const clickedAt = performance.now();
        const transcript = await registry.readThread({ backend: "codex", threadId, includeAccounting: false, display: { resource: "transcript" } });
        samples.push({ operation: "transcript", temperature, clickToTranscriptMs: performance.now() - clickedAt });
        expect(transcript.replay.entries).toEqual([]);
      }

      const selected: NavigationThreadSummary = {
        id: "detail", source: "codex", title: "Fixture", titleSource: "derived", inbox: { inInbox: false },
        linkedDirectories: Array.from({ length: 12 }, (_, index) => ({ id: `dir-${index}`, kind: "local", label: `Directory ${index}`, path: directory + index })),
      };
      vi.spyOn(store, "projectNavigationThreadDetail").mockResolvedValue(selected);
      const gitCache = new Map<string, { currentBranch: string }>();
      // Typed without a cast, so a member the service starts calling fails
      // typecheck here as well as the smoke run. Only the summary and the
      // timed Git probes are fixture-controlled; the rest is the real
      // registry's own state.
      const detailRegistry: NavigationDetailRegistry = {
        getCachedThreadSummary: () => selected,
        resolveThread: (params) => registry.resolveThread(params),
        getQueuedExecutionModeForThread: (ref) => registry.getQueuedExecutionModeForThread(ref),
        iterateQueuedTurnSummaries: (ref) => registry.iterateQueuedTurnSummaries(ref),
        readCheckoutHibernation: (identity) => registry.readCheckoutHibernation(identity),
        canonicalizeNavigationThreadPullRequests: async (threads) => threads,
        hydrateThreadGitWorkingStates: async (threads) => threads,
        listLiveTokenMiserSubAgents: (id) => registry.listLiveTokenMiserSubAgents(id),
        readLiveSubAgentRevisionSource: (id) => registry.readLiveSubAgentRevisionSource(id),
        mergeLiveTokenMiserSubAgents: (id, cards) => registry.mergeLiveTokenMiserSubAgents(id, cards),
        readSelectedWorkspaceGitStatus: async (cwd) => {
          if (!gitCache.has(cwd)) { await delay(20); gitCache.set(cwd, { currentBranch: "fixture" }); }
          return gitCache.get(cwd);
        },
      };
      const detail = new NavigationDetailService(detailRegistry);
      for (const temperature of ["cold", "warm", "warm", "warm"]) {
        const clickedAt = performance.now();
        const result = await detail.readSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "detail" }, includeWorkspaceConfiguration: true });
        samples.push({ operation: "detail", temperature, clickToDetailMs: performance.now() - clickedAt });
        expect(result.workspaceDirectories).toHaveLength(12);
      }
      if (PROFILING) console.info("CRITICAL_PATH_PROFILE", JSON.stringify(samples));
    } finally {
      await registry.close();
      resetDesktopOverlayStoreForTests();
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
