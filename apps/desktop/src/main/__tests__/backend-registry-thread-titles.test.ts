import {
  mainLoggerMock,
  createPdfMcpServerMock,
  flushAsync,
  createDeferred,
  waitForCondition,
  createOverlayStoreMock,
  MockBackendClient,
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createKimiAcpRegistry,
  answerAcpSessionCancel,
  emitCompletedTurn,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION } from "@pwragent/shared/contracts/messaging-tools";
import type {
  AcpBackendId,
  AppServerBackendKind,
  AppServerThreadReplay,
  AppServerThreadSummary,
  AppServerTurnInputItem,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";

describe("DesktopBackendRegistry", () => {
  it("leaves ACP Claude naming to the provider without launching a redundant title helper", async () => {
    const backend = "acp:claude" as const;
    const titleService = { generateTitle: vi.fn(async () => ({ status: "generated" as const, title: "Redundant helper title" })) };
    const sessions: AcpSessionMetadata[] = [{ backendId: backend, sessionId: "claude-title-session", title: "Untitled thread", titleSource: "fallback",
      cwd: "/tmp/claude-title-workspace", createdAt: 1000, updatedAt: 1000, executionMode: "default", status: "idle" }];
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: backend,
      sessionId: "claude-title-session",
      sessions,
      threadTitleGenerationService: titleService,
    });
    try {
      await registry.startTurn({ backend, threadId: "claude-title-session", input: [{ type: "text", text: "Investigate Claude titles" }] });
      await registry.whenThreadTitleGenerationSettledForTests();
      expect(titleService.generateTitle).not.toHaveBeenCalled();
      expect(sessions[0]).toMatchObject({ title: "Investigate Claude titles", titleSource: "derived", promptPlaceholderTitle: true });
      // The real ACP client stores accepted session_info_update titles before
      // publishing the corresponding notification.
      Object.assign(sessions[0], { title: "Provider generated Claude title", titleSource: "derived" });
      await registry.publishLocalEvent({ backend, notification: { method: "thread/name/updated", params: {
        threadId: "claude-title-session", threadName: "Provider generated Claude title", titleSource: "derived",
      } } });
      expect(await registry.listThreads({ backend, forceRefresh: true })).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "claude-title-session", title: "Provider generated Claude title", titleSource: "derived" }),
      ]));
      // This fixture owns the prompt's terminal too. Drain its normal
      // lifecycle (including branch adoption) before close starts a deadline.
      await emitCompletedTurn(registry, backend, "claude-title-session");
      expect(titleService.generateTitle).not.toHaveBeenCalled();
    } finally { await registry.close(); }
    expect(acpClient.cancelSession).not.toHaveBeenCalled();
  });

  it("records a generated ACP title as derived", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessions: [
        {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: "Untitled thread",
          titleSource: "fallback",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });
    onTestFinished(async () => {
      await registry.close();
    });

    await registry.listThreads({ backend: acpBackendId });
    await registry["threadNaming"].applyGeneratedTitle({
      title: "Investigate the flaky federation handshake test",
      prompt: "Investigate the flaky federation handshake test",
      attempt: registry["threadNaming"].beginTitleGeneration({ backend: acpBackendId, threadId: "session-1" }),
    });

    // This reads the information store, not the thread-list cache: the
    // rename's own notification empties that cache on the way out. Nothing
    // lists again afterwards on purpose — a later listing row outranks the
    // notification's own record, so the assertion would hold whatever the
    // notification carried.
    expect(
      registry.getCachedThreadSummary({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).toMatchObject({
      title: "Investigate the flaky federation handshake test",
      titleSource: "derived",
    });
  });

  it("records a generated Codex title as derived", async () => {
    // The same generated title on the other backend. Codex stores no
    // provenance of its own, so PwrAgent's generator is the only thing that
    // knows — and if it stays silent the recorders read the title as an
    // operator rename, which is the defect this provenance exists to stop.
    // Leaving that to the ACP branch alone would make the answer depend on
    // which backend a thread happens to run.
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Untitled thread",
          titleSource: "fallback",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(async () => {
      await registry.close();
    });

    await registry.listThreads({ backend: "codex" });
    await registry["threadNaming"].applyGeneratedTitle({
      title: "Ship the release runbook",
      prompt: "Ship the release runbook",
      attempt: registry["threadNaming"].beginTitleGeneration({ backend: "codex", threadId: "thread-1" }),
    });

    expect(
      registry.getCachedThreadSummary({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).toMatchObject({
      title: "Ship the release runbook",
      titleSource: "derived",
    });
    // This mock never echoes the rename, so the provider keeps serving the
    // placeholder — the unacknowledged-rename state `withObservedThreadName`
    // exists for. It must carry the rename's own provenance onto the row:
    // stamping `explicit` here would leave a listing and a store read
    // disagreeing about the same thread for the life of the process.
    await expect(
      registry.listThreads({ backend: "codex" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Ship the release runbook",
        titleSource: "derived",
      }),
    ]);
  });

  it("never announces a rename as a fallback title", async () => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const events: AgentEvent[] = [];
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessions: [
        {
          backendId: acpBackendId,
          sessionId: "session-1",
          title: "Untitled thread",
          titleSource: "fallback",
          cwd: "/repo/project",
          createdAt: 1000,
          updatedAt: 1000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });
    onTestFinished(async () => {
      await registry.close();
    });

    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    onTestFinished(() => {
      unsubscribe();
    });
    await registry.listThreads({ backend: acpBackendId });
    // The stopgap `applyPromptDerivedAcpThreadTitle` applies when no title
    // generator is available: a real prompt-derived name stored against the
    // session as "still replaceable by a better one". That marker answers a
    // question only the session store asks. On the wire the same word means
    // "this thread has no name", and every consumer — thread chips, the quit
    // dialog, the federated summary cache — would discard the name being
    // announced.
    await registry["threadNaming"].applyGeneratedTitle({
      attempt: registry["threadNaming"].beginTitleGeneration({ backend: acpBackendId, threadId: "session-1" }),
      prompt: "Investigate the flaky federation handshake test",
      title: "Investigate the flaky federation handshake test",
      titleSource: "fallback",
    });

    expect(
      events.filter(
        (event) => event.notification.method === "thread/name/updated",
      ),
    ).toEqual([
      {
        backend: acpBackendId,
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "session-1",
            threadName: "Investigate the flaky federation handshake test",
          },
        },
      },
    ]);
    // The session keeps the marker it was given; only the announcement drops
    // it.
    expect(
      registry.getCachedThreadSummary({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).toMatchObject({
      title: "Investigate the flaky federation handshake test",
      titleSource: "explicit",
    });
  });

  it("treats a rename that states no source as an operator rename", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Untitled thread",
          titleSource: "fallback",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(async () => {
      await registry.close();
    });

    await registry.listThreads({ backend: "codex" });
    // A Codex rename and a federated one both arrive with no provenance, and
    // the default has to stay what every consumer assumed before the field
    // existed.
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/name/updated",
        params: {
          threadId: "thread-1",
          threadName: "Ship the release runbook",
        },
      },
    });

    expect(
      registry.getCachedThreadSummary({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).toMatchObject({
      title: "Ship the release runbook",
      titleSource: "explicit",
    });
  });

  it("still reports an operator rename as an explicit title", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Untitled thread",
          titleSource: "fallback",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(async () => {
      await registry.close();
    });

    await registry.listThreads({ backend: "codex" });
    await registry.renameThread({
      backend: "codex",
      threadId: "thread-1",
      name: "Ship the release runbook",
    });

    await expect(
      registry.listThreads({ backend: "codex" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Ship the release runbook",
        titleSource: "explicit",
      }),
    ]);
  });

  it("exposes live Codex thread names while thread/list still returns the placeholder", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Untitled thread",
          titleSource: "fallback",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listThreads({ backend: "codex" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Untitled thread",
        titleSource: "fallback",
      }),
    ]);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/name/updated",
        params: {
          threadId: "thread-1",
          threadName: "Sync generated names over federation",
        },
      },
    });

    await expect(
      registry.listThreads({ backend: "codex" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Sync generated names over federation",
        titleSource: "explicit",
      }),
    ]);

    await registry.close();
  });

  // A to-do card names its thread right after starting it, while thread/list
  // still omits the thread and the owner serves its pending-start placeholder.
  // A single-thread read that already carries the name acknowledges the
  // rename, so the next listing must not fall back to "Untitled thread".
  it("keeps a rename on a pending start through every later read", async () => {
    const name = "Layout property harness in CI";
    const read = fc.constantFrom("list", "native", "cached");
    await fc.assert(fc.asyncProperty(fc.array(read, { minLength: 1, maxLength: 6 }), async (reads) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/start", "thread/name/set"] },
        threads: [],
      });
      // Codex already reports the name on a point read of the loaded thread.
      Object.assign(codexClient, {
        readThreadSummary: async (threadId: string): Promise<AppServerThreadSummary> => ({
          id: threadId, source: "codex", title: name, titleSource: "explicit", linkedDirectories: [],
        }),
      });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      const ref = { backend: "codex" as const, threadId: "thread-1" };
      try {
        await registry.startThread({ backend: "codex", cwd: "/repo-a" });
        await registry.renameThread({ ...ref, name });
        for (const step of reads) {
          if (step === "native") await registry.refreshNavigationThread(ref, true, false);
          const title = step === "list"
            ? (await registry.listThreads({ backend: "codex" })).find((thread) => thread.id === ref.threadId)?.title
            : registry.getCachedNavigationThread(ref)?.title;
          expect({ step, title }).toEqual({ step, title: name });
        }
        const listed = await registry.listThreads({ backend: "codex" });
        expect(listed.find((thread) => thread.id === ref.threadId)).toMatchObject({ title: name, titleSource: "explicit" });
      } finally { await registry.close(); }
    }), { numRuns: 20, examples: [[["native", "list"]]] });
  });

  it("startup inventory publication cannot overwrite a rename acknowledged after its provider read", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z][a-z]{0,12}$/), async suffix => {
      const thread: AppServerThreadSummary = { id: "startup-title", source: "codex", title: `Before ${suffix}`,
        titleSource: "explicit", linkedDirectories: [] };
      const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [thread] }),
        overlayStore: createOverlayStoreMock(), discoverLocalAcpAgents: async () => [],
        providerThreadSnapshotStore: { list: () => [], replace: () => {} } });
      const owner = registry as unknown as {
        reserveThreadInfoObservation(): number;
        publishRefreshedProviderThreadsToCache(refreshes: Array<{ backends: AppServerBackendKind[]; threads: AppServerThreadSummary[] }>, sequence: number): Promise<void>;
      };
      try {
        await registry.listThreads({ backend: "codex" });
        const sequence = owner.reserveThreadInfoObservation();
        await registry.publishLocalEvent({ backend: "codex", notification: { method: "thread/name/updated",
          params: { threadId: thread.id, threadName: `After ${suffix}`, titleSource: "explicit" } } });
        await owner.publishRefreshedProviderThreadsToCache([{ backends: ["codex"], threads: [thread] }], sequence);
        expect(registry.getCachedThreadSummary({ backend: "codex", threadId: thread.id })?.title).toBe(`After ${suffix}`);
        expect((await registry.listThreads({ callerReason: "navigation-snapshot", enrichDirectories: false }))[0]?.title).toBe(`After ${suffix}`);
      } finally { await registry.close(); }
    }), { numRuns: 10 });
  });

  it("reconciles a Codex name update that arrives during list enrichment", async () => {
    const enrichment = createDeferred<void>();
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Untitled thread",
          titleSource: "fallback",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const overlayStore = createOverlayStoreMock();
    const getThreadOverlayStates = vi.spyOn(
      overlayStore,
      "getThreadOverlayStates",
    ).mockImplementation(async () => {
      await enrichment.promise;
      return {};
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    const pendingList = registry.listThreads({ backend: "codex" });
    await waitForCondition(() => getThreadOverlayStates.mock.calls.length === 1);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/name/updated",
        params: {
          threadId: "thread-1",
          threadName: "Sync generated names over federation",
        },
      },
    });
    enrichment.resolve();

    await expect(pendingList).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Sync generated names over federation",
        titleSource: "explicit",
      }),
    ]);
    await expect(
      registry.listThreads({ backend: "codex" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Sync generated names over federation",
      }),
    ]);
    expect(codexClient.listThreadsCallCount).toBe(2);

    await registry.close();
  });

  it("seeds an idle newly started Agent thread with the Agent name as a fallback", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/start"] },
      threads: [],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.startThread({
      agent: { name: "Summy Dummy" },
      backend: "codex",
      cwd: "/repo-a",
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Summy Dummy",
        titleSource: "fallback",
      }),
    ]);

    await registry.close();
  });

  // Completion is an owner barrier: work admitted by a title event is part of
  // the same drain, regardless of how many generations precede the last one.
  async function assertTitleWorkCascade(count: number): Promise<void> {
    const lastStarted = createDeferred<void>();
    const lastRelease = createDeferred<void>();
    const threads = Array.from({ length: count }, (_, i) => ({
      id: `cascade-${i}`, title: "Prompt", titleSource: "derived" as const,
      source: "codex" as const, linkedDirectories: [],
    }));
    const titleService = { generateTitle: vi.fn(async ({ threadId }: { threadId?: string }) => {
      if (threadId === threads.at(-1)!.id) {
        lastStarted.resolve();
        await lastRelease.promise;
      }
      return { status: "generated" as const, title: "Generated" };
    }) };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/name/set"] }, threads,
      }),
      overlayStore: createOverlayStoreMock(), threadTitleGenerationService: titleService,
    });
    const schedule = (i: number) => registry["scheduleThreadTitleGeneration"]({
      backend: "codex", threadId: threads[i].id, input: [{ type: "text", text: "Prompt" }],
    });
    const stop = registry.onEvent((event) => {
      if (event.notification.method !== "thread/name/updated") return;
      const { threadId } = event.notification.params;
      const i = threads.findIndex((thread) => thread.id === threadId);
      if (i >= 0 && i + 1 < count) schedule(i + 1);
    });
    schedule(0);
    const completion = registry.whenThreadTitleGenerationSettledForTests();
    try {
      expect(await Promise.race([
        completion.then(() => "settled"), lastStarted.promise.then(() => "last-started"),
      ])).toBe("last-started");
      lastRelease.resolve();
      await completion;
      expect(titleService.generateTitle).toHaveBeenCalledTimes(count);
    } finally {
      lastRelease.resolve();
      stop();
      await completion;
      await registry.close();
    }
  }

  it("waits for all 24 title generations in the drain counterexample", async () => {
    await assertTitleWorkCascade(24);
  });

  it("waits for the entire generated title work cascade", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 24, max: 30 }), assertTitleWorkCascade), { numRuns: 5 });
  });

  it("applies generated Codex thread titles after starting turns", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Leopard tea button",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    await expect(
      registry.startTurn({
        backend: "codex",
        threadId: "thread-title",
        input: [{ type: "text", text: "Make button" }],
      })
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-title",
      turnId: "turn-1",
    });

    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-title",
      userPrompt: "Make button",
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Leopard tea button",
    });
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.notification.method === "thread/name/updated"
          && event.notification.params.threadId === "thread-title",
      ),
    );
    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "thread/name/updated",
        params: {
          threadId: "thread-title",
          threadName: "Leopard tea button",
          // PwrAgent generated this name, and says so on the wire. Codex
          // stores no provenance of its own, so silence here would make the
          // recorders read a generated title as an operator rename.
          titleSource: "derived",
        },
      },
    });

    await registry.close();
  });

  it("generates a title for a desktop composer Agent thread", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Testing manager agent",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/start", "turn/start", "thread/name/set"],
      },
      threads: [],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });
    const prompt =
      "Testing testing is this thing on, I need to test the manager agent.";

    await registry.startThread({
      agent: {
        name: "PwrAgent Agent",
        instructions: "Manage PwrAgent threads.",
      },
      backend: "codex",
      cwd: "/repo-a",
    });
    await registry.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: prompt }],
    });
    await registry.whenThreadTitleGenerationSettledForTests();

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      userPrompt: prompt,
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-1",
      name: "Testing manager agent",
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      subAgents: [
        expect.objectContaining({
          monitorId: "system:title-helper:codex:thread-1",
          status: "success",
          task: "Name this thread",
        }),
      ],
    });

    await registry.close();
  });

  it("starts one Codex title helper for every concurrent explicit placeholder", async () => {
    const titleGenerationsStarted = createDeferred<void>();
    const titleGenerationRelease = createDeferred<void>();
    let startedTitleGenerations = 0;
    const titleService = {
      generateTitle: vi.fn(async ({ threadId }: { threadId?: string }) => {
        startedTitleGenerations += 1;
        if (startedTitleGenerations === threadIds.length) {
          titleGenerationsStarted.resolve();
        }
        await titleGenerationRelease.promise;
        return {
          status: "generated" as const,
          title: `Title for ${threadId ?? "thread"}`,
        };
      }),
    };
    const threadIds = [
      "thread-parallel-1",
      "thread-parallel-2",
      "thread-parallel-3",
    ];
    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: threadIds.map((threadId) => ({
        id: threadId,
        // Codex reports PwrAgent's initial placeholder rename as explicit. If
        // the prompt-derived rename then loses a parallel session-metadata
        // race, this is the title state the helper eligibility check sees.
        title: "Untitled thread",
        titleSource: "explicit",
        linkedDirectories: [],
        source: "codex",
      })),
    });
    const pendingThreadIds = [...threadIds];
    vi.spyOn(codexClient, "startThread").mockImplementation(async () => ({
      threadId: pendingThreadIds.shift() ?? "unexpected-thread",
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });

    await Promise.all(
      threadIds.map((threadId) =>
        registry.startThread({
          backend: "codex",
          cwd: `/repo/${threadId}`,
        }),
      ),
    );
    const starts = threadIds.map((threadId) =>
      registry.startTurn({
        backend: "codex",
        threadId,
        input: [{ type: "text", text: `Prompt for ${threadId}` }],
      }),
    );

    await titleGenerationsStarted.promise;
    for (const threadId of threadIds) {
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId,
        }),
      ).resolves.toMatchObject({
        subAgents: [
          expect.objectContaining({
            monitorId: `system:title-helper:codex:${threadId}`,
            status: "running",
          }),
        ],
      });
    }

    titleGenerationRelease.resolve();
    await Promise.all(starts);
    await registry.close();
  });

  it.each([false, true])("preserves an explicit Untitled thread rename while its title helper finishes (targeted=%s)", async (targeted) => {
    const titleGenerationStarted = createDeferred<void>();
    const titleGenerationRelease = createDeferred<void>();
    const titleService = {
      generateTitle: vi.fn(async () => {
        titleGenerationStarted.resolve();
        await titleGenerationRelease.promise;
        return {
          status: "generated" as const,
          title: "Generated replacement",
        };
      }),
    };
    const threadId = "thread-explicit-placeholder";
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgent = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      startThreadResult: { threadId },
      threads: [
        {
          id: threadId,
          title: "Untitled thread",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    if (targeted) Object.assign(codexClient, { readThreadSummary: async () => ({
      id: threadId, title: "Untitled thread", titleSource: "explicit", linkedDirectories: [], source: "codex",
    }) });
    const renameThread = vi.spyOn(codexClient, "renameThread");
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });

    await registry.startThread({
      backend: "codex",
      cwd: "/repo/explicit-placeholder",
    });
    await registry.startTurn({
      backend: "codex",
      threadId,
      input: [{ type: "text", text: "Name this work" }],
    });
    await titleGenerationStarted.promise;

    await registry.renameThread({
      backend: "codex",
      threadId,
      name: "Untitled thread",
    });
    titleGenerationRelease.resolve();
    await registry.whenThreadTitleGenerationSettledForTests();
    expect(upsertSubAgent).toHaveBeenCalledWith(expect.objectContaining({
      subAgent: expect.objectContaining({ status: "success" }),
    }));

    expect(renameThread).toHaveBeenCalledTimes(1);
    expect(renameThread).toHaveBeenCalledWith({
      threadId,
      name: "Untitled thread",
    });

    await registry.close();
  });

  it("logs Codex title generation failures to the main log", async () => {
    mainLoggerMock.warn.mockClear();
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "failed" as const,
        reason: "codex_title_helper_failed",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title-failure",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title-failure",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() =>
      mainLoggerMock.warn.mock.calls.some(
        ([message]) => message === "threadTitleGeneration",
      ),
    );

    expect(mainLoggerMock.warn).toHaveBeenCalledWith(
      "threadTitleGeneration",
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-title-failure",
        status: "failed",
        reason: "codex_title_helper_failed",
      }),
    );

    await registry.close();
  });

  it("schedules Codex title generation from lifecycle events while turn/start is still pending", async () => {
    const startTurnDelay = createDeferred<void>();
    const titleGenerationStarted = createDeferred<void>();
    const titleGenerationRelease = createDeferred<void>();
    const titleService = {
      generateTitle: vi.fn(async () => {
        titleGenerationStarted.resolve();
        await titleGenerationRelease.promise;
        return {
          status: "generated" as const,
          title: "Lifecycle title",
        };
      }),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      models: [{ id: "gpt-5.6-luna", label: "Luna", reasoningEfforts: ["low"] }],
      startTurnDelay: startTurnDelay.promise,
      threads: [
        {
          id: "thread-lifecycle-title",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));

    const startTurnPromise = registry.startTurn({
      backend: "codex",
      threadId: "thread-lifecycle-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() => codexClient.startTurnCallCount === 1);

    await (
      registry as unknown as { emit(event: AgentEvent): Promise<void> }
    ).emit({
      backend: "codex",
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "thread-lifecycle-title",
          status: { type: "active" },
        },
      },
    });
    await titleGenerationStarted.promise;

    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-lifecycle-title",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:codex:thread-lifecycle-title",
        task: "Name this thread",
        status: "running",
        backend: "codex",
        agentName: "PwrAgent",
        ownerRuntimeInstanceId: expect.any(String),
        preferredModel: "gpt-5.6-luna",
        preferredReasoningEffort: "low",
        lastMessage: "Generating a title.",
      }),
    });
    expect(codexClient.lastRenameThreadParams).toBeUndefined();
    titleGenerationRelease.resolve();
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-lifecycle-title",
      userPrompt: "Make button",
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-lifecycle-title",
      name: "Lifecycle title",
    });

    startTurnDelay.resolve();
    await expect(startTurnPromise).resolves.toEqual({
      backend: "codex",
      threadId: "thread-lifecycle-title",
      turnId: "turn-1",
    });
    expect(titleService.generateTitle).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it.each(["direct", "queue"] as const)("redacts managed local PDF paths before lifecycle title generation via %s", async (submission) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-title-pdf-"));
    const pdfPath = path.join(root, "roadster.pdf");
    await writeFile(pdfPath, "%PDF-1.7\n", "utf8");
    const startTurnDelay = createDeferred<void>();
    const startTurnEntered = createDeferred<void>();
    const titleRequested = createDeferred<void>();
    const titleService = {
      generateTitle: vi.fn(async () => {
        titleRequested.resolve();
        return {
          status: "generated" as const,
          title: "Roadster roof equipment",
        };
      }),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      startTurnDelay: startTurnDelay.promise,
      threads: [],
    });
    const originalStartTurn = codexClient.startTurn.bind(codexClient);
    const backendStart = vi.spyOn(codexClient, "startTurn").mockImplementation((params) => {
      const result = originalStartTurn(params);
      startTurnEntered.resolve();
      return result;
    });
    const pdfMcp = createPdfMcpServerMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-title-pdf": {
            backend: "codex",
            executionMode: "default",
            extraLinkedDirectories: [],
            messagingPdfToolCatalogVersion:
              PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION,
            threadId: "thread-title-pdf",
          },
        },
      }),
      pdfToolMcpServer: pdfMcp.server,
      resolvePdfAnalysisEnabled: () => true,
      threadTitleGenerationService: titleService,
    });

    let startTurnPromise: ReturnType<typeof registry.startTurn> | undefined;
    try {
      const params = {
        backend: "codex",
        threadId: "thread-title-pdf",
        input: [
          {
            type: "text",
            text: `Compare [@roadster.pdf](${pdfPath}).`,
          },
          { type: "localFile", name: "roadster.pdf", path: pdfPath },
        ] as AppServerTurnInputItem[],
      } as const;
      startTurnPromise = submission === "direct"
        ? registry.startTurn(params)
        : registry.submitTurn(params).then((result) => {
            if (result.status !== "started") throw new Error("Expected immediate PDF submission.");
            return { backend: result.entry.backend, threadId: result.entry.threadId, turnId: result.turnId };
          });
      // PDF preparation performs real I/O. Observe backend entry rather than
      // assuming it completes within a fixed number of event-loop flushes.
      await Promise.race([startTurnEntered.promise, startTurnPromise]);
      expect(codexClient.startTurnCallCount).toBe(1);
      await (
        registry as unknown as { emit(event: AgentEvent): Promise<void> }
      ).emit({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-title-pdf",
            status: { type: "active" },
          },
        },
      });
      await titleRequested.promise;

      expect(titleService.generateTitle).toHaveBeenCalledWith(expect.objectContaining({
        backend: "codex",
        threadId: "thread-title-pdf",
        userPrompt: expect.stringContaining("Compare @roadster.pdf."),
      }));
      expect(titleService.generateTitle).not.toHaveBeenCalledWith(
        expect.objectContaining({ userPrompt: expect.stringContaining(pdfPath) }),
      );
      expect(titleService.generateTitle).not.toHaveBeenCalledWith(
        expect.objectContaining({ userPrompt: expect.stringContaining("thread-assets") }),
      );
      const providerInput = backendStart.mock.calls[0]?.[0].input;
      const prompt = providerInput?.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      expect(prompt).toContain("Compare @roadster.pdf.");
      expect(JSON.stringify(providerInput)).not.toContain(pdfPath);

      startTurnDelay.resolve();
      await expect(startTurnPromise).resolves.toEqual({
        backend: "codex",
        threadId: "thread-title-pdf",
        turnId: "turn-1",
      });
    } finally {
      startTurnDelay.resolve();
      await startTurnPromise?.catch(() => undefined);
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enriches local file references with bounded metadata before backend handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-local-file-"));
    const filePath = path.join(root, "notes.txt");
    const text = "Inspect the disk image only if needed.\n";
    await writeFile(filePath, text, "utf8");
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolvePdfAnalysisEnabled: () => false,
    });

    try {
      await registry.startTurn({
        backend: "codex",
        threadId: "thread-local-file",
        input: [
          { type: "text", text: "Use the attached notes." },
          { type: "localFile", name: "notes.txt", path: filePath },
        ],
      });

      expect(codexClient.lastStartTurnParams?.input).toEqual([
        { type: "text", text: "Use the attached notes." },
        {
          type: "localFile",
          name: "notes.txt",
          path: expect.stringContaining(path.join("thread-assets", "codex", "thread-local-file")),
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength(text),
          textPreview: text,
        },
      ]);
      const retainedFile = codexClient.lastStartTurnParams?.input[1];
      if (retainedFile?.type !== "localFile") throw new Error("Expected retained notes.");
      await expect(readFile(retainedFile.path, "utf8")).resolves.toBe(text);
    } finally {
      await registry.close();
      await rm(root, { force: true, recursive: true });
    }
  });
  it("persists the Codex title helper as a system sub-agent with usage", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Readable thread title",
        helperThreadId: "title-helper-thread",
        helperTurnId: "title-helper-turn",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        tokenUsage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          totalTokens: 110,
        },
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const upsertUsageLineSpy = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      models: [{ id: "gpt-5.6-luna", label: "Luna", reasoningEfforts: ["low"] }],
      threads: [
        {
          id: "thread-title-helper-parent",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title-helper-parent",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() =>
      upsertSubAgentSpy.mock.calls.some(
        ([call]) => call.subAgent.status === "success",
      ),
    );

    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-title-helper-parent",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:codex:thread-title-helper-parent",
        task: "Name this thread",
        status: "running",
        backend: "codex",
        agentName: "PwrAgent",
        preferredModel: "gpt-5.6-luna",
        preferredReasoningEffort: "low",
        lastMessage: "Generating a title.",
      }),
    });

    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-title-helper-parent",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:codex:thread-title-helper-parent",
        task: "Name this thread",
        status: "success",
        backend: "codex",
        agentName: "PwrAgent",
        preferredModel: "gpt-5.6-luna",
        preferredReasoningEffort: "low",
        monitorThreadId: "title-helper-thread",
        monitorTurnId: "title-helper-turn",
        lastMessage: "Generated title: Readable thread title",
        outcome: "success",
        monitorUsage: expect.objectContaining({
          model: "gpt-5.6-luna",
          tokenUsage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            uncachedInputTokens: 80,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            totalTokens: 110,
          },
        }),
      }),
    });
    expect(upsertUsageLineSpy).toHaveBeenCalledWith({
      line: expect.objectContaining({
        backend: "codex",
        source: "monitor",
        sourceItemId: "system:title-helper:codex:thread-title-helper-parent",
        scope: "monitor",
        parentThreadId: "thread-title-helper-parent",
        threadId: "title-helper-thread",
        turnId: "title-helper-turn",
        model: "gpt-5.6-luna",
        pricingRateId: "openai:2026-07-30:gpt-5.6-luna:standard",
        inputTokens: 100,
        cachedInputTokens: 20,
        uncachedInputTokens: 80,
        outputTokens: 10,
        totalTokens: 110,
      }),
    });

    await registry.close();
  });

  it("starts a fresh title-helper duration after an earlier attempt is terminal", async () => {
    const monitorId = "system:title-helper:codex:thread-title-helper-parent";
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-title-helper-parent": {
          backend: "codex",
          threadId: "thread-title-helper-parent",
          executionMode: "default",
          extraLinkedDirectories: [],
          subAgents: [
            {
              monitorId,
              task: "Name this thread",
              status: "failure",
              createdAt: 1_000,
              updatedAt: 2_000,
              completedAt: 2_000,
              outcome: "failure",
              ownerRuntimeInstanceId: "runtime-old",
              completionSource: {
                type: "pwragent_fallback",
                reason: "system_title_helper",
                recoveryAttempted: false,
                terminalStatus: "failed",
              },
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      runtimeInstanceId: "runtime-current",
      resolveLiveProfileRuntimeInstanceIds: () => ["runtime-current"],
    });

    await (registry as unknown as {
      persistTitleHelperSubAgent(params: {
        backend: "codex";
        threadId: string;
        status: "running";
      }): Promise<void>;
    }).persistTitleHelperSubAgent({
      backend: "codex",
      threadId: "thread-title-helper-parent",
      status: "running",
    });

    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-title-helper-parent",
    });
    const subAgent = overlay?.subAgents?.find(
      (candidate) => candidate.monitorId === monitorId,
    );
    expect(subAgent).toMatchObject({
      status: "running",
      ownerRuntimeInstanceId: "runtime-current",
      lastMessage: "Generating a title.",
    });
    expect(subAgent?.createdAt).toBeGreaterThan(2_000);
    expect(subAgent?.updatedAt).toBe(subAgent?.createdAt);
    expect(subAgent?.completedAt).toBeUndefined();
    expect(subAgent?.outcome).toBeUndefined();
    expect(subAgent?.completionSource).toBeUndefined();
    await registry.close();
  });

  it("persists title helper usage when the generated title is invalid", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "invalid" as const,
        reason: "title_empty",
        helperThreadId: "invalid-title-helper-thread",
        helperTurnId: "invalid-title-helper-turn",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        tokenUsage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          totalTokens: 110,
        },
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const upsertUsageLineSpy = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-invalid-title-helper",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-invalid-title-helper",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() =>
      upsertSubAgentSpy.mock.calls.some(
        ([call]) => call.subAgent.status === "failed",
      ),
    );

    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-invalid-title-helper",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:codex:thread-invalid-title-helper",
        status: "failed",
        outcome: "failure",
        monitorThreadId: "invalid-title-helper-thread",
        monitorTurnId: "invalid-title-helper-turn",
        preferredModel: "gpt-5.6-luna",
        preferredReasoningEffort: "low",
        lastMessage: "Title generation failed: title_empty",
        monitorUsage: expect.objectContaining({
          model: "gpt-5.6-luna",
          tokenUsage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            uncachedInputTokens: 80,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            totalTokens: 110,
          },
        }),
      }),
    });
    expect(upsertUsageLineSpy).toHaveBeenCalledWith({
      line: expect.objectContaining({
        backend: "codex",
        parentThreadId: "thread-invalid-title-helper",
        threadId: "invalid-title-helper-thread",
        turnId: "invalid-title-helper-turn",
        scope: "monitor",
        source: "monitor",
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        totalTokens: 110,
      }),
    });
    expect(codexClient.lastRenameThreadParams).toBeUndefined();

    await registry.close();
  });

  it("logs title helper sub-agent persistence failures without retrying the same write", async () => {
    mainLoggerMock.warn.mockClear();
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Readable thread title",
        helperThreadId: "title-helper-thread",
        helperTurnId: "title-helper-turn",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        tokenUsage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          totalTokens: 110,
        },
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi
      .spyOn(overlayStore, "upsertThreadSubAgent")
      .mockImplementation(async ({ subAgent }) => {
        if (subAgent.status === "success") {
          throw new Error("overlay write failed");
        }
      });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title-helper-persist-failure",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title-helper-persist-failure",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() =>
      mainLoggerMock.warn.mock.calls.some(
        ([message]) => message === "threadTitleHelperSubAgentPersistence",
      ),
    );

    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title-helper-persist-failure",
      name: "Readable thread title",
    });
    expect(upsertSubAgentSpy).toHaveBeenCalledTimes(2);
    expect(mainLoggerMock.warn).toHaveBeenCalledWith(
      "threadTitleHelperSubAgentPersistence",
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-title-helper-persist-failure",
        status: "success",
        persistenceError: "overlay write failed",
      }),
    );

    await registry.close();
  });

  it("marks the title helper sub-agent failed when title generation throws", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => {
        throw new Error("title helper unavailable");
      }),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      models: [{ id: "gpt-5.6-luna", label: "Luna", reasoningEfforts: ["low"] }],
      threads: [
        {
          id: "thread-title-helper-throws",
          title: "Make button",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      threadTitleGenerationService: titleService,
    });
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title-helper-throws",
      input: [{ type: "text", text: "Make button" }],
    });
    await waitForCondition(() =>
      upsertSubAgentSpy.mock.calls.some(
        ([call]) => call.subAgent.status === "failed",
      ),
    );

    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-title-helper-throws",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:codex:thread-title-helper-throws",
        status: "running",
        preferredModel: "gpt-5.6-luna",
        preferredReasoningEffort: "low",
        lastMessage: "Generating a title.",
      }),
    });
    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-title-helper-throws",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:codex:thread-title-helper-throws",
        status: "failed",
        outcome: "failure",
        preferredModel: "gpt-5.6-luna",
        preferredReasoningEffort: "low",
        lastMessage: "Title generation failed: title helper unavailable",
        completionSource: expect.objectContaining({
          terminalStatus: "failed",
        }),
      }),
    });
    expect(codexClient.lastRenameThreadParams).toBeUndefined();

    await registry.close();
  });

  it("applies generated titles when Codex exposes the prompt as an explicit title", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Jaguar tea button",
      })),
    };
    const prompt =
      "Let's make a button with an animated jaguar sipping tea. Just for grins.";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: prompt,
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: prompt }],
    });
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-title",
      userPrompt: prompt,
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Jaguar tea button",
    });

    await registry.close();
  });

  it("applies generated titles when Codex derives the current title from injected AGENTS context", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Jaguar tea button",
      })),
    };
    const prompt =
      "Let's make a button with an animated jaguar sipping tea. Just for grins.";
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title:
            "# AGENTS.md instructions for /Users/fixture-user/github/PwrAgent/.worktrees/launchpad-pwragent-main-moj56ty6",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: prompt }],
    });
    await waitForCondition(() => codexClient.lastRenameThreadParams !== undefined);

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-title",
      userPrompt: prompt,
    });
    expect(codexClient.lastRenameThreadParams).toEqual({
      threadId: "thread-title",
      name: "Jaguar tea button",
    });

    await registry.close();
  });
  it("applies prompt-derived titles to ACP sessions when no title generator is available", async () => {
    const acpBackendId = "acp:qwen" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "qwen-session-1",
        title: "Untitled thread",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "acp:qwen_title_generator_unavailable",
      })),
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async () => sessions[0]!),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      startPrompt: vi.fn(() => ({
        sessionId: "qwen-session-1",
        turnId: "turn-1",
      })),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          ...createKimiAgentRecord(acpBackendId),
          registryId: "qwen",
          name: "Qwen Code",
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "qwen-session-1",
      input: [{ type: "text", text: "Does this project build?" }],
    });
    await emitCompletedTurn(registry, acpBackendId, "qwen-session-1");
    await waitForCondition(() => sessions[0]?.title === "Does this project build?");

    expect(titleService.generateTitle).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: "qwen-session-1",
      userPrompt: "Does this project build?",
    });
    expect(sessions[0]).toMatchObject({
      title: "Does this project build?",
      titleSource: "derived",
      promptPlaceholderTitle: true,
    });

    await registry.close();
  });

  it.each(["missing", "signed-out"] as const)("names ACP sessions on their own provider when Codex is %s", async (codexState) => {
    const acpBackendId = "acp:kimi" as AcpBackendId;
    const prompt =
      "We're testing something here... just tell me your favorite cereal.";
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "kimi-session-1",
        title: "We're testing something here... just tell me your favorite cereal",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        acpRuntime: {
          configValues: {
            model: "kimi-k2-0711-preview",
            approval_mode: "yolo",
          },
          currentModeId: "yolo",
          updatedAt: 1000,
        },
        status: "idle",
      },
    ];
    const sendControlPrompt = vi.fn(async () => ({
      text: '{ "title": "Favorite cereal" }',
      model: "kimi-k2-0711-preview",
      tokenUsage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        totalTokens: 110,
      },
    }));
    const helperSession: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "kimi-title-helper",
      title: "Name this thread",
      cwd: "/repo/project",
      createdAt: 1001,
      updatedAt: 1001,
      executionMode: "default",
      acpRuntime: {
        configValues: {
          model: "kimi-k2-0711-preview",
        },
        updatedAt: 1001,
      },
      hidden: true,
      status: "idle",
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async () => helperSession),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      startPrompt: vi.fn(() => ({
        sessionId: "kimi-session-1",
        turnId: "turn-1",
      })),
      sendControlPrompt,
      setRuntimeOption: vi.fn(async () => ({})),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const upsertUsageLineSpy = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    const codexClient = new MockBackendClient({
      threads: [],
      initializeError: new Error(codexState === "missing" ? "spawn codex ENOENT" : "Codex is not logged in"),
      account: { requiresOpenaiAuth: true },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([createKimiAgentRecord(acpBackendId)]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      input: [{ type: "text", text: prompt }],
    });
    await emitCompletedTurn(registry, acpBackendId, "kimi-session-1");
    await waitForCondition(() => sessions[0]?.title === "Favorite cereal");

    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/project",
        hidden: true,
        executionMode: "default",
        approvalPolicy: "deny-all",
        title: "Name this thread",
      }),
    );
    expect(acpClient.setRuntimeOption.mock.calls).toEqual([[{
      sessionId: "kimi-title-helper",
      source: "model",
      optionId: "model",
      value: "kimi-k2-0711-preview",
      reasoningEffort: undefined,
    }]]);
    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "kimi-title-helper",
      prompt: expect.stringContaining(prompt),
    });
    expect(sessions[0]).toMatchObject({
      title: "Favorite cereal",
      titleSource: "derived",
    });
    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:acp:kimi:kimi-session-1",
        task: "Name this thread",
        status: "running",
        agentName: "PwrAgent",
        backend: acpBackendId,
        preferredModel: "kimi-k2-0711-preview",
        lastMessage: "Generating a title.",
      }),
    });
    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: "kimi-session-1",
      subAgent: expect.objectContaining({
        monitorId: "system:title-helper:acp:kimi:kimi-session-1",
        task: "Name this thread",
        status: "success",
        agentName: "PwrAgent",
        backend: acpBackendId,
        preferredModel: "kimi-k2-0711-preview",
        monitorThreadId: "kimi-title-helper",
        lastMessage: "Generated title: Favorite cereal",
        outcome: "success",
        monitorUsage: expect.objectContaining({
          model: "kimi-k2-0711-preview",
          tokenUsage: expect.objectContaining({
            cachedInputTokens: 20,
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            uncachedInputTokens: 80,
          }),
        }),
      }),
    });
    expect(upsertUsageLineSpy).toHaveBeenCalledWith({
      line: expect.objectContaining({
        backend: acpBackendId,
        parentThreadId: "kimi-session-1",
        scope: "monitor",
        sourceItemId: "system:title-helper:acp:kimi:kimi-session-1",
        threadId: "kimi-title-helper",
      }),
    });
    expect(codexClient.initializeCallCount).toBe(0);
    expect(codexClient.listModelsCallCount).toBe(0);
    expect(codexClient.listThreadsCallCount).toBe(0);

    await registry.close();
  });

  it("uses a minimal low-reasoning title helper for Grok ACP sessions", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const helperSession: AcpSessionMetadata = {
      backendId: acpBackendId,
      sessionId: "grok-title-helper",
      title: "Name this thread",
      cwd: "/repo/project",
      createdAt: 1001,
      updatedAt: 1001,
      executionMode: "default",
      acpRuntime: {
        currentModelId: "grok-4.5",
        updatedAt: 1001,
      },
      hidden: true,
      status: "idle",
    };
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "grok-session-1",
        title: "What is your favorite cereal?",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        acpRuntime: {
          currentModelId: "grok-4.5",
          updatedAt: 1000,
        },
        status: "idle",
      },
    ];
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async () => helperSession),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      setRuntimeOption: vi.fn(async () => helperSession.acpRuntime),
      startPrompt: vi.fn(() => ({
        sessionId: "grok-session-1",
        turnId: "turn-1",
      })),
      sendControlPrompt: vi.fn(async () => ({
        text: '{ "title": "Favorite cereal" }',
        model: "grok-4.5-build",
        tokenUsage: {
          inputTokens: 200,
          cachedInputTokens: 40,
          outputTokens: 10,
          totalTokens: 210,
        },
      })),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          ...createKimiAgentRecord(acpBackendId),
          registryId: "grok",
          name: "Grok",
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "grok-session-1",
      input: [{ type: "text", text: "What is your favorite cereal?" }],
    });
    await emitCompletedTurn(registry, acpBackendId, "grok-session-1");
    await waitForCondition(() => sessions[0]?.title === "Favorite cereal");

    expect(acpClient.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        hidden: true,
        mcpServers: "none",
        sessionMeta: {
          agentProfile: expect.objectContaining({
            agentsMd: false,
            discoverSkills: false,
            injectDefaultTools: false,
            mcpInheritance: "none",
            tools: ["read_file"],
            disallowedTools: ["read_file", "search_tool", "use_tool"],
          }),
          systemPromptOverride: expect.stringContaining(
            "do not use tools",
          ),
        },
        title: "Name this thread",
      }),
    );
    expect(acpClient.setRuntimeOption).toHaveBeenCalledWith({
      sessionId: "grok-title-helper",
      source: "model",
      optionId: "model",
      value: "grok-4.5",
      reasoningEffort: "low",
    });
    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: "grok-session-1",
      subAgent: expect.objectContaining({
        preferredReasoningEffort: "low",
        status: "success",
      }),
    });

    await registry.close();
  });

  it("runs Usage Activity analysis on Grok on an agent process of its own, never the pooled client", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let say: (text: string) => void = () => undefined;
    const transport = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "initialize") {
          return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } };
        }
        if (method === "session/new") {
          return { sessionId: "grok-analysis", models: { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7" }] } };
        }
        if (method === "session/prompt") {
          say('{"analysis":"Two identical rg dumps."}');
          return { stopReason: "end_turn", _meta: { modelId: "grok-4.7" } };
        }
        return {};
      }),
      notify: vi.fn(async () => undefined),
      onNotification: (listener: (method: string, params: Record<string, unknown>) => void) => {
        say = (text) => listener("session/update", {
          sessionId: "grok-analysis",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
        return () => undefined;
      },
      onRequest: () => () => undefined,
      close: vi.fn(async () => undefined),
    };
    const pooledClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(),
      sendControlPrompt: vi.fn(),
    };
    const overlayStore = Object.assign(createOverlayStoreMock(), {
      readUsageActivity: vi.fn(async () => ({ rows: [], truncated: false, limitHistory: [] })),
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        { ...createKimiAgentRecord(acpBackendId), registryId: "grok", name: "Grok" },
      ]),
      acpSessionStore: createAcpSessionStoreMock([]),
      createAcpClient: () => pooledClient as never,
      createAcpTransport: () => transport,
      resolveAcpHelperWorkspace: async () => "/profile/state/acp-helper-workspace",
    });
    vi.spyOn(registry, "readThread").mockResolvedValue({
      backend: "codex", threadId: "thread", fetchedAt: 1,
      replay: {
        entries: [{ type: "message", id: "m1", role: "assistant", text: "Ran rg twice." }],
        messages: [],
        pagination: { supportsPagination: true, hasPreviousPage: false },
      },
    } as unknown as Awaited<ReturnType<typeof registry.readThread>>);

    await expect(registry.readUsageActivity({ from: 1, to: 2 }))
      .resolves.toMatchObject({ analysisModelBackends: ["codex", "acp:grok"] });
    await expect(registry.analyzeUsageActivity({
      backend: "codex", threadId: "thread", model: "grok-4.7", modelBackend: "acp:grok",
      entryLimit: 10, characterLimit: 1000,
    })).resolves.toMatchObject({ analysis: "Two identical rg dumps.", model: "grok-4.7", modelBackend: "acp:grok" });

    expect(calls.map((call) => call.method)).toEqual([
      "initialize", "session/new", "session/prompt", "session/close", "_x.ai/session/delete",
    ]);
    expect(calls[1]?.params).toMatchObject({
      cwd: "/profile/state/acp-helper-workspace",
      mcpServers: [],
      _meta: {
        agentProfile: expect.objectContaining({
          disallowedTools: ["read_file", "search_tool", "use_tool"],
        }),
      },
    });
    expect(transport.close).toHaveBeenCalledOnce();
    expect(pooledClient.startSession).not.toHaveBeenCalled();
    expect(pooledClient.sendControlPrompt).not.toHaveBeenCalled();

    await registry.close();
  });

  it("reports the generated candidate when an ACP durable title arrives first", async () => {
    const acpBackendId = "acp:grok" as AcpBackendId;
    const prompt = "What is your favorite cereal?";
    const titleGeneration = createDeferred<{
      status: "generated";
      title: string;
      helperThreadId: string;
      model: string;
      tokenUsage: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }>();
    const titleGenerationStarted = createDeferred<void>();
    const titleService = {
      generateTitle: vi.fn(async () => {
        titleGenerationStarted.resolve();
        return await titleGeneration.promise;
      }),
    };
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "grok-session-1",
        title: prompt,
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        acpRuntime: {
          currentModelId: "grok-4.5",
          updatedAt: 1000,
        },
        status: "idle",
      },
    ];
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async () => sessions[0]!),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(async (sessionId: string) => {
        answerAcpSessionCancel(registry, acpBackendId, sessionId);
      }),
      startPrompt: vi.fn(() => ({
        sessionId: "grok-session-1",
        turnId: "turn-1",
      })),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const upsertUsageLineSpy = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    const events: AgentEvent[] = [];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      acpAgentStore: createAcpAgentStoreMock([
        {
          ...createKimiAgentRecord(acpBackendId),
          registryId: "grok",
          name: "Grok",
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
      threadTitleGenerationService: titleService,
    });
    registry.onEvent((event) => {
      events.push(event);
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "grok-session-1",
      input: [{ type: "text", text: prompt }],
    });
    await titleGenerationStarted.promise;

    sessions[0] = {
      ...sessions[0]!,
      title: "Favorite Cereal Preference Personal Question",
      titleSource: "derived",
      updatedAt: 2000,
    };
    await (
      registry as unknown as { emit(event: AgentEvent): Promise<void> }
    ).emit({
      backend: acpBackendId,
      notification: {
        method: "thread/name/updated",
        params: {
          threadId: "grok-session-1",
          threadName: "Favorite Cereal Preference Personal Question",
        },
      },
    });
    titleGeneration.resolve({
      status: "generated",
      title: "Favorite Breakfast Cereal",
      helperThreadId: "grok-title-helper",
      model: "grok-4.5",
      tokenUsage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        totalTokens: 110,
      },
    });
    await registry.whenThreadTitleGenerationSettledForTests();

    expect(sessions[0]).toMatchObject({
      title: "Favorite Cereal Preference Personal Question",
      titleSource: "derived",
    });
    expect(upsertSubAgentSpy).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: "grok-session-1",
      subAgent: expect.objectContaining({
        status: "success",
        monitorThreadId: "grok-title-helper",
        preferredModel: "grok-4.5",
        lastMessage:
          "Generated title: Favorite Breakfast Cereal. Not applied: ACP provided a durable title first: Favorite Cereal Preference Personal Question.",
        outcome: "success",
        completionSource: expect.objectContaining({
          terminalStatus: "completed",
        }),
        monitorUsage: expect.objectContaining({
          model: "grok-4.5",
        }),
      }),
    });
    expect(upsertUsageLineSpy).toHaveBeenCalledWith({
      line: expect.objectContaining({
        backend: acpBackendId,
        source: "monitor",
        sourceItemId: "system:title-helper:acp:grok:grok-session-1",
        parentThreadId: "grok-session-1",
        threadId: "grok-title-helper",
      }),
    });
    expect(events).toContainEqual({
      backend: acpBackendId,
      notification: {
        method: "thread/pricing/updated",
        params: {
          threadId: "grok-session-1",
          displayInvalidated: true,
          pricing: { lines: [], summaries: [] },
        },
      },
    });
    const refreshed = await registry.readThread({
      backend: acpBackendId,
      threadId: "grok-session-1",
      display: { resource: "pricing" },
      includeTurns: false,
      viewOnly: true,
    });
    expect(refreshed.display?.pricingPage?.rows.map((row) => row.line)).toContainEqual(expect.objectContaining({
      parentThreadId: "grok-session-1",
      scope: "monitor",
      sourceItemId: "system:title-helper:acp:grok:grok-session-1",
      threadId: "grok-title-helper",
      totalTokens: 110,
    }));

    await registry.close();
  });

  it("does not replace an existing ACP prompt-derived fallback title with a later prompt", async () => {
    const acpBackendId = "acp:qwen" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "qwen-session-1",
        title: "Run npm view openclaw",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "acp:qwen_title_generator_unavailable",
      })),
    };
    const acpClient = {
      initialize: vi.fn(async () => undefined),
      dispose: vi.fn(),
      startSession: vi.fn(async () => sessions[0]!),
      ensureSession: vi.fn(async () => undefined),
      loadSession: vi.fn(),
      refreshSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(),
      startPrompt: vi.fn(() => ({
        sessionId: "qwen-session-1",
        turnId: "turn-1",
      })),
      readReplay: vi.fn((): AppServerThreadReplay => ({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      })),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          ...createKimiAgentRecord(acpBackendId),
          registryId: "qwen",
          name: "Qwen Code",
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
      createAcpClient: () => acpClient,
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "qwen-session-1",
      input: [{ type: "text", text: "what time is it?" }],
    });
    await emitCompletedTurn(registry, acpBackendId, "qwen-session-1");
    await flushAsync();
    await flushAsync();

    expect(titleService.generateTitle).not.toHaveBeenCalled();
    expect(sessions[0]).toMatchObject({
      title: "Run npm view openclaw",
      titleSource: "fallback",
    });

    await registry.close();
  });

  it("skips generated titles when the thread already has an explicit name", async () => {
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Generated title",
      })),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "thread/name/set"] },
      threads: [
        {
          id: "thread-title",
          title: "User title",
          titleSource: "explicit",
          linkedDirectories: [],
          source: "codex",
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: titleService,
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-title",
      input: [{ type: "text", text: "Make button" }],
    });
    await flushAsync();
    await flushAsync();

    expect(titleService.generateTitle).not.toHaveBeenCalled();
    expect(codexClient.lastRenameThreadParams).toBeUndefined();

    await registry.close();
  });

  it("sets the prompt-derived placeholder title immediately on Antigravity turns before the naming helper finishes", async () => {
    const acpBackendId = "acp:antigravity" as AcpBackendId;
    const prompt = "Please investigate why the authentication retry queue stalls after token expiry in production";
    const expectedPlaceholder = "Investigate why the authentication retry queue stalls after token expiry...";
    const helperStarted = createDeferred<void>();
    const helperResult = createDeferred<{ status: "generated"; title: string }>();
    const titleService = {
      generateTitle: vi.fn(async () => {
        helperStarted.resolve();
        return await helperResult.promise;
      }),
    };
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "ag-session-1",
        title: "Untitled thread",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const events: AgentEvent[] = [];
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "ag-session-1",
      sessions,
      threadTitleGenerationService: titleService,
    });
    registry.onEvent((event) => {
      events.push(event);
    });
    onTestFinished(async () => {
      helperResult.resolve({ status: "generated", title: "Fix Auth Retry Queue" });
      await registry.close();
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "ag-session-1",
      input: [{ type: "text", text: prompt }],
    });
    await helperStarted.promise;

    // Before the naming helper resolves, the session and thread listing
    // already display the shortened prompt placeholder as a derived title.
    expect(sessions[0]).toMatchObject({
      title: expectedPlaceholder,
      titleSource: "derived",
      promptPlaceholderTitle: true,
    });
    await expect(registry.listThreads({ backend: acpBackendId, forceRefresh: true })).resolves.toEqual([
      expect.objectContaining({
        id: "ag-session-1",
        title: expectedPlaceholder,
        titleSource: "derived",
      }),
    ]);

    helperResult.resolve({ status: "generated", title: "Fix Auth Retry Queue" });
    await registry.whenThreadTitleGenerationSettledForTests();
    await emitCompletedTurn(registry, acpBackendId, "ag-session-1");

    expect(sessions[0]).toMatchObject({
      title: "Fix Auth Retry Queue",
      titleSource: "derived",
    });
    expect(sessions[0]?.promptPlaceholderTitle).toBeUndefined();
    const nameEvents = events
      .filter((event) => event.notification.method === "thread/name/updated")
      .map((event) => event.notification.params);
    expect(nameEvents).toEqual([
      { threadId: "ag-session-1", threadName: expectedPlaceholder, titleSource: "derived" },
      { threadId: "ag-session-1", threadName: "Fix Auth Retry Queue", titleSource: "derived" },
    ]);
  });

  it("keeps the prompt-derived placeholder when the Antigravity naming helper throws", async () => {
    const acpBackendId = "acp:antigravity" as AcpBackendId;
    const prompt = "Refactor the ACP startup sequence";
    const titleService = {
      generateTitle: vi.fn(async () => {
        throw new Error("helper crashed");
      }),
    };
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "ag-session-throw",
        title: "Untitled thread",
        titleSource: "fallback",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "ag-session-throw",
      sessions,
      threadTitleGenerationService: titleService,
    });
    onTestFinished(async () => {
      await registry.close();
    });

    await registry.startTurn({
      backend: acpBackendId,
      threadId: "ag-session-throw",
      input: [{ type: "text", text: prompt }],
    });
    await registry.whenThreadTitleGenerationSettledForTests();
    await emitCompletedTurn(registry, acpBackendId, "ag-session-throw");

    expect(sessions[0]).toMatchObject({
      title: "Refactor the ACP startup sequence",
      titleSource: "derived",
      promptPlaceholderTitle: true,
    });
  });

  it("seeds the prompt-derived placeholder on Antigravity launchpad creation before the first turn settles", async () => {
    const acpBackendId = "acp:antigravity" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [];
    const promptDeferred = createDeferred<{ sessionId: string; turnId: string }>();
    const titleService = {
      generateTitle: vi.fn(async () => ({
        status: "generated" as const,
        title: "Short Launchpad Title",
      })),
    };
    const overlayStore = createOverlayStoreMock();
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "ag-launchpad-1",
      sessions,
      overlayStore,
      startPrompt: vi.fn(() => promptDeferred.promise),
      threadTitleGenerationService: titleService,
    });
    onTestFinished(async () => {
      promptDeferred.resolve({ sessionId: "ag-launchpad-1", turnId: "turn-1" });
      await registry.close();
    });

    await overlayStore.upsertDirectoryLaunchpad({
      directoryKey: "directory:/repo/project",
      directoryKind: "directory",
      directoryPath: "/repo/project",
      directoryLabel: "project",
      backend: acpBackendId,
      executionMode: "default",
      workMode: "local",
      prompt: "Explain how the scheduler orders queued turns",
      createdAt: 1000,
      updatedAt: 1000,
    });

    const materializePromise = registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/project",
    });

    await waitForCondition(() => sessions.length === 1);
    // Even while startPrompt is still in flight, the session already has the
    // shortened prompt placeholder instead of "ACP session" or "Untitled thread".
    expect(sessions[0]).toMatchObject({
      title: "Explain how the scheduler orders queued turns",
      titleSource: "derived",
      promptPlaceholderTitle: true,
    });

    promptDeferred.resolve({ sessionId: "ag-launchpad-1", turnId: "turn-1" });
    await materializePromise;
    await registry.whenThreadTitleGenerationSettledForTests();
    await emitCompletedTurn(registry, acpBackendId, "ag-launchpad-1");

    expect(sessions[0]).toMatchObject({
      title: "Short Launchpad Title",
      titleSource: "derived",
    });
    expect(sessions[0]?.promptPlaceholderTitle).toBeUndefined();
  });
});
