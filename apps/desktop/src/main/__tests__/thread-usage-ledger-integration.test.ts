import {
  usageActivity,
  createOverlayStoreMock,
  MockBackendClient,
  createKimiAcpRegistry,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type {
  AcpBackendId,
  AgentEvent,
  AppServerBackendKind,
  AppServerNotification,
  AppServerThreadEntry,
  ThreadOverlayState,
  ThreadToolAccounting,
  ThreadToolInvocationAlert,
  ThreadToolInvocationRecord,
  ThreadSpendAlert,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";

describe("DesktopBackendRegistry", () => {
  it("projects declared local costs and catalog labels without rewriting history or pricing unknown remote models", async () => {
    const id = "/models/bonsai.gguf";
    const local: ThreadUsageLineRecord = {
      backend: "codex", threadId: "thread-1", usageLineId: "local-turn", model: id,
      provider: "openai", currency: "USD", createdAt: 1000,
      scope: "turn", source: "live", status: "finalized",
      priceStatus: "unpriced", priceUnavailableReason: "missing-rate",
      inputTokens: 100, uncachedInputTokens: 80, cachedInputTokens: 20,
      outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110,
      uncachedInputCostMicros: 0, cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
    };
    const original = [local, { ...local, usageLineId: "remote-turn", model: "unknown-remote" },
      { ...local, usageLineId: "helper", scope: "monitor" as const, source: "monitor" as const,
        sourceItemId: "system:title-helper:test", parentThreadId: "thread-1", threadId: "helper-thread" },
      { ...local, usageLineId: "other-provider", scope: "monitor" as const, provider: "qwen" }];
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadPricing: vi.fn(async () => ({ lines: original, summaries: [] })),
    };
    const writes = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    let localIds = [id];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ models: [{ id, label: "PrismML Bonsai 2 27B" }] }),
      overlayStore, resolveCodexLocalModelIds: () => localIds,
    });
    onTestFinished(() => registry.close());
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const result = await registry.readThread({ backend: "codex", threadId: "thread-1", display: { resource: "pricing" } });
    const rows = result.display?.pricingPage?.rows ?? [];
    const byId = (id: string) => rows.find((row) => row.line.usageLineId === id)?.line;
    expect(byId("local-turn")).toMatchObject({ model: id, modelLabel: "PrismML Bonsai 2 27B", priceStatus: "priced", provider: "local", totalCostMicros: 0, totalTokens: 110 });
    expect(byId("helper")).toMatchObject({ priceStatus: "priced", provider: "local", totalCostMicros: 0 });
    expect(byId("remote-turn")).toMatchObject({ priceStatus: "unpriced", priceUnavailableReason: "missing-rate" });
    expect(byId("other-provider")).toMatchObject({ priceStatus: "unpriced", provider: "qwen" });
    expect(result.display?.pricing?.summary).toMatchObject({ pricedUsageLineCount: 2, unpricedUsageLineCount: 2 });
    expect(original[0].priceStatus).toBe("unpriced");
    expect(writes).not.toHaveBeenCalled();
    localIds = [];
    const cleared = await registry.readThread({ backend: "codex", threadId: "thread-1", display: { resource: "pricing" } });
    expect(cleared.display?.pricingPage?.rows.every((row) => row.line.priceStatus === "unpriced")).toBe(true);
  });

  it("loads an unobserved thread pricing snapshot only on pricing demand and replaces it with observed usage", async () => {
    const tokens = { inputTokens: 1_000, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1_100 };
    const codexClient = Object.assign(new MockBackendClient({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }] }), {
      readThreadPricingSnapshot: vi.fn(async () => ({ model: "gpt-6.1-sol", tokens })),
    });
    const lines: ThreadUsageLineRecord[] = [];
    const overlayStore = { ...createOverlayStoreMock(), readThreadPricing: vi.fn(async () => ({ lines, summaries: [] })) };
    const writes = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    onTestFinished(() => registry.close());
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    await registry.readThread({ backend: "codex", threadId: "thread-1", display: { resource: "tools" } });
    expect(codexClient.readThreadPricingSnapshot).not.toHaveBeenCalled();
    const response = await registry.readThread({ backend: "codex", threadId: "thread-1", display: { resource: "pricing" } });
    expect(response.display?.pricingPage?.fallbackEstimate).toMatchObject({ model: "gpt-6.1-sol", modelLabel: "GPT-6.1 Sol", tokens });
    expect(response.display?.pricingPage?.rows).toEqual([]);
    expect(response.display?.pricingPage?.summary).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    lines.push({
      backend: "codex", threadId: "thread-1", usageLineId: "observed-turn", turnId: "turn-1", model: "gpt-6.1-sol",
      provider: "openai", currency: "USD", createdAt: 1000, scope: "turn", source: "live", status: "finalized", priceStatus: "priced",
      inputTokens: 100, uncachedInputTokens: 20, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110,
      uncachedInputCostMicros: 40, cachedInputCostMicros: 8, outputCostMicros: 100, totalCostMicros: 148,
    });
    const observed = await registry.readThread({ backend: "codex", threadId: "thread-1", display: { resource: "pricing" } });
    expect(observed.display?.pricingPage?.fallbackEstimate).toBeUndefined();
    expect(observed.display?.pricingPage?.summary?.totalCostMicros).toBe(148);
    expect(codexClient.readThreadPricingSnapshot).toHaveBeenCalledOnce();
  });

  it.each(["gpt-6.1-sol", "/models/bonsai.gguf"])("projects zero-cost historical estimates for declared local model %s", async (model) => {
    const tokens = { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1_100 };
    const codexClient = Object.assign(new MockBackendClient({ models: [{ id: model, label: "Declared local model" }] }), {
      readThreadPricingSnapshot: vi.fn(async () => ({ model, tokens })),
    });
    const overlayStore = createOverlayStoreMock();
    const writes = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    let localIds = [model];
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore, resolveCodexLocalModelIds: () => localIds });
    onTestFinished(() => registry.close());
    await registry.refreshProvidersAtStartup(issueProviderDiscoveryPermit("startup"));
    const response = await registry.readThread({ backend: "codex", threadId: "thread-1", display: { resource: "pricing" } });
    expect(response.display?.pricingPage?.fallbackEstimate).toMatchObject({ model, modelLabel: "Declared local model", tokens, totalCostMicros: 0 });
    expect(response.display?.pricingPage?.summary).toBeUndefined();
    expect(response.display?.pricingPage?.rows).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    localIds = [];
    const cleared = await registry.readThread({ backend: "codex", threadId: "thread-1", display: { resource: "pricing" } });
    expect(cleared.display?.pricingPage?.fallbackEstimate?.totalCostMicros).toBe(model === "gpt-6.1-sol" ? 1_480 : undefined);
  });

  it("includes persisted tool accounting when reading ACP threads", async () => {
    // The Tool calls tab renders
    // `response.toolAccounting`. Live `thread/toolAccounting/updated` events
    // patch it into the session while a turn runs, and any readThread replaces
    // the whole response — so a read that omits the field erases the tab data.
    // On an ACP thread that is exactly what the operator sees: tool output
    // during the turn, gone the moment it ends. The Codex read path has always
    // returned this; the ACP path did not.
    const acpBackendId = "acp:grok" as AcpBackendId;
    const threadId = "grok-tool-accounting";
    const toolAccounting: ThreadToolAccounting = {
      alerts: [],
      invocations: [
        {
          backend: acpBackendId,
          threadId,
          itemId: "item-1",
          invocationId: "inv-1",
          toolName: "shell",
          category: "shell",
          status: "completed",
          observedAt: 3_000,
          updatedAt: 3_000,
          outputChars: 2_200,
          outputLines: 23,
          estimatedOutputTokens: 550,
          warningLines: 0,
          errorLines: 0,
          infoLines: 1,
          debugLines: 0,
          outputTruncated: false,
          noisy: false,
        },
      ],
      summaries: [
        {
          category: "shell",
          toolName: "shell",
          invocationCount: 11,
          outputChars: 36_000,
          outputLines: 606,
          estimatedOutputTokens: 8_974,
          warningLines: 0,
          errorLines: 0,
          infoLines: 1,
          debugLines: 0,
          noisyInvocationCount: 0,
          lastObservedAt: 3_000,
        },
      ],
    };
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      overlayStore: createOverlayStoreMock({ toolAccounting }),
      sessionId: threadId,
      sessions: [
        {
          backendId: acpBackendId,
          sessionId: threadId,
          title: "ACP session",
          createdAt: 1_000,
          updatedAt: 4_000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });

    const response = await registry.readThread({
      backend: acpBackendId,
      threadId,
    });

    expect(response.toolAccounting).toEqual(toolAccounting);

    await registry.close();
  });

  it("hydrates immutable usage activities from the thread overlay", async () => {
    const codexClient = new MockBackendClient({
      replay: {
        entries: [
          {
            type: "message",
            id: "assistant-turn-1",
            role: "assistant",
            phase: "final",
            text: "Done.",
            createdAt: 10_000,
            turn: {
              id: "turn-1",
              status: "completed",
            },
          },
          {
            type: "activity",
            id: "command-turn-1",
            summary: "Ran shell command",
            status: "completed",
            createdAt: 10_001,
            turn: {
              id: "turn-1",
              status: "completed",
            },
            details: [
              {
                id: "command-turn-1-detail",
                kind: "command",
                label: "npm test",
                status: "completed",
              },
            ],
          },
          {
            type: "activity",
            id: "live-token-usage-turn-1",
            summary:
              "Latest request usage: 1,715 uncached in · 18,285 cached · 90 out (30 reasoning)",
            status: "completed",
            createdAt: 10_002,
            turn: {
              id: "turn-1",
              status: "completed",
            },
            details: [
              {
                id: "live-token-usage-turn-1-input",
                kind: "read",
                label: "Input: 20,000 tokens (1,715 uncached, 18,285 cached)",
                status: "completed",
              },
            ],
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            immutableUsageActivities: [
              {
                type: "activity",
                id: "live-token-usage-turn-1",
                summary:
                  "Latest request usage: 1,715 uncached in · 18,285 cached · 90 out (30 reasoning)",
                status: "completed",
                createdAt: 10_002,
                turn: {
                  id: "turn-1",
                  status: "in_progress",
                },
                details: [
                  {
                    id: "live-token-usage-turn-1-input",
                    kind: "read",
                    label: "Input: 20,000 tokens (1,715 uncached, 18,285 cached)",
                    status: "completed",
                  },
                ],
              },
              {
                type: "activity",
                id: "live-turn-usage-turn-1",
                summary:
                  "Turn usage: 23,000 uncached in · 20,000 cached · 900 out (450 reasoning) · $0.12 list price",
                status: "completed",
                createdAt: 10_003,
                turn: {
                  id: "turn-1",
                  status: "completed",
                },
                details: [
                  {
                    id: "live-turn-usage-turn-1-input",
                    kind: "read",
                    label: "Input: 43,000 tokens (23,000 uncached, 20,000 cached)",
                    status: "completed",
                  },
                ],
              },
            ],
          },
        },
      }),
    });

    const response = await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response.readDurationMs).toEqual(expect.any(Number));
    expect(response.replay.entries.map((entry) => entry.id)).toEqual([
      "assistant-turn-1",
      "command-turn-1",
      "live-turn-usage-turn-1",
    ]);
    expect(response.replay.entries[1]).toMatchObject({
      id: "command-turn-1",
      summary: "Ran shell command",
    });
    expect(response.replay.entries[2]).toMatchObject({
      id: "live-turn-usage-turn-1",
      summary:
        "Turn usage: 23,000 uncached in · 20,000 cached · 900 out (450 reasoning) · $0.12 list price",
    });

    await registry.close();
  });

  it("omits overlay turn usage whose turn is not on the page being read", async () => {
    // The overlay retains up to MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES finalized
    // rows spanning the whole thread. Merging all of them into the newest page
    // stacked weeks-old usage under recent messages, and shipped rows the
    // reader had no turn for. Placement is turn-anchored, so a page carries
    // usage only for the turns it actually holds.
    const codexClient = new MockBackendClient({
      replay: {
        entries: [
          {
            type: "message",
            id: "assistant-turn-9",
            role: "assistant",
            phase: "final",
            text: "Recent answer.",
            createdAt: 90_000,
            turn: { id: "turn-9", status: "completed" },
          },
        ],
        messages: [],
        pagination: { supportsPagination: true, hasPreviousPage: true },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            immutableUsageActivities: [
              usageActivity({ createdAt: 10_000, turnId: "turn-1" }),
              usageActivity({ createdAt: 20_000, turnId: "turn-2" }),
              usageActivity({ createdAt: 90_001, turnId: "turn-9" }),
            ],
          },
        },
      }),
    });

    const response = await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response.replay.entries.map((entry) => entry.id)).toEqual([
      "assistant-turn-9",
      "live-turn-usage-turn-9",
    ]);

    await registry.close();
  });

  it("places overlay turn usage the page's turn ids cannot account for", async () => {
    // Omitting a row is sound only where the page's own turn ids prove the row
    // belongs to another page. A row with no turn id has no page that will
    // ever claim it, and a page with no turn metadata — the shape
    // findTurnPageStartIndex documents as still live — cannot claim anything.
    // Dropping either hides the row on every page: the operator watches usage
    // lines arrive during the turn and finds an empty transcript on restart.
    const codexClient = new MockBackendClient({
      replay: {
        entries: [
          {
            type: "message",
            id: "assistant-early",
            role: "assistant",
            phase: "final",
            text: "Earlier answer.",
            createdAt: 10_000,
          },
          {
            type: "message",
            id: "assistant-late",
            role: "assistant",
            phase: "final",
            text: "Later answer.",
            createdAt: 90_000,
          },
        ],
        messages: [],
        pagination: { supportsPagination: true, hasPreviousPage: false },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            immutableUsageActivities: [
              usageActivity({ createdAt: 90_001, turnId: "turn-9" }),
              usageActivity({ createdAt: 50_000, turnId: "turn-5" }),
              usageActivity({
                createdAt: 20_000,
                id: "live-turn-usage-thread-1",
              }),
            ],
          },
        },
      }),
    });

    const response = await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    // createdAt order, exactly where insertTranscriptEntry put them: the
    // 20_000 and 50_000 rows before the 90_000 message, the 90_001 row after.
    expect(response.replay.entries.map((entry) => entry.id)).toEqual([
      "assistant-early",
      "live-turn-usage-thread-1",
      "live-turn-usage-turn-5",
      "assistant-late",
      "live-turn-usage-turn-9",
    ]);

    await registry.close();
  });

  it("anchors overlay turn usage inside an older pagination page", async () => {
    // History pages used to receive no usage at all, which is why every row
    // had to be merged into the newest page. A `before` read now carries the
    // usage for its own turns, so scrolling back shows each row beside the
    // turn it belongs to.
    const codexClient = new MockBackendClient({
      replay: {
        entries: [
          {
            type: "message",
            id: "assistant-turn-1",
            role: "assistant",
            phase: "final",
            text: "Older answer.",
            createdAt: 10_000,
            turn: { id: "turn-1", status: "completed" },
          },
          {
            type: "activity",
            id: "command-turn-1",
            summary: "Ran shell command",
            status: "completed",
            createdAt: 10_001,
            turn: { id: "turn-1", status: "completed" },
            details: [],
          },
          {
            type: "message",
            id: "assistant-turn-2",
            role: "assistant",
            phase: "final",
            text: "Next older answer.",
            createdAt: 20_000,
            turn: { id: "turn-2", status: "completed" },
          },
        ],
        messages: [],
        pagination: { supportsPagination: true, hasPreviousPage: true },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            immutableUsageActivities: [
              usageActivity({ createdAt: 10_002, turnId: "turn-1" }),
              usageActivity({ createdAt: 20_001, turnId: "turn-2" }),
              usageActivity({ createdAt: 90_001, turnId: "turn-9" }),
            ],
          },
        },
      }),
    });

    const response = await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
      before: "assistant-turn-9",
    });

    // Each row sits after the last entry of its own turn, and turn-9 usage
    // stays off a page that does not carry turn-9.
    expect(response.replay.entries.map((entry) => entry.id)).toEqual([
      "assistant-turn-1",
      "command-turn-1",
      "live-turn-usage-turn-1",
      "assistant-turn-2",
      "live-turn-usage-turn-2",
    ]);

    await registry.close();
  });

  it("weaves overlay turn usage in one pass over the page", async () => {
    // The previous merge filtered and re-inserted the whole entry array once
    // per overlay row: 100 rows against a 500-entry page cost ~217,000 element
    // visits where ~1,000 suffice. Instrumented ids count how many times the
    // page is traversed, so a regression to per-row rebuilding fails here
    // rather than showing up as a slow thread months later.
    const pageEntryCount = 200;
    const overlayUsageCount = 100;
    let entryIdReads = 0;
    const entries = Array.from(
      { length: pageEntryCount },
      (_value, index): AppServerThreadEntry => {
        const id = `assistant-${index}`;
        return {
          type: "message",
          get id() {
            entryIdReads += 1;
            return id;
          },
          role: "assistant",
          phase: "final",
          text: `Answer ${index}`,
          createdAt: 10_000 + index,
          turn: { id: `turn-${index}`, status: "completed" },
        } as AppServerThreadEntry;
      },
    );
    const codexClient = new MockBackendClient({
      replay: {
        entries,
        messages: [],
        pagination: { supportsPagination: true, hasPreviousPage: true },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            // Half anchor to this page, half belong to turns it does not hold.
            immutableUsageActivities: Array.from(
              { length: overlayUsageCount },
              (_value, index) =>
                usageActivity({
                  createdAt: 10_000 + index,
                  turnId: index % 2 === 0 ? `turn-${index}` : `absent-${index}`,
                }),
            ),
          },
        },
      }),
    });

    entryIdReads = 0;
    const response = await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    // A per-row rebuild reads every id once per overlay row. Allow generous
    // headroom for unrelated id reads elsewhere in readThread while still
    // failing an O(page x usage) regression by two orders of magnitude.
    expect(entryIdReads).toBeLessThan(pageEntryCount * 10);
    expect(response.replay.entries).toHaveLength(
      pageEntryCount + overlayUsageCount / 2,
    );

    await registry.close();
  });

  it.each([
    { decision: "continue" as const, expectedSteers: 0 },
    { decision: "suggest_monitor" as const, expectedSteers: 1 },
  ])("uses the Token Miser helper model to review ambiguous polling: $decision", async ({
    decision,
    expectedSteers,
  }) => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
    });
    const generateStructuredObject = vi.fn(async (_params: Record<string, unknown>) => ({
      status: "ok" as const,
      object: {
        decision,
        reason: decision === "suggest_monitor"
          ? "Repeated checks of one long-running benchmark."
          : "The calls are productive incremental work.",
      },
      model: "gpt-6-luna",
    }));
    Object.assign(codexClient, { generateStructuredObject });
    const overlayStore = createOverlayStoreMock({ executionMode: "full-access" });
    const claim = vi.fn(() => true);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: { ...overlayStore, claimMonitorJobSuggestion: claim },
      resolveTokenMiserEnabled: () => true,
      resolveTokenMiserPollingReviewsEnabled: () => true,
    });
    try {
      const turn = await registry.startTurn({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "Run the benchmark" }],
      });
      const steer = vi.spyOn(registry, "steerTurn");
      const record = registryModules(registry).threadUsageLedger.recordToolInvocationAccounting.bind(registryModules(registry).threadUsageLedger);
      const now = vi.spyOn(Date, "now");
      for (let index = 0; index < 5; index++) {
        now.mockReturnValue(1_000_000 + index * 20_000);
        await record({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: turn.turnId,
              item: {
                id: `ambiguous-${index}`,
                type: "functionCall",
                name: "exec",
                status: "completed",
                arguments: {
                  input: "const status = await inspectBenchmark(); text(status);",
                },
                functionCallOutput: "still running",
              },
            },
          },
        } as AgentEvent);
      }
      now.mockRestore();
      await vi.waitFor(() => expect(generateStructuredObject).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(expectedSteers));
      expect(generateStructuredObject).toHaveBeenCalledWith(expect.objectContaining({
        helper: "token_miser_polling_reviews",
        disableExecution: true,
        prompt: expect.stringContaining("inspectBenchmark"),
      }));
      expect(generateStructuredObject.mock.calls[0]?.[0]).not.toHaveProperty("model");
      expect(claim).toHaveBeenCalledTimes(expectedSteers);
    } finally {
      vi.restoreAllMocks();
      await registry.close();
    }
  });

  it("keeps small Code Mode polls volatile while aggregating a noisy-poll alert", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
    });
    const upsertThreadToolInvocation = vi.fn(
      async (params: { invocation: ThreadToolInvocationRecord }) => params.invocation,
    );
    const upsertThreadToolInvocationAlert = vi.fn(
      async (params: { alert: ThreadToolInvocationAlert }) => params.alert,
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readRecentThreadToolInvocations: vi.fn(() => []),
      upsertThreadToolInvocation,
      upsertThreadToolInvocationAlert,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: overlayStore as never,
      resolveToolOutputAlertPolicy: () => ({
        outputCapHitsEnabled: false,
        repeatedLargeOutputsEnabled: false,
        repeatedLargeOutputMinimumCalls: 5,
        repeatedLargeOutputMinimumPercent: 50,
        repeatedQueuedChecksEnabled: true,
        monitorJobSuggestionsEnabled: false,
      }),
    });
    const record = registryModules(registry).threadUsageLedger.recordToolInvocationAccounting.bind(registryModules(registry).threadUsageLedger);
    const now = vi.spyOn(Date, "now");

    try {
      for (let index = 0; index < 5; index++) {
        now.mockReturnValue(1_000_000 + index * 30_000);
        await record({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: `code-poll-${index}`,
                type: "functionCall",
                name: "exec",
                status: "completed",
                arguments: {
                  input:
                    "const r = await tools.write_stdin({session_id:27324, yield_time_ms:30000}); text(r.output);",
                },
                functionCallOutput: "",
              },
            },
          },
        } as AgentEvent);
      }

      expect(upsertThreadToolInvocation).not.toHaveBeenCalled();
      expect(upsertThreadToolInvocationAlert).toHaveBeenCalledTimes(1);
      expect(upsertThreadToolInvocationAlert).toHaveBeenCalledWith({
        alert: expect.objectContaining({
          invocationCount: 5,
          kind: "noisy-polling",
          sessionId: "27324",
          toolName: "exec",
        }),
      });
    } finally {
      now.mockRestore();
      await registry.close();
    }
  });

  it("replays total spend until renderer acknowledgement, then suppresses it", async () => {
    const activeLine: ThreadUsageLineRecord = {
      backend: "codex",
      cachedInputCostMicros: 0,
      cachedInputTokens: 0,
      createdAt: 1_800_000_000_000,
      currency: "USD",
      inputTokens: 0,
      outputCostMicros: 0,
      outputTokens: 0,
      priceStatus: "priced",
      provider: "openai",
      reasoningOutputTokens: 0,
      scope: "turn",
      source: "live",
      status: "pending",
      threadId: "thread-1",
      totalCostMicros: 5_250_000,
      totalTokens: 0,
      turnId: "turn-2",
      turnUsageAttributed: true,
      uncachedInputCostMicros: 0,
      uncachedInputTokens: 0,
      usageLineId: "usage-turn-2",
    };
    const pricing = {
      lines: [activeLine],
      summaries: [{
        backend: "codex",
        cachedInputTokens: 0,
        currency: "USD",
        inputTokens: 0,
        outputTokens: 0,
        pricedUsageLineCount: 1,
        provider: "openai",
        reasoningOutputTokens: 0,
        threadId: "thread-1",
        totalCostMicros: 30_000_000,
        totalTokens: 0,
        uncachedInputTokens: 0,
        unpricedUsageLineCount: 0,
        updatedAt: 1_800_000_000_000,
        usageLineCount: 1,
      }],
    };
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadPricing: vi.fn(async () => pricing),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: overlayStore as never,
      resolveSpendAlertPolicy: () => ({
        activeTurnSpendEnabled: true,
        activeTurnSpendThresholdUsd: 5,
        threadSpendEnabled: true,
        threadSpendThresholdUsd: 25,
      }),
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const emitPricing = registryModules(registry).threadUsageLedger.emitThreadPricingUpdated.bind(registryModules(registry).threadUsageLedger);

    await emitPricing({
      activeTurnIds: ["turn-2"],
      backend: "codex",
      threadId: "thread-1",
    });
    await emitPricing({
      activeTurnIds: ["turn-2"],
      backend: "codex",
      threadId: "thread-1",
    });

    const pricingEvents = events.filter(
      (event) => event.notification.method === "thread/pricing/updated",
    );
    expect(pricingEvents[0]?.notification.params).toMatchObject({
      triggeredSpendAlerts: [
        { kind: "active-turn-spend", spendMicros: 5_250_000 },
        { kind: "thread-spend", spendMicros: 30_000_000 },
      ],
    });
    expect(pricingEvents[1]?.notification.params).toMatchObject({
      triggeredSpendAlerts: [
        { kind: "thread-spend", spendMicros: 30_000_000 },
      ],
    });
    const pendingAlert = (pricingEvents[1]!.notification.params as {
      triggeredSpendAlerts?: ThreadSpendAlert[];
    }).triggeredSpendAlerts?.[0];
    expect(pendingAlert?.kind).toBe("thread-spend");
    await registry.close();

    const restartedRegistry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: overlayStore as never,
      resolveSpendAlertPolicy: () => ({
        activeTurnSpendEnabled: true,
        activeTurnSpendThresholdUsd: 5,
        threadSpendEnabled: true,
        threadSpendThresholdUsd: 25,
      }),
    });
    const restartedEvents: AgentEvent[] = [];
    restartedRegistry.onEvent((event) => {
      restartedEvents.push(event);
    });
    const emitRestartedPricing = registryModules(restartedRegistry).threadUsageLedger.emitThreadPricingUpdated.bind(registryModules(restartedRegistry).threadUsageLedger);
    await emitRestartedPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(restartedEvents[0]?.notification.params).toMatchObject({
      triggeredSpendAlerts: [
        { kind: "thread-spend", spendMicros: 30_000_000 },
      ],
    });

    await (overlayStore as typeof overlayStore & {
      acknowledgeThreadSpendAlert(params: {
        alertId: string;
        backend: AppServerBackendKind;
        threadId: string;
      }): Promise<boolean>;
    }).acknowledgeThreadSpendAlert({
      alertId: pendingAlert?.alertId ?? "missing",
      backend: "codex",
      threadId: "thread-1",
    });
    await emitRestartedPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const acknowledgedPricingEvent = restartedEvents[1];
    expect(acknowledgedPricingEvent?.notification.params).not.toHaveProperty(
      "triggeredSpendAlerts",
    );
    await restartedRegistry.close();

    const acknowledgedRegistry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: overlayStore as never,
      resolveSpendAlertPolicy: () => ({
        activeTurnSpendEnabled: true,
        activeTurnSpendThresholdUsd: 5,
        threadSpendEnabled: true,
        threadSpendThresholdUsd: 25,
      }),
    });
    const acknowledgedEvents: AgentEvent[] = [];
    acknowledgedRegistry.onEvent((event) => {
      acknowledgedEvents.push(event);
    });
    await registryModules(acknowledgedRegistry).threadUsageLedger.emitThreadPricingUpdated({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(acknowledgedEvents[0]?.notification.params).not.toHaveProperty(
      "triggeredSpendAlerts",
    );
    await acknowledgedRegistry.close();
  });

  it("preserves every active turn while coalescing pricing updates", async () => {
    const lines: ThreadUsageLineRecord[] = ["turn-a", "turn-b"].map(
      (turnId, index) => ({
        backend: "codex",
        cachedInputCostMicros: 0,
        cachedInputTokens: 0,
        createdAt: 1_800_000_000_000 + index,
        currency: "USD",
        inputTokens: 0,
        outputCostMicros: 0,
        outputTokens: 0,
        priceStatus: "priced",
        provider: "openai",
        reasoningOutputTokens: 0,
        scope: "turn",
        source: "live",
        status: "pending",
        threadId: "thread-1",
        totalCostMicros: 6_000_000 + index * 1_000_000,
        totalTokens: 0,
        turnId,
        turnUsageAttributed: true,
        uncachedInputCostMicros: 0,
        uncachedInputTokens: 0,
        usageLineId: `usage-${turnId}`,
      }),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadPricing: vi.fn(async () => ({
        lines,
        summaries: [],
      })),
      upsertThreadUsageLines: vi.fn(async () => ({
        lines,
        summaries: [],
      })),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      resolveSpendAlertPolicy: () => ({
        activeTurnSpendEnabled: true,
        activeTurnSpendThresholdUsd: 5,
        threadSpendEnabled: false,
        threadSpendThresholdUsd: 25,
      }),
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const usageBatch = registryModules(registry).threadUsageLedger as unknown as {
      bufferLiveThreadUsageLine(params: {
        backend: AppServerBackendKind;
        line: ThreadUsageLineRecord;
        observationSequence: number;
      }): void;
      flushLiveThreadUsageLines(): Promise<void>;
    };
    lines.forEach((line, index) => {
      usageBatch.bufferLiveThreadUsageLine({
        backend: "codex",
        line,
        observationSequence: index + 1,
      });
    });

    await usageBatch.flushLiveThreadUsageLines();

    const pricingEvents = events.filter(
      (event) => event.notification.method === "thread/pricing/updated",
    );
    expect(pricingEvents).toHaveLength(1);
    expect(pricingEvents[0]?.notification.params).toMatchObject({
      triggeredSpendAlerts: [
        { kind: "active-turn-spend", turnId: "turn-a" },
        { kind: "active-turn-spend", turnId: "turn-b" },
      ],
    });

    await registry.close();
  });

  it("coalesces streamed command output into one accounting write", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const upsertThreadToolInvocation = vi.fn(
      async (params: { invocation: unknown }) => params.invocation,
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      upsertThreadToolInvocation,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: overlayStore as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    const deltas = ["first chunk\n", "second chunk\n", "third chunk\n"];
    for (const delta of deltas) {
      await emit({
        backend: "codex",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta,
          },
        },
      } as AgentEvent);
    }

    // Codex streams 8 KiB chunks at hundreds per second; none of them may cost
    // a sqlite read+write inline in the event pipeline.
    expect(upsertThreadToolInvocation).not.toHaveBeenCalled();

    await emit({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "find / -xdev",
            status: "completed",
            exitCode: 0,
          },
        },
      },
    } as AgentEvent);

    // The accumulated stream lands first: the store stops summing once a row
    // is terminal, so a delta written after the completion is under-counted.
    expect(upsertThreadToolInvocation).toHaveBeenCalledTimes(2);
    expect(upsertThreadToolInvocation.mock.calls[0]?.[0]).toMatchObject({
      invocation: {
        itemId: "cmd-1",
        outputChars: deltas.reduce((sum, delta) => sum + delta.length, 0),
        status: "in_progress",
      },
    });
    expect(upsertThreadToolInvocation.mock.calls[1]?.[0]).toMatchObject({
      invocation: { itemId: "cmd-1", status: "completed" },
    });

    await registry.close();
  });

  it("persists and aggregates live large-output alerts without completion", async () => {
    vi.useFakeTimers();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const upsertThreadToolInvocation = vi.fn(
      async (params: { invocation: unknown }) => params.invocation,
    );
    const persistThreadToolInvocationBoundary = vi.fn(
      async (params: { invocation: unknown }) => params.invocation,
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      persistThreadToolInvocationBoundary,
      upsertThreadToolInvocation,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: overlayStore as never,
      resolveToolOutputAlertPolicy: () => ({
        outputCapHitsEnabled: true,
        repeatedLargeOutputsEnabled: true,
        repeatedLargeOutputMinimumCalls: 3,
        repeatedLargeOutputMinimumPercent: 25,
        repeatedQueuedChecksEnabled: true,
      }),
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    try {
      const emit = (registry as unknown as {
        emit(event: AgentEvent): Promise<void>;
      }).emit.bind(registry);
      const stream = async (
        delta: string,
        itemId = "cmd-1",
      ): Promise<void> => {
        await emit({
          backend: "codex",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId,
              delta,
            },
          },
        } as AgentEvent);
      };

      await stream("x".repeat(5_000));
      await vi.advanceTimersByTimeAsync(250);
      expect(upsertThreadToolInvocation).toHaveBeenCalledTimes(1);

      // The warning total spans sqlite flush windows. A detector tied to the
      // 250ms pending-write buffer would see two harmless 5,000-char chunks
      // and never count that the command reached the configured 25% threshold.
      await stream("x".repeat(5_000));
      await stream("x".repeat(10_000), "cmd-2");
      expect(persistThreadToolInvocationBoundary).not.toHaveBeenCalled();

      await stream("x".repeat(10_000), "cmd-3");
      const alertEvent = events.find(
        (event) =>
          event.notification.method === "thread/toolAccounting/updated",
      );
      expect(alertEvent?.notification.params).toMatchObject({
        threadId: "thread-1",
        triggeredAlerts: [
          {
            invocationCount: 3,
            kind: "large-output",
            severity: "warning",
            totalOutputChars: 30_000,
            turnId: "turn-1",
          },
        ],
      });
      expect(persistThreadToolInvocationBoundary).toHaveBeenCalledTimes(1);
      expect(persistThreadToolInvocationBoundary).toHaveBeenCalledWith({
        alerts: [
          expect.objectContaining({
            kind: "large-output",
            severity: "warning",
            invocationCount: 3,
            totalOutputChars: 30_000,
          }),
        ],
        invocation: expect.objectContaining({
          invocationId: "tool:codex:thread-1:turn-1:cmd-3",
          noisy: true,
          noisyReason: "large-output",
          outputChars: 10_000,
          outputState: "available",
          source: "live",
          status: "in_progress",
          suggestedPrompt: expect.stringContaining("commandExecution"),
        }),
      });

      await registry.close();
      expect(upsertThreadToolInvocation.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes buffered command output on the timer, without a lifecycle event", async () => {
    // A command can stream for minutes before it completes. Nothing else in
    // this suite exercises the timer — every other case flushes through
    // `item/completed` or `close()` — so a broken schedule would leave the
    // whole run green while accounting sat in memory until the command ended.
    vi.useFakeTimers();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const upsertThreadToolInvocation = vi.fn(
      async (params: { invocation: unknown }) => params.invocation,
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      upsertThreadToolInvocation,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: overlayStore as never,
    });

    try {
      const emit = (registry as unknown as {
        emit(event: AgentEvent): Promise<void>;
      }).emit.bind(registry);
      const streamChunk = async (delta: string): Promise<void> => {
        await emit({
          backend: "codex",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              delta,
            },
          },
        } as AgentEvent);
      };

      await streamChunk("chunk one\n");
      await streamChunk("chunk two\n");
      await vi.advanceTimersByTimeAsync(250);

      expect(upsertThreadToolInvocation).toHaveBeenCalledTimes(1);
      expect(upsertThreadToolInvocation.mock.calls[0]?.[0]).toMatchObject({
        invocation: { itemId: "cmd-1", outputChars: 20, status: "in_progress" },
      });

      // The next window has to arm again, or a long command only ever records
      // its first 250ms of output.
      await streamChunk("chunk three\n");
      await vi.advanceTimersByTimeAsync(250);

      expect(upsertThreadToolInvocation).toHaveBeenCalledTimes(2);
      expect(upsertThreadToolInvocation.mock.calls[1]?.[0]).toMatchObject({
        invocation: { itemId: "cmd-1", outputChars: 12 },
      });

      await registry.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries buffered command output when the accounting write fails", async () => {
    vi.useFakeTimers();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
    });
    const upsertThreadToolInvocation = vi.fn(
      async (params: { invocation: unknown }) => params.invocation,
    );
    upsertThreadToolInvocation.mockRejectedValueOnce(new Error("disk full"));
    const overlayStore = {
      ...createOverlayStoreMock(),
      upsertThreadToolInvocation,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: overlayStore as never,
    });

    try {
      const emit = (registry as unknown as {
        emit(event: AgentEvent): Promise<void>;
      }).emit.bind(registry);
      await emit({
        backend: "codex",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta: "chunk one\n",
          },
        },
      } as AgentEvent);

      await vi.advanceTimersByTimeAsync(250);
      expect(upsertThreadToolInvocation).toHaveBeenCalledTimes(1);

      // A coalesced record stands in for a whole window of chunks, so dropping
      // it on a transient failure would lose far more than the per-chunk write
      // it replaced. It goes back in the buffer and rides the next flush.
      await vi.advanceTimersByTimeAsync(250);
      expect(upsertThreadToolInvocation).toHaveBeenCalledTimes(2);
      expect(upsertThreadToolInvocation.mock.calls[1]?.[0]).toMatchObject({
        invocation: { itemId: "cmd-1", outputChars: 10 },
      });

      await registry.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes lightweight budget pricing on the normal live usage flush", async () => {
    vi.useFakeTimers();
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/read"] } });
    const baseStore = createOverlayStoreMock();
    const request = { backend: "codex" as const, threadId: "thread-1", includeTurns: false };
    const overlayStore = {
      ...baseStore,
      upsertThreadUsageLines: async ({ lines }: { lines: ThreadUsageLineRecord[] }) => {
        for (const line of lines) await baseStore.upsertThreadUsageLine({ line });
        return await baseStore.readThreadPricing(request);
      },
    };
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    try {
      await codexClient.emit({ method: "thread/tokenUsage/updated", params: {
        threadId: request.threadId, turnId: "turn-live", model: "gpt-6-astra",
        tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, totalTokens: 1050 }, total: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, totalTokens: 1050 } },
      } });
      expect((await registry.readThread(request)).pricing?.lines).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await registry.readThread(request)).pricing?.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: "turn-live", totalTokens: 1050, inputTokens: 1000, cachedInputTokens: 200 }),
      ]));
      expect(codexClient.readThreadCalls.every((call) => call.includeTurns === false)).toBe(true);
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("persists live thread pricing from turn usage, not cumulative thread totals", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        tokenUsage: {
          last_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1_060,
          },
          total_token_usage: {
            input_tokens: 11_000,
            cached_input_tokens: 10_200,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 11_600,
          },
        },
      },
    });

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      cachedInputTokens: 200,
      cumulativeCachedInputTokens: 10_200,
      cumulativeInputTokens: 11_000,
      cumulativeOutputTokens: 500,
      cumulativeReasoningOutputTokens: 100,
      cumulativeTotalTokens: 11_600,
      cumulativeUncachedInputTokens: 800,
      inputTokens: 1_000,
      outputTokens: 50,
      reasoningEffort: "high",
      reasoningOutputTokens: 10,
      totalTokens: 1_060,
      turnId: "turn-2",
      turnUsageAttributed: true,
      uncachedInputTokens: 800,
    });
    expect(pricing.lines[0]?.cumulativeTotalCostMicros).toBeUndefined();

    // Headless budget polling must retain live usage without hydrating history.
    const budgetView = await registry.readThread({ backend: "codex", threadId: "thread-1", includeTurns: false });
    expect(budgetView.pricing?.lines).toEqual(pricing.lines);
    expect(codexClient.readThreadCalls.at(-1)).toMatchObject({ threadId: "thread-1", includeTurns: false });

    await registry.close();
  });

  it.each(["failed", "interrupted", "completed"])(
    "keeps request pricing through a context estimate and %s terminal", async (status) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/read"] },
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex", threadId: "thread-1", executionMode: "default",
            extraLinkedDirectories: [], model: "gpt-6-astra", serviceTier: "standard",
          },
        },
      });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const total = {
        input_tokens: 400_000, cached_input_tokens: 200_000,
        output_tokens: 20_000, reasoning_output_tokens: 0, total_tokens: 420_000,
      };
      for (const input of [200_000, 400_000]) {
        await codexClient.emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1", turnId: "turn-1",
            tokenUsage: {
              total_token_usage: {
                input_tokens: input, cached_input_tokens: input / 2,
                output_tokens: input / 20, reasoning_output_tokens: 0,
                total_tokens: input * 1.05,
              },
              last_token_usage: {
                input_tokens: 200_000, cached_input_tokens: 100_000,
                output_tokens: 10_000, reasoning_output_tokens: 0, total_tokens: 210_000,
              },
            },
          },
        });
      }
      const before = await overlayStore.readThreadPricing({ backend: "codex", threadId: "thread-1" });
      expect(before.lines[0]?.priceStatus).toBe("priced");
      expect(before.lines[0]?.totalCostMicros).toBeGreaterThan(0);
      // Codex recompute_token_usage publishes a context estimate in last,
      // without changing the cumulative billed usage. Rate-limit updates
      // may repeat that same snapshot.
      for (let i = 0; i < 2; i += 1) {
        await codexClient.emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1", turnId: "turn-1",
            tokenUsage: {
              total_token_usage: total,
              last_token_usage: {
                input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
                reasoning_output_tokens: 0, total_tokens: 160_000,
              },
            },
          },
        });
      }
      await codexClient.emit({
        method: status === "failed" ? "turn/failed" : "turn/completed",
        params: {
          threadId: "thread-1", turnId: "turn-1",
          turn: { id: "turn-1", status, error: status === "failed" ? { message: "Usage limit reached" } : undefined },
        },
      } as AppServerNotification);
      const after = await overlayStore.readThreadPricing({ backend: "codex", threadId: "thread-1" });
      expect(after.lines[0]).toMatchObject({
        priceStatus: "priced", pricingBasis: "request-components",
        inputTokens: 400_000, cachedInputTokens: 200_000, outputTokens: 20_000,
        totalCostMicros: before.lines[0]!.totalCostMicros,
      });
      await registry.close();
    },
  );

  it("prices an Astra aggregate from its context window when a request snapshot was missed", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-6-astra",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    // Two requests land between observations: the cumulative total grows by
    // more than the single `last` snapshot, so the observed request components
    // can no longer reproduce the turn total. The 258,400-token window still
    // proves no request entered the >272K band.
    for (const [input, cached] of [
      [200_000, 100_000],
      [600_000, 300_000],
    ]) {
      await codexClient.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            model_context_window: 258_400,
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: input / 20,
              reasoning_output_tokens: 0,
              total_tokens: input * 1.05,
            },
            last_token_usage: {
              input_tokens: 200_000,
              cached_input_tokens: 100_000,
              output_tokens: 10_000,
              reasoning_output_tokens: 0,
              total_tokens: 210_000,
            },
          },
        },
      });
    }

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines[0]).toMatchObject({
      cachedInputTokens: 300_000,
      inputTokens: 600_000,
      modelContextWindow: 258_400,
      outputTokens: 30_000,
      priceStatus: "priced",
      pricingRateId: "openai:2026-09-04:gpt-6-astra:standard:input-lte-272k",
      totalCostMicros: 4_800_000,
    });
    expect(pricing.lines[0]?.pricingBasis).toBeUndefined();
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();

    await registry.close();
  });

  it("prices each Astra request before aggregating a multi-request turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-6-astra",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    for (const cumulativeInputTokens of [200_000, 400_000]) {
      for (let emission = 0; emission < 2; emission += 1) {
        await codexClient.emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 200_000,
                cache_write_input_tokens: 10_000,
                cached_input_tokens: 100_000,
                output_tokens: 10_000,
                reasoning_output_tokens: 0,
                total_tokens: 210_000,
              },
              total_token_usage: {
                input_tokens: cumulativeInputTokens,
                cache_write_input_tokens: cumulativeInputTokens / 20,
                cached_input_tokens: cumulativeInputTokens / 2,
                output_tokens: cumulativeInputTokens / 20,
                reasoning_output_tokens: 0,
                total_tokens: cumulativeInputTokens * 1.05,
              },
            },
          },
        });
      }
    }

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      cacheWriteInputCostMicros: 250_000,
      cacheWriteInputTokens: 20_000,
      cachedInputTokens: 200_000,
      cachedInputCostMicros: 200_000,
      inputTokens: 400_000,
      outputCostMicros: 1_000_000,
      priceStatus: "priced",
      pricingBasis: "request-components",
      pricingRateId: "openai:2026-09-04:gpt-6-astra:standard:input-lte-272k",
      totalCostMicros: 3_250_000,
      uncachedInputCostMicros: 1_800_000,
      uncachedInputTokens: 200_000,
    });

    await registry.close();
  });

  it("sums mixed Astra short- and long-context request rates exactly", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-6-astra",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const requests = [
      { cached: 100_000, input: 200_000, totalInput: 200_000 },
      { cached: 100_000, input: 300_000, totalInput: 500_000 },
    ];

    for (const request of requests) {
      await codexClient.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            last: {
              cachedInputTokens: request.cached,
              inputTokens: request.input,
              outputTokens: 10_000,
              reasoningOutputTokens: 0,
              totalTokens: request.input + 10_000,
            },
            total: {
              cachedInputTokens: request.totalInput === 200_000 ? 100_000 : 200_000,
              inputTokens: request.totalInput,
              outputTokens: request.totalInput === 200_000 ? 10_000 : 20_000,
              reasoningOutputTokens: 0,
              totalTokens: request.totalInput === 200_000 ? 210_000 : 520_000,
            },
          },
        },
      });
    }

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      cachedInputCostMicros: 300_000,
      inputTokens: 500_000,
      outputCostMicros: 1_250_000,
      priceStatus: "priced",
      pricingBasis: "request-components",
      pricingCatalogId: "openai-api",
      pricingCatalogVersion: "2026-09-04",
      totalCostMicros: 6_550_000,
      uncachedInputCostMicros: 5_000_000,
    });
    expect(pricing.lines[0]?.pricingRateId).toBeUndefined();

    await registry.close();
  });

  it("records the end time when a turn completes without later usage", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: { inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1_020 },
          total: { inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1_020 },
        },
      },
    });
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed", completedAt: 1_800_000_004_000, output: [] },
      },
    });

    const pricing = await overlayStore.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      completedAt: 1_800_000_004_000,
      status: "pending",
      turnId: "turn-1",
    });
    await registry.close();
  });

  it("attributes turnless usage emitted after completion to the completed turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.5",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: {
            inputTokens: 1_000,
            cachedInputTokens: 100,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            totalTokens: 1_025,
          },
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 100,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            totalTokens: 1_025,
          },
        },
      },
    });
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          completedAt: 1_800_000_004_000,
          output: [],
        },
      },
    });
    const lateUsageNotification: AppServerNotification = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          last: {
            inputTokens: 2_000,
            cachedInputTokens: 1_800,
            outputTokens: 30,
            reasoningOutputTokens: 10,
            totalTokens: 2_040,
          },
        },
      },
    };
    await codexClient.emit(lateUsageNotification);
    await codexClient.emit(lateUsageNotification);

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      cachedInputTokens: 1_900,
      completedAt: 1_800_000_004_000,
      inputTokens: 3_000,
      outputTokens: 50,
      reasoningOutputTokens: 15,
      totalTokens: 3_065,
      turnId: "turn-1",
      turnUsageAttributed: true,
      uncachedInputTokens: 1_100,
      usageLineId: "codex:thread-1:turn-1:live-token-usage",
    });

    await registry.close();
  });

  it("folds final and peak protocol context observations into the existing usage row", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    for (const [lastTotalTokens, cumulativeTotalTokens] of [
      [243_864, 243_864],
      [131_443, 375_307],
    ]) {
      await codexClient.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-context",
          turnId: "turn-context",
          tokenUsage: {
            model_context_window: 258_400,
            last: {
              inputTokens: lastTotalTokens,
              cachedInputTokens: Math.max(0, lastTotalTokens - 1_000),
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: lastTotalTokens,
            },
            total: {
              inputTokens: cumulativeTotalTokens,
              cachedInputTokens: Math.max(0, cumulativeTotalTokens - 2_000),
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: cumulativeTotalTokens,
            },
          },
        },
      });
    }

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-context",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      finalContextTokens: 131_443,
      modelContextWindow: 258_400,
      peakContextTokens: 243_864,
    });

    await registry.close();
  });

  it("attributes a late Codex usage snapshot from the preceding cumulative total", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    // Codex can emit the previous turn's final cumulative snapshot only when
    // the thread is resumed. Preserve it as the next turn's opening balance.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: {
            inputTokens: 171_318,
            cachedInputTokens: 169_728,
            outputTokens: 100,
            reasoningOutputTokens: 0,
            totalTokens: 171_418,
          },
          total: {
            inputTokens: 49_575_456,
            cachedInputTokens: 47_800_576,
            outputTokens: 118_122,
            reasoningOutputTokens: 46_342,
            totalTokens: 49_693_578,
          },
        },
      },
    });

    // Only one snapshot arrives for turn 2. `last` is merely its final
    // cache-hot model request; total - turn 1 is the complete turn usage.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        tokenUsage: {
          last: {
            inputTokens: 228_834,
            cachedInputTokens: 227_840,
            outputTokens: 141,
            reasoningOutputTokens: 0,
            totalTokens: 228_975,
          },
          total: {
            inputTokens: 59_830_359,
            cachedInputTokens: 57_795_328,
            outputTokens: 128_478,
            reasoningOutputTokens: 49_365,
            totalTokens: 59_958_837,
          },
        },
      },
    });

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const turn2 = pricing.lines.find((line) => line.turnId === "turn-2");

    expect(turn2).toMatchObject({
      cachedInputTokens: 9_994_752,
      inputTokens: 10_254_903,
      outputTokens: 10_356,
      reasoningOutputTokens: 3_023,
      totalCostMicros: 5_306_085,
      totalTokens: 10_265_259,
      turnUsageAttributed: true,
      uncachedInputTokens: 260_151,
    });

    await registry.close();
  });

  it("derives consecutive Codex turns in arrival order when overlay reads overlap", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlay: ThreadOverlayState = {
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
      extraLinkedDirectories: [],
      model: "gpt-5.5",
      serviceTier: "standard",
    };
    const baseOverlayStore = createOverlayStoreMock({
      overlays: { "codex:thread-1": overlay },
    });
    let releaseFirstOverlay!: () => void;
    const firstOverlay = new Promise<ThreadOverlayState>((resolve) => {
      releaseFirstOverlay = () => resolve(overlay);
    });
    const getThreadOverlayState = vi.fn()
      .mockImplementationOnce(() => firstOverlay)
      .mockResolvedValue(overlay);
    const overlayStore = {
      ...baseOverlayStore,
      getThreadOverlayState,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const usage = (params: {
      inputTokens: number;
      lastInputTokens: number;
      turnId: string;
    }): AppServerNotification => ({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: params.turnId,
        tokenUsage: {
          last: {
            inputTokens: params.lastInputTokens,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: params.lastInputTokens,
          },
          total: {
            inputTokens: params.inputTokens,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: params.inputTokens,
          },
        },
      },
    });

    const turn1 = codexClient.emit(usage({
      inputTokens: 1_000,
      lastInputTokens: 100,
      turnId: "turn-1",
    }));
    await vi.waitFor(() => expect(getThreadOverlayState).toHaveBeenCalledTimes(1));
    const turn2 = codexClient.emit(usage({
      inputTokens: 3_000,
      lastInputTokens: 200,
      turnId: "turn-2",
    }));
    await vi.waitFor(() =>
      expect(getThreadOverlayState.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    releaseFirstOverlay();
    await Promise.all([turn1, turn2]);

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(
      pricing.lines.find((line) => line.turnId === "turn-2")?.inputTokens,
    ).toBe(2_000);

    await registry.close();
  });

  it.each(["explicit", "turnless"])(
    "preserves an earlier turn when a %s snapshot includes a newer turn's usage",
    async (attribution) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/read"] },
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex", threadId: "thread-1", executionMode: "default",
            extraLinkedDirectories: [], model: "gpt-6-astra", serviceTier: "standard",
          },
        },
      });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const emitUsage = async (turnId: string | undefined, total: number, last: number) => {
        const tokens = (inputTokens: number) => ({
          inputTokens, cachedInputTokens: 0, outputTokens: 0,
          reasoningOutputTokens: 0, totalTokens: inputTokens,
        });
        await codexClient.emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1", ...(turnId ? { turnId } : {}),
            tokenUsage: { total: tokens(total), last: tokens(last) },
          },
        });
      };
      const readLines = async () => (await overlayStore.readThreadPricing({
        backend: "codex", threadId: "thread-1",
      })).lines;

      await emitUsage("turn-1", 1_000, 1_000);
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1", turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      });
      // A resumed stream can expose turn 2 usage without its start event.
      await emitUsage("turn-2", 101_000, 10_000);
      const earlier = (await readLines()).find((line) => line.turnId === "turn-1");
      await emitUsage(attribution === "explicit" ? "turn-1" : undefined, 102_000, 1_000);
      expect((await readLines()).find((line) => line.turnId === "turn-1")).toEqual(earlier);
      await emitUsage("turn-2", 103_000, 1_000);
      const lines = await readLines();
      expect(lines).toHaveLength(2);
      expect(lines.find((line) => line.turnId === "turn-2")?.inputTokens).toBe(102_000);
      expect(lines.reduce((sum, line) => sum + line.inputTokens, 0)).toBe(103_000);
      await registry.close();
    },
  );

  it.each(["explicit", "turnless"])(
    "keeps current usage advancing after an equal-total %s older-turn replay",
    async (attribution) => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/read"] },
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex", threadId: "thread-1", executionMode: "default",
            extraLinkedDirectories: [], model: "gpt-6-astra", serviceTier: "standard",
          },
        },
      });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const emitUsage = async (turnId: string | undefined, total: number, last: number) => {
        const tokens = (inputTokens: number) => ({
          inputTokens, cachedInputTokens: 0, outputTokens: 0,
          reasoningOutputTokens: 0, totalTokens: inputTokens,
        });
        await codexClient.emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1", ...(turnId ? { turnId } : {}),
            tokenUsage: { total: tokens(total), last: tokens(last) },
          },
        });
      };
      await emitUsage("turn-1", 1_000, 1_000);
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1", turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", output: [] },
        },
      });
      // Turn 2 has an identity before it consumes any additional tokens.
      await emitUsage("turn-2", 1_000, 1_000);
      const replayTurnId = attribution === "explicit" ? "turn-1" : undefined;
      await emitUsage(replayTurnId, 1_000, 1_000);
      await emitUsage(replayTurnId, 1_000, 1_000);
      await emitUsage("turn-2", 2_000, 1_000);
      await emitUsage("turn-2", 3_000, 1_000);
      // Ownership must also remain correct when the next turn starts.
      await emitUsage("turn-3", 4_000, 1_000);
      await emitUsage("turn-2", 3_000, 1_000);
      await emitUsage("turn-3", 5_000, 1_000);
      const pricing = await overlayStore.readThreadPricing({
        backend: "codex", threadId: "thread-1",
      });
      expect(pricing.lines).toHaveLength(3);
      for (const [turnId, inputTokens] of [
        ["turn-1", 1_000], ["turn-2", 2_000], ["turn-3", 2_000],
      ] as const) {
        expect(pricing.lines.find((line) => line.turnId === turnId)?.inputTokens).toBe(inputTokens);
      }
      await registry.close();
    },
  );

  it("does not regress Codex cumulative usage on a late older-turn snapshot", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.5",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const emitUsage = async (params: {
      inputTokens: number;
      lastInputTokens: number;
      turnId: string;
    }) => {
      await codexClient.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: params.turnId,
          tokenUsage: {
            last: {
              inputTokens: params.lastInputTokens,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: params.lastInputTokens,
            },
            total: {
              inputTokens: params.inputTokens,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: params.inputTokens,
            },
          },
        },
      });
    };

    await emitUsage({ inputTokens: 1_000, lastInputTokens: 100, turnId: "turn-1" });
    await emitUsage({ inputTokens: 3_000, lastInputTokens: 200, turnId: "turn-2" });
    // A reconnect can re-emit turn 1 after turn 2. Its larger arrival sequence
    // must not make the lower cumulative total the new high-water mark.
    await emitUsage({ inputTokens: 1_000, lastInputTokens: 100, turnId: "turn-1" });
    await emitUsage({ inputTokens: 6_000, lastInputTokens: 300, turnId: "turn-3" });

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(
      pricing.lines.find((line) => line.turnId === "turn-3")?.inputTokens,
    ).toBe(3_000);

    await registry.close();
  });

  it("persists Qwen turn usage as an unpriced card when no catalog rate exists", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.publishLocalEvent({
      backend: "acp:qwen",
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "qwen-thread",
          turnId: "qwen-turn",
          model: "qwen3-coder-plus",
          tokenUsage: {
            last_token_usage: {
              input_tokens: 48_851,
              cached_input_tokens: 20_000,
              output_tokens: 322,
              reasoning_output_tokens: 49,
              total_tokens: 49_173,
            },
          },
        },
      },
    });

    const pricing = await overlayStore.readThreadPricing({
      backend: "acp:qwen",
      threadId: "qwen-thread",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      cachedInputTokens: 20_000,
      inputTokens: 48_851,
      model: "qwen3-coder-plus",
      outputTokens: 322,
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-rate",
      provider: "qwen",
      reasoningOutputTokens: 49,
      totalCostMicros: 0,
      totalTokens: 49_173,
      turnId: "qwen-turn",
      turnUsageAttributed: true,
    });
    expect(pricing.lines[0]?.pricingRateId).toBeUndefined();

    await registry.close();
  });

  it("persists priced Qwen 3.7 Plus ModelStudio usage", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.publishLocalEvent({
      backend: "acp:qwen",
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "qwen-thread",
          turnId: "qwen-turn",
          model: "qwen3.7-plus(openai)",
          tokenUsage: {
            last_token_usage: {
              input_tokens: 39_286,
              cached_input_tokens: 0,
              output_tokens: 90,
              reasoning_output_tokens: 49,
              total_tokens: 39_376,
            },
          },
        },
      },
    });

    const pricing = await overlayStore.readThreadPricing({
      backend: "acp:qwen",
      threadId: "qwen-thread",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      cachedInputCostMicros: 0,
      inputTokens: 39_286,
      model: "qwen3.7-plus(openai)",
      outputCostMicros: 144,
      outputTokens: 90,
      priceStatus: "priced",
      pricingCatalogId: "qwen-modelstudio-international",
      pricingCatalogVersion: "2026-07-15",
      pricingRateId:
        "qwen:2026-07-15:qwen3.7-plus:standard:input-lte-256k",
      provider: "qwen",
      reasoningOutputTokens: 49,
      totalCostMicros: 15_858,
      totalTokens: 39_376,
      turnId: "qwen-turn",
      turnUsageAttributed: true,
      uncachedInputCostMicros: 15_714,
    });

    await registry.close();
  });

  it("marks a whole-thread total with no per-request usage as unattributed", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.5",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    // Only a cumulative total, no per-request `last` snapshot to isolate the
    // turn: the builder can't attribute this to the turn, so it records
    // turnUsageAttributed: false and the row reads as a whole-thread summary.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-3",
        tokenUsage: {
          total_token_usage: {
            input_tokens: 11_000,
            cached_input_tokens: 10_200,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 11_600,
          },
        },
      },
    });

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      totalTokens: 11_600,
      turnId: "turn-3",
      turnUsageAttributed: false,
    });

    await registry.close();
  });

  it("records inherited fork context as a zero-cost fork-baseline line, once", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-fork": {
          backend: "codex",
          threadId: "thread-fork",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.5",
          serviceTier: "standard",
          // Marks this thread as a fork of thread-parent: its first observed
          // `total` already includes the copied-in parent context.
          forkSourceThreadId: "thread-parent",
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    // First observed turn of the fork. `last` is this turn; `total` = inherited
    // fork context + this turn.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-fork",
        turnId: "turn-1",
        tokenUsage: {
          last_token_usage: {
            input_tokens: 160_000,
            cached_input_tokens: 159_104,
            output_tokens: 6,
            reasoning_output_tokens: 0,
            total_tokens: 160_006,
          },
          total_token_usage: {
            input_tokens: 18_961_393,
            cached_input_tokens: 17_787_776,
            output_tokens: 46_000,
            reasoning_output_tokens: 9_979,
            total_tokens: 19_017_372,
          },
        },
      },
    });

    const afterTurn1 = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-fork",
    });

    const forkLines = afterTurn1.lines.filter(
      (line) => line.scope === "fork-baseline",
    );
    expect(forkLines).toHaveLength(1);
    // Inherited = total − last, priced at $0 (billed on the parent thread).
    expect(forkLines[0]).toMatchObject({
      scope: "fork-baseline",
      source: "backfill",
      status: "finalized",
      priceStatus: "priced",
      model: "gpt-5.5",
      uncachedInputTokens: 1_172_721,
      cachedInputTokens: 17_628_672,
      outputTokens: 45_994,
      reasoningOutputTokens: 9_979,
      totalCostMicros: 0,
      uncachedInputCostMicros: 0,
      cachedInputCostMicros: 0,
      outputCostMicros: 0,
    });
    expect(forkLines[0]?.cumulativeCachedInputTokens).toBeUndefined();

    // The live turn line still records only this turn's own usage.
    const turnLine = afterTurn1.lines.find((line) => line.scope === "turn");
    expect(turnLine).toMatchObject({
      turnId: "turn-1",
      uncachedInputTokens: 896,
      cachedInputTokens: 159_104,
      outputTokens: 6,
    });

    const forkOverlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-fork",
    });
    expect(forkOverlay?.forkBaselineCaptured).toBe(true);

    // A later turn must not create a second fork-baseline line.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-fork",
        turnId: "turn-2",
        tokenUsage: {
          last_token_usage: {
            input_tokens: 5_000,
            cached_input_tokens: 4_992,
            output_tokens: 7,
            reasoning_output_tokens: 0,
            total_tokens: 5_007,
          },
          total_token_usage: {
            input_tokens: 18_966_393,
            cached_input_tokens: 17_792_768,
            output_tokens: 46_007,
            reasoning_output_tokens: 9_979,
            total_tokens: 19_022_379,
          },
        },
      },
    });

    const afterTurn2 = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-fork",
    });
    expect(
      afterTurn2.lines.filter((line) => line.scope === "fork-baseline"),
    ).toHaveLength(1);

    await registry.close();
  });

  it("does not record a fork-baseline line for non-fork threads", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.5",
          serviceTier: "standard",
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    // A non-fork thread observed late: `total` far exceeds `last`, but there is
    // no fork origin, so no fork-baseline line is invented.
    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        tokenUsage: {
          last_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1_060,
          },
          total_token_usage: {
            input_tokens: 11_000,
            cached_input_tokens: 10_200,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 11_600,
          },
        },
      },
    });

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(
      pricing.lines.filter((line) => line.scope === "fork-baseline"),
    ).toHaveLength(0);

    await registry.close();
  });

  it("does not capture a fork baseline when an earlier turn was already observed", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/read"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-fork": {
          backend: "codex",
          threadId: "thread-fork",
          executionMode: "default",
          extraLinkedDirectories: [],
          model: "gpt-5.5",
          serviceTier: "standard",
          forkSourceThreadId: "thread-parent",
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    // Simulate turn-1 already having been observed (a persisted turn line)
    // WITHOUT the fork baseline having been captured (e.g. the latch write was
    // lost). The first turn we now observe is turn-2, whose total−latest folds
    // turn-1's own usage — so no fork baseline may be fabricated.
    await overlayStore.upsertThreadUsageLine({
      line: {
        backend: "codex",
        usageLineId: "codex:thread-fork:turn-1:live-token-usage",
        threadId: "thread-fork",
        turnId: "turn-1",
        scope: "turn",
        source: "live",
        status: "finalized",
        model: "gpt-5.5",
        currency: "USD",
        inputTokens: 160_000,
        cachedInputTokens: 159_104,
        uncachedInputTokens: 896,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        totalTokens: 160_006,
        priceStatus: "priced",
        provider: "openai",
        cachedInputCostMicros: 0,
        uncachedInputCostMicros: 0,
        outputCostMicros: 0,
        totalCostMicros: 0,
        createdAt: 1_800_000_000_000,
      },
    });

    await codexClient.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-fork",
        turnId: "turn-2",
        tokenUsage: {
          last_token_usage: {
            input_tokens: 5_000,
            cached_input_tokens: 4_992,
            output_tokens: 7,
            reasoning_output_tokens: 0,
            total_tokens: 5_007,
          },
          total_token_usage: {
            input_tokens: 18_966_393,
            cached_input_tokens: 17_792_768,
            output_tokens: 46_007,
            reasoning_output_tokens: 9_979,
            total_tokens: 19_022_379,
          },
        },
      },
    });

    const pricing = await overlayStore.readThreadPricing({
      backend: "codex",
      threadId: "thread-fork",
    });
    expect(
      pricing.lines.filter((line) => line.scope === "fork-baseline"),
    ).toHaveLength(0);
    // The guard latches so it will not keep re-checking on later turns.
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-fork",
    });
    expect(overlay?.forkBaselineCaptured).toBe(true);

    await registry.close();
  });
});
