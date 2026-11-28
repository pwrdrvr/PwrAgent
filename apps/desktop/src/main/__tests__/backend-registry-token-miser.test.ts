import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { boundedCommandHelper } from "../token-miser/bounded-command-helper";
import { boundedCommandTools } from "../agent-tools/bounded-command-tool";
import { buildOpenAIDecisionsUsageLine } from "../openai-decisions/openai-decisions-service";
import type { TokenMiserServiceOptions } from "../token-miser/token-miser-service";
import { buildTokenMiserSavingsSummary } from "@pwragent/shared/token-miser-savings-summary";
import { estimateTokenUsageCost } from "@pwragent/shared/token-usage-pricing";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled, measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { OPENAI_DECISIONS_MODEL, OPENAI_DECISIONS_ORIGIN, openAIDecisionSafetyMaterial } from "@pwragent/shared/openai-decisions";
import { codexModelProviderAccountKey, usageAccountKey } from "../usage-account-identity";
import { ClaudeBackend } from "../claude/claude-backend";
import { AcpBackendAdapter } from "../app-server/acp-backend-adapter";
import type { BoundedCommandHelper } from "../token-miser/bounded-command-helper";
import type { BoundedCommandCaller, BoundedCommandCapture } from "../token-miser/bounded-command";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import * as settingsOwner from "../settings/desktop-settings-singleton";
import * as ownerHost from "../owner-host";
import { resolveActiveProfileName } from "../profile";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationSnapshot, ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ThreadToolAccounting,
  ThreadToolInvocationRecord,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { TokenMiserCodeModeObservation, TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry, disposeDesktopBackendRegistry, initializeDesktopBackendRegistry } from "../app-server/backend-registry";
import * as navigationQuerySource from "../app-server/navigation-query-source";
import { createLocalThreadFamilyPricingReader } from "../app-server/thread-family-pricing-source";
import { indexTokenMiserCachedReplays, indexTokenMiserPricingLines } from "../app-server/token-miser-ledger-index";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { disposeAppState, initializeAppState } from "../state/app-state";
import { disposeDesktopSettingsService, initializeDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { initializeDesktopConfigStore } from "../settings/config-store/desktop-config-store-singleton";
import { SqliteTokenMiserStorage } from "../storage/token-miser-storage-sqlite";
import { TokenMiserStore as PersistedTokenMiserStore } from "../token-miser/token-miser-store";
import { TestTokenMiserStore as TokenMiserStore } from "./token-miser-test-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { diagnosticExcerpt, TokenMiserDiagnostics } from "../token-miser/token-miser-diagnostics";

const capturedEvidence = { command: "git diff", exitCode: 0, bytes: 8192, lines: 64, repeatedLines: 0, zeroTests: false, sample: "first", detail: "first and second" };

describe("DesktopBackendRegistry Token Miser ledger", () => {
  let directory: string;
  let registry: DesktopBackendRegistry;
  let stateDb: StateDb;
  let store: SqliteOverlayStore;
  let expectedCloseFailure: string | undefined;

  beforeEach(() => {
    expectedCloseFailure = undefined;
    directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-token-miser-ledger-"));
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
    registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
    });
  });

  it.each([false, true])("does zero Token Miser history work at startup (enabled=%s)", async (enabled) => {
    await registry.close();
    const profile = initializeAppState();
    const { stateDb: profileDb, overlayStore } = profile;
    const storage = new SqliteTokenMiserStorage(profileDb);
    const threadId = enabled ? "enabled-history" : "disabled-history";
    const gate = { ...metadata(`${threadId}-gate`, `${threadId}-helper`), threadId, replayTrackingVersion: 2 } as TokenMiserObjectMetadata;
    storage.writeMetadata(gate);
    storage.writeMetadata({ ...gate, objectId: `${threadId}-other-gate`, threadId: "other-thread" });
    const pages = vi.spyOn(SqliteTokenMiserStorage.prototype, "readMetadataPage");
    const legacy = vi.spyOn(SqliteTokenMiserStorage.prototype, "hasLegacyMigration");
    const pricing = vi.spyOn(overlayStore, "readTokenMiserGatePricingLines");
    const cards = vi.spyOn(overlayStore, "getThreadSubAgents");
    try {
      initializeDesktopConfigStore();
      initializeDesktopSettingsService();
      registry = createDesktopBackendRegistry({ overlayStore, mcpConnectionService: null, resolveTokenMiserEnabled: () => enabled });
      const prepareRuntime = vi.spyOn(registry as unknown as { prepareTokenMiserRuntime(): Promise<void> },
        "prepareTokenMiserRuntime").mockResolvedValue();
      await registry.prepareTokenMiserRuntimeAtStartup();
      // Drain any constructor-scheduled work through its first yield.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await registry.readUsageActivity({ from: gate.createdAt - 1, to: gate.createdAt + 1000 });
      expect(pages).not.toHaveBeenCalled();
      expect(pricing).not.toHaveBeenCalled();
      expect(cards).not.toHaveBeenCalled();
      expect(prepareRuntime).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (!enabled) expect(legacy).not.toHaveBeenCalled();

      await registry.readThread({ backend: "codex", threadId, display: { resource: "incident" } });
      expect(pages).not.toHaveBeenCalled();
      expect(pricing).not.toHaveBeenCalled();
      cards.mockClear();

      const invalidateNavigation = vi.spyOn(registry as unknown as { invalidateThreadListCache(): void }, "invalidateThreadListCache");
      await registry.readThread({ backend: "codex", threadId, display: { resource: "pricing" } });
      expect(pages.mock.calls).toEqual([[undefined, 64, threadId]]);
      expect(pricing.mock.calls.map(([request]) => request.threadId)).toEqual([threadId]);
      expect(cards.mock.calls.length).toBeGreaterThan(0);
      expect(cards.mock.calls.every(([request]) => request.threadId === threadId)).toBe(true);
      expect(invalidateNavigation).not.toHaveBeenCalled();
    } finally {
      try { await registry.close(); } finally {
        pages.mockRestore();
        legacy.mockRestore();
        pricing.mockRestore();
        cards.mockRestore();
        disposeDesktopSettingsService();
        disposeAppState();
      }
    }
  });

  it("recovers a child's missing helper charge on the first family pricing read", async () => {
    await registry.close();
    const { overlayStore, stateDb: profileDb } = initializeAppState();
    profileDb.stopGc();
    await overlayStore.moveLegacyThreadUsageActivities();
    const storage = new SqliteTokenMiserStorage<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(profileDb);
    const threads: NavigationSnapshot["threads"] = ["parent", "child", "unrelated"].map((id) => ({
      id, source: "codex", title: id, titleSource: "derived",
      createdAt: 1, updatedAt: 1, linkedDirectories: [], inbox: { inInbox: false },
      ...(id === "child" ? { parentThreadId: "parent" } : {}),
    }));
    const index = vi.spyOn(navigationQuerySource, "loadLocalNavigationQueryIndex").mockResolvedValue({ directories: [], threads });
    try {
      initializeDesktopConfigStore();
      initializeDesktopSettingsService();
      registry = initializeDesktopBackendRegistry(() => createDesktopBackendRegistry({ overlayStore, mcpConnectionService: null, resolveTokenMiserEnabled: () => false }));
      const startup = registry as unknown as { subAgentStartupReconciliation: Promise<void>; usageTurnStartupRepair: Promise<void> };
      await Promise.all([startup.subAgentStartupReconciliation, startup.usageTurnStartupRepair]);
      for (const id of ["child", "unrelated"]) {
        storage.writeMetadata({ ...metadata(randomUUID(), `${id}-helper`), threadId: id, replayTrackingVersion: 2 });
      }
      const read = createLocalThreadFamilyPricingReader(undefined);
      const request = { backend: "codex", threadId: "parent" } as const;
      const ledger = registryModules(registry).threadUsageLedger;
      await ledger.prepareTokenMiserStorage();
      if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: profileDb.raw, dbPath: profileDb.raw.name });
      const { result: family, writes } = await measureSqliteWrites(() => read(request));
      expect(family.members.find((member) => member.threadId === "child")?.totalCostMicros).toBeGreaterThan(0);
      expectSqliteWriteBudget({ scenario: "token-miser-thread-family-charge-repair", writes,
        note: "A family pricing read recovers one missing helper charge for a local child without repairing cards." });
      expect(await overlayStore.readThreadPricingSummaries([{ backend: "codex", threadId: "unrelated" }])).toEqual([]);
      expect(await overlayStore.listThreadSubAgents({ backend: "codex", threadId: "child" })).toEqual([]);
      const repeated = await measureSqliteWrites(() => read(request));
      expect(repeated.result.members).toEqual(family.members);
      expect(repeated.writes.commits).toBe(0);
    } finally {
      index.mockRestore();
      try { await disposeDesktopBackendRegistry(); } finally {
        disposeDesktopSettingsService();
        disposeAppState();
      }
    }
  });

  it("removes legacy payloads after startup without a Token Miser read", async () => {
    await registry.close();
    const { overlayStore, stateDb: profileDb } = initializeAppState();
    profileDb.stopGc();
    await overlayStore.moveLegacyThreadUsageActivities();
    const legacy = path.join(directory, "objects");
    const gate = metadata(randomUUID(), "helper");
    const payload = path.join(legacy, `${gate.objectId}.txt`);
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(payload, "legacy raw output");
    await fs.writeFile(path.join(legacy, `${gate.objectId}.json`), JSON.stringify(gate));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      initializeDesktopConfigStore();
      initializeDesktopSettingsService();
      registry = createDesktopBackendRegistry({ overlayStore, mcpConnectionService: null, resolveTokenMiserEnabled: () => false });
      const startup = registry as unknown as { subAgentStartupReconciliation: Promise<void>; usageTurnStartupRepair: Promise<void> };
      await Promise.all([startup.subAgentStartupReconciliation, startup.usageTurnStartupRepair]);
      const storage = new SqliteTokenMiserStorage<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(profileDb);
      Object.assign(registry, { tokenMiserStore: new PersistedTokenMiserStore(legacy, { storage }) });
      registry.scheduleTokenMiserLegacyCleanup();
      expect(await fs.readFile(payload, "utf8")).toBe("legacy raw output");
      if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: profileDb.raw, dbPath: profileDb.raw.name });
      const { writes } = await measureSqliteWrites(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        await registryModules(registry).threadUsageLedger.drainTokenMiserLedgerWork();
      });
      await expect(fs.stat(payload)).rejects.toMatchObject({ code: "ENOENT" });
      expect(storage.readMetadata(gate.objectId)).toMatchObject({ objectId: gate.objectId });
      expectSqliteWriteBudget({ scenario: "token-miser-background-legacy-cleanup", writes,
        note: "One delayed upgrade pass imports one retained gate and marks the migration complete after removing its raw payload." });
    } finally {
      vi.useRealTimers();
      try { await registry.close(); } finally {
        disposeDesktopSettingsService();
        disposeAppState();
      }
    }
  });

  afterEach(async () => {
    try {
      if (expectedCloseFailure) {
        await expect(registry.close()).rejects.toThrow(expectedCloseFailure);
      } else {
        await registry.close();
      }
    } finally {
      stateDb.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("captures protocol commentary, excludes final answers, and seals terminal turns without writing", async () => {
    await registry.close();
    let notify!: (notification: AgentEvent["notification"]) => Promise<void>;
    registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: (callback: typeof notify) => { notify = callback; return () => {}; },
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
    });
    const file = path.join(directory, "diagnostics", "instance.jsonl");
    const capture = new TokenMiserDiagnostics({ filePath: file, isEnabled: () => true, sampleEvery: 1 });
    Object.assign(registry, { tokenMiserDiagnostics: capture });
    const entry = { ...metadata(randomUUID(), "helper"), disposition: "summarized" as const };
    capture.recordGate({ metadata: entry, before: diagnosticExcerpt("original", 100), delivered: diagnosticExcerpt("summary", 100), summary: entry.summary });
    for (const phase of ["commentary", "final"] as const) {
      await notify({ method: "item/completed", params: {
        threadId: entry.threadId, turnId: entry.turnId,
        item: { type: "agentMessage", id: phase, text: phase === "commentary" ? "Need exact files" : "Private final answer", phase },
      } });
    }
    await notify({ method: "turn/completed", params: {
      threadId: entry.threadId, turnId: entry.turnId, turn: { id: entry.turnId, status: "completed", output: [] },
    } });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await registry.close();
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("Need exact files");
    expect(text).not.toContain("Private final answer");
    expect(JSON.parse(text.trim()).window.reason).toBe("turn_end");
  });

  it("drains late diagnostic observations after their producers close", async () => {
    const file = path.join(directory, "diagnostics", "shutdown.jsonl");
    const capture = new TokenMiserDiagnostics({ filePath: file, isEnabled: () => true });
    Object.assign(registry, { tokenMiserDiagnostics: capture });
    const internals = registry as unknown as { codexClient: { close(): Promise<void> } };
    vi.spyOn(internals.codexClient, "close").mockImplementation(async () => {
      const entry = { ...metadata(randomUUID(), "helper"), disposition: "summarized" as const };
      capture.recordGate({ metadata: entry, before: diagnosticExcerpt("late original", 100), delivered: diagnosticExcerpt("summary", 100), summary: entry.summary });
    });
    await registry.close();
    expect(await fs.readFile(file, "utf8")).toContain("late original");
  });

  it.skipIf(process.platform === "win32")("accounts for delivered captures once and nets their Helper charges when a gate is priced", async () => {
    const outputs = new TokenMiserStore(directory);
    Object.assign(registry, { tokenMiserStore: outputs });
    const { boundedCommandCapture: capture } = registry as unknown as { boundedCommandCapture: BoundedCommandCapture };
    Object.assign(capture, { approve: async () => true, eligible: async () => true, resolveHelper: () => ({
      identity: "fixture", label: "Fixture Helper", enrich: async () => "The fixture printed repeated warnings.",
    }) });
    const ledger = registryModules(registry).threadUsageLedger;
    const threadId = "thread-parent";
    const turnId = "turn-parent";
    const model = "gpt-6-astra";
    const read = async (backend: "codex" | "claude") => (await ledger.withTokenMiserAccounting({ backend, threadId,
      accounting: await store.readThreadToolAccounting({ backend, threadId }),
    })).tokenMiser;
    const original = "warning: fixture 💡\n".repeat(850);
    await fs.writeFile(path.join(directory, "fixture.test.cjs"), `process.stdout.write(${JSON.stringify(original)});`);
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: outputs.stateDb.raw, dbPath: outputs.stateDb.raw.name });
    const readPage = async (backend: "codex" | "claude") => (await store.readThreadPricingPage({
      backend, threadId, offset: 0, limit: 10, overlay: ledger.pricingPageOverlay(threadId, backend),
    }))?.savings?.summary;
    for (const backend of ["codex", "claude"] as const) {
      const owner = { backend, threadId, turnId };
      const issued = await capture.prepare(owner, "node --test fixture.test.cjs");
      const receipt = execFileSync("/bin/sh", ["-c", issued.command], { cwd: directory, encoding: "utf8" });
      capture.observe(owner, { id: "native", command: issued.command, completed: true, output: receipt });
      const { totalBytes } = await capture.readBytes(owner, issued.objectId, 0);
      expect((await read(backend))?.interceptions ?? []).toEqual([]);
      const [tool] = boundedCommandTools(capture, backend === "codex" ? outputs : undefined);
      const { result: digest, writes } = await measureSqliteWrites(async () => {
        const result = await tool!.dispatch({ objectId: issued.objectId }, {
          ...owner, transport: backend === "codex" ? "codex_dynamic_tool" : "mcp",
        });
        if (!result.ok) throw new Error(result.message);
        if (backend === "codex") {
          const item = result.contentItems?.[0];
          if (item?.type !== "inputText") throw new Error("Missing capture receipt.");
          await outputs.confirmModelVisibleRetrievals({ threadId, output: item.text });
        }
        return result.data;
      });
      expectSqliteWriteBudget({ scenario: "bounded-command-delivery", writes,
        note: "The first digest delivery stores one capture's byte counts and native item identity." });
      expect(digest).toContain("The fixture printed repeated warnings.");
      const repeat = await measureSqliteWrites(() => capture.inspect(owner, issued.objectId));
      expect(repeat.result).toBe(digest);
      expect(repeat.writes.commits).toBe(0);
      expect(await read(backend)).toMatchObject({
        originalCharacters: totalBytes,
        estimatedParentTokensSaved: Math.ceil(totalBytes / 4) - Math.ceil(Buffer.byteLength(String(digest)) / 4),
        interceptions: [expect.objectContaining({ objectId: issued.objectId, originalCharacters: totalBytes,
          replacementCharacters: Buffer.byteLength(String(digest)) })],
      });
      expect((await read(backend))?.savings).toBeUndefined();
      const page = await readPage(backend);
      expect(page?.avoidedParentTokens).toBe((await read(backend))?.estimatedParentTokensSaved);
      expect(page?.terms).toBeUndefined();
    }

    const gate = { ...metadata("gate-1", "gate-helper"), parentModel: model };
    const metadataStorage = new SqliteTokenMiserStorage(outputs.stateDb);
    metadataStorage.writeMetadata(gate);
    const before = (await read("codex"))!.savings!;
    await store.upsertThreadUsageLine({ line: {
      backend: "codex", threadId, turnId, model, source: "live", scope: "turn", status: "finalized",
      usageLineId: "parent-turn", createdAt: Date.now(), provider: "openai", priceStatus: "unpriced", currency: "USD",
      inputTokens: 10_000, uncachedInputTokens: 10_000, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0,
      totalTokens: 10_100, uncachedInputCostMicros: 0, cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
    } });
    await ledger.recordTokenMiserHelperInference({ threadId, turnId, inferenceId: "capture-helper", usage: {
      status: "ok", object: {}, model: "gpt-6-luna", tokenUsage: { inputTokens: 4600, outputTokens: 100, totalTokens: 4700 },
    } }, "codex");
    const decision = buildOpenAIDecisionsUsageLine({
      caller: { backend: "codex", threadId }, decisionId: "system-token-miser-capture", version: 1,
      attempt: { requestId: "fixture", usage: { input_tokens: 3840, cached_tokens: 0, output_tokens: 64 } },
      accountKey: "fixture", now: Date.now(), fallbackId: "fallback",
    });
    expect(decision.priceStatus).toBe("priced");
    await store.upsertThreadUsageLine({ line: decision });
    const pricing = await store.readThreadPricing({ backend: "codex", threadId });
    const charge = pricing.lines.find((line) => line.sourceItemId === "system:token-miser-capture:capture-helper")!.totalCostMicros
      + decision.totalCostMicros;
    expect(charge).toBeGreaterThan(0);
    const after = (await read("codex"))!;
    const captureRow = after.interceptions!.find((row) => row.boundedCapture)!;
    const price = (uncachedInputTokens: number) => estimateTokenUsageCost({
      at: captureRow.createdAt, model, uncachedInputTokens, cachedInputTokens: 0, outputTokens: 0,
    })!.uncachedInputCostMicros;
    const baseline = price(captureRow.baselineParentTokens);
    const delivery = price(captureRow.replacementTokens);
    const terms = { withoutGateCostMicros: before.withoutGateCostMicros + baseline,
      revealedCostMicros: before.revealedCostMicros + delivery, gateCostMicros: before.gateCostMicros + charge,
      savingsMicros: before.savingsMicros + baseline - delivery - charge };
    expect(after.savings).toMatchObject({ gateCount: 1, pricedGateCount: 1, ...terms });
    expect(await readPage("codex")).toMatchObject({ decisionCount: 1, boundedCaptureCount: 1, terms });
    outputs.recordBoundedCommandDelivery({ caller: { backend: "codex", threadId, turnId }, objectId: captureRow.objectId,
      itemId: captureRow.toolUseId, originalBytes: captureRow.originalCharacters, deliveredBytes: 800, kind: "excerpt" });
    const retrievedCost = price(captureRow.replacementTokens + 200) - delivery;
    const withRead = { ...terms, revealedCostMicros: terms.revealedCostMicros + retrievedCost,
      savingsMicros: terms.savingsMicros - retrievedCost };
    expect((await read("codex"))?.savings).toMatchObject(withRead);
    expect((await readPage("codex"))?.terms).toEqual(withRead);

    await ledger.recordTokenMiserHelperInference({ threadId, turnId, inferenceId: "unpriced", usage: {
      status: "ok", object: {}, model: "unknown-fixture-model",
      tokenUsage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    } }, "codex");
    const unpriced = await read("codex");
    expect(unpriced).toMatchObject({ suppressSavings: true });
    expect((await readPage("codex"))?.terms).toBeUndefined();
    expect(buildTokenMiserSavingsSummary({ accounting: unpriced, gateTotals: {
      gateCount: 1, pricedCount: 1, decisionSourceCount: 1, helperCount: 1, dispositionCount: 1,
      passedThroughCount: 0, summarizedCount: 1, avoidedParentTokens: 5_000, terms,
    } })?.terms).toBeUndefined();
    metadataStorage.removeMetadata(gate.objectId);
    expect((await read("codex"))?.savings).toBeUndefined();
    expect((await readPage("codex"))?.terms).toBeUndefined();
  });

  it.skipIf(process.platform === "win32").each(["emitted", "discarded", "truncated"] as const)(
    "credits only the bytes of a Codex digest that survive when %s", async (outcome) => {
      const outputs = new TokenMiserStore(directory);
      Object.assign(registry, { tokenMiserStore: outputs });
      const { boundedCommandCapture: capture } = registry as unknown as { boundedCommandCapture: BoundedCommandCapture };
      Object.assign(capture, { approve: async () => true, eligible: async () => true });
      const owner = { backend: "codex", threadId: "parent", turnId: "turn", transport: "codex_dynamic_tool" } as const;
      const warning = "warning 💡\n";
      const count = 5500;
      await fs.writeFile(path.join(directory, "fixture.test.cjs"),
        `process.stdout.write(${JSON.stringify(warning)}.repeat(${count}));`);
      const issued = await capture.prepare(owner, "node --test fixture.test.cjs");
      const receipt = execFileSync("/bin/sh", ["-c", issued.command], { cwd: directory, encoding: "utf8" });
      capture.observe(owner, { id: "native", command: issued.command, completed: true, output: receipt });
      const [tool] = boundedCommandTools(capture, outputs);
      const result = await tool!.dispatch({ objectId: issued.objectId }, owner);
      expect(result.ok).toBe(true);
      expect(await outputs.listMetadata(owner.threadId)).toEqual([]);
      const wrapped = result.contentItems![0]!;
      if (wrapped.type !== "inputText") throw new Error("Expected the Code Mode receipt");
      const padding = ".".repeat(512);
      const output = outcome === "discarded" ? padding : outcome === "truncated" ? padding + wrapped.text + padding : wrapped.text;
      await outputs.confirmModelVisibleRetrievals({ threadId: owner.threadId, output, maxVisibleBytes: 256 });
      const rows = await outputs.listMetadata(owner.threadId);
      if (outcome === "emitted") {
        expect(rows).toEqual([expect.objectContaining({
          originalCharacters: expect.any(Number), baselineParentTokens: 64, replacementCharacters: expect.any(Number),
        })]);
        expect(rows[0]!.originalCharacters).toBeGreaterThan(Buffer.byteLength(warning) * count);
        expect(rows[0]!.replacementCharacters).toBeGreaterThan(0);
        expect(rows[0]!.replacementCharacters).toBeLessThan(Buffer.byteLength(String(result.ok && result.data)));
      } else {
        expect(rows).toEqual([]);
      }
    },
  );

  it("returns Claude capture evidence and pricing for the Savings Explorer request", async () => {
    const outputs = new TokenMiserStore(directory);
    Object.assign(registry, { tokenMiserStore: outputs });
    const target = { backend: "claude", threadId: "claude-parent" } as const;
    const { claudeBackend } = registry as unknown as { claudeBackend: ClaudeBackend };
    vi.spyOn(claudeBackend, "readThread").mockResolvedValue({
      entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
    });
    outputs.recordBoundedCommandDelivery({ caller: { ...target, turnId: "turn" }, objectId: "o1",
      itemId: "native", originalBytes: 1600, deliveredBytes: 100 });
    const explorer = await registry.readThread({ ...target, includeAllToolInvocations: true, viewOnly: true });
    expect(explorer.toolAccounting?.tokenMiser).toMatchObject({ estimatedParentTokensSaved: 375 });
    expect(explorer.pricing?.lines).toEqual([]);
    const evaluation = await registry.readThread({ ...target, includeAccounting: true, viewOnly: true });
    expect(evaluation.toolAccounting?.tokenMiser).toEqual(explorer.toolAccounting?.tokenMiser);
  });

  it("preserves raw capture size and caps the counterfactual Codex result", async () => {
    const outputs = new TokenMiserStore(directory);
    outputs.recordBoundedCommandDelivery({ caller: { backend: "codex", threadId: "parent", turnId: "turn" },
      objectId: "o1", itemId: "native", originalBytes: 2_000_000, deliveredBytes: 400 });
    expect((await outputs.listMetadata("parent"))[0]).toMatchObject({
      originalCharacters: 2_000_000, baselineParentTokens: 10_000,
    });
    const storage = new SqliteTokenMiserStorage<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(outputs.stateDb);
    storage.writeMetadata({ ...storage.readMetadata("o1")!, baselineParentTokens: 500_000 });
    expect((await outputs.listMetadata("parent"))[0]).toMatchObject({
      originalCharacters: 2_000_000, baselineParentTokens: 10_000,
    });
  });

  it("deducts confirmed capture retrievals without committing each page", async () => {
    const outputs = new TokenMiserStore(directory);
    const caller = { backend: "claude", threadId: "parent", turnId: "turn" } as const;
    const delivery = { caller, objectId: "o1", itemId: "native", originalBytes: 100_000, deliveredBytes: 400 };
    outputs.recordBoundedCommandDelivery(delivery);
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: outputs.stateDb.raw, dbPath: outputs.stateDb.raw.name });
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 8; index++) {
        outputs.recordBoundedCommandDelivery({ ...delivery, kind: "excerpt", deliveredBytes: 160 });
      }
    });
    expect((await outputs.listMetadata(caller.threadId))[0]).toMatchObject({
      replacementCharacters: 400, retrievedCharacters: 1280,
    });
    expect(writes.commits).toBe(0);
    const flushed = await measureSqliteWrites(async () => outputs.flushBoundedCommandReads(caller.threadId, caller));
    expectSqliteWriteBudget({ scenario: "bounded-command-retrieval-batch", writes: flushed.writes,
      note: "One turn-end transaction persists confirmed exact-output retrieval bytes from eight pages." });
    expect((await new TokenMiserStore(directory).listMetadata(caller.threadId))[0]?.retrievedCharacters).toBe(1280);
    expect((await measureSqliteWrites(async () => outputs.flushBoundedCommandReads(caller.threadId, caller))).writes.commits).toBe(0);
  });

  it("attributes focused inference once to its requesting thread, including discarded answers, and subtracts it from savings", async () => {
    // This measured path needs a real WAL; the other ledger tests use RAM.
    // The usage ledger reads the store the registry was built with.
    await registry.close();
    stateDb.close();
    stateDb = StateDb.open(path.join(directory, "focused-usage.db"));
    store = new SqliteOverlayStore(stateDb);
    registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
    });
    // Its startup repairs and legacy moves write to this database; let them
    // settle so the budget measures only the focused inference.
    const startup = registry as unknown as { subAgentStartupReconciliation: Promise<void>; usageTurnStartupRepair: Promise<void> };
    await Promise.all([startup.subAgentStartupReconciliation, startup.usageTurnStartupRepair]);
    const internals = registryModules(registry).threadUsageLedger as unknown as {
      recordTokenMiserHelperInference: (request: Parameters<NonNullable<TokenMiserServiceOptions["onFocusedInference"]>>[0], captureBackend?: "claude") => Promise<void>;
      buildTokenMiserThreadSavings(params: { backend: "codex"; threadId: string; entries: TokenMiserObjectMetadata[]; replays: ReturnType<typeof indexTokenMiserCachedReplays> }): Promise<{ gateCostMicros: number; savingsMicros: number }>;
    };
    const tokenMiserStore = new TokenMiserStore(path.join(directory, "focused-store"));
    Object.assign(registry, { tokenMiserStore });
    const entry = { ...metadata(randomUUID(), "gate-helper"), parentModel: "gpt-6-astra" };
    const savingsParams = { backend: "codex" as const, threadId: "thread-parent", entries: [entry], replays: indexTokenMiserCachedReplays([]) };
    const before = await internals.buildTokenMiserThreadSavings(savingsParams);
    const params = {
      threadId: "thread-parent", turnId: "turn-parent", inferenceId: "focused-inference",
      usage: { status: "ok" as const, object: { invalid: "discarded answer" }, model: "gpt-6-luna",
        helperThreadId: "focused-helper", helperTurnId: "focused-turn",
        tokenUsage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 } },
    };
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: stateDb.raw, dbPath: stateDb.raw.name });
    const { writes } = await measureSqliteWrites(() => internals.recordTokenMiserHelperInference(params));
    expectSqliteWriteBudget({ scenario: "token-miser-focused-inference", note: "One actual focused helper inference writes one parent-attributed usage line, independent of answer delivery.", writes });
    await internals.recordTokenMiserHelperInference(params);
    const pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-parent" });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({ parentThreadId: "thread-parent", threadId: "focused-helper", model: "gpt-6-luna", inputTokens: 2000, outputTokens: 100 });
    expect(pricing.lines[0]!.totalCostMicros).toBeGreaterThan(0);
    const after = await internals.buildTokenMiserThreadSavings(savingsParams);
    expect(after.gateCostMicros - before.gateCostMicros).toBe(pricing.lines[0]!.totalCostMicros);
    expect(before.savingsMicros - after.savingsMicros).toBe(pricing.lines[0]!.totalCostMicros);
    expect((await store.readThreadPricing({ backend: "codex", threadId: "unrelated" })).lines).toHaveLength(0);
    const helper = boundedCommandHelper({
      resolveTokenMiserGate: () => "none", resolveTokenMiserSummarizer: () => "configured",
      resolveHelperModelSettings: () => ({ helpers: { token_miser_capture_claude: { backend: "codex", model: "gpt-6-luna" } } }),
      resolveDecisionModelSettings: () => ({}), resolveDecisionApiKey: async () => undefined,
    }, { generateStructuredObject: async () => ({ ...params.usage, accountKey: "fixture-account", object: { summary: "footer changed" } }) },
    (usage) => internals.recordTokenMiserHelperInference({ ...params, usage, inferenceId: "bounded" }, "claude"),
    { origin: "claude", threadId: "thread-parent", claude: {} });
    const charged = await measureSqliteWrites(() => helper!.enrich(capturedEvidence, new AbortController().signal));
    expect(charged.result).toContain("footer changed");
    expectSqliteWriteBudget({ scenario: "bounded-command-codex-helper-usage", writes: charged.writes,
      note: "One Codex summarizer inference writes one usage line to its invoking Claude thread." });
    const capturePricing = await store.readThreadPricing({ backend: "claude", threadId: "thread-parent" });
    expect(capturePricing.lines).toHaveLength(1);
    expect(capturePricing.lines[0]).toMatchObject({ accountKey: "fixture-account", model: "gpt-6-luna", inputTokens: 2000,
      backend: "claude", parentThreadId: "thread-parent", sourceItemId: "system:token-miser-capture:bounded" });
    await internals.recordTokenMiserHelperInference({ ...params, inferenceId: "unpriced-inference", usage: { ...params.usage, model: "unknown-fixture-model" } });
    expect(await internals.buildTokenMiserThreadSavings(savingsParams)).toBeNull();
  });

  it.each(["claude", "acp:grok", "openai"] as const)("charges %s capture usage to the executing account on the calling thread", async (target) => {
    await registry.close();
    stateDb.close();
    stateDb = StateDb.open(path.join(directory, "capture-usage.db"));
    store = new SqliteOverlayStore(stateDb);
    let grokEnabled = true;
    const group = "helper account at dispatch";
    let currentGroup = group;
    const model = target === "acp:grok" ? "grok-4.7" : "uncatalogued-claude";
    registry = createDesktopBackendRegistry({
      codexClient: { close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [], onNotification: () => () => {}, onPendingRequest: () => () => {} } as never,
      overlayStore: store, resolveAcpHelperWorkspace: async () => directory,
      isAcpAgentEnabled: (id) => id !== "grok" || grokEnabled,
      resolveUsageAccountGroups: () => ({ [target]: currentGroup, codex: "parent account" }),
    });
    const internals = registry as unknown as {
      resolveBoundedCommandHelper(caller: BoundedCommandCaller): BoundedCommandHelper | undefined;
      subAgentStartupReconciliation: Promise<void>; usageTurnStartupRepair: Promise<void>;
    };
    await Promise.all([internals.subAgentStartupReconciliation, internals.usageTurnStartupRepair]);
    const caller = { backend: "codex" as const, threadId: "calling-thread", turnId: "parent-turn" };
    const apiKey = "synthetic-decisions-key";
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("openaiDecisionsApiKey", apiKey);
    const service = new DesktopSettingsService({ configPath: path.join(directory, "config.toml"), env: {}, secretStore });
    await service.writeConfigPatchTargeted({
      experimental: { tokenMiserGate: target === "openai" ? "openai" : "none", tokenMiserSummarizer: target === "openai" ? "off" : "configured" },
      models: { helperModels: { helpers: target === "openai" ? {} : { token_miser_capture_codex: { backend: target, model } } } },
    });
    const settings = vi.spyOn(settingsOwner, "getDesktopSettingsService").mockReturnValue(service);
    const claude = vi.spyOn(ClaudeBackend.prototype, "summarizeCapture").mockImplementation(async () => {
      currentGroup = "account after dispatch";
      return { status: "failed", model, reason: "error_max_turns", helperThreadId: "sdk-run",
        tokenUsage: { last: { inputTokens: 17, outputTokens: 2, totalTokens: 19 }, claudeCostUSD: 0.021 } };
    });
    const grok = vi.spyOn(AcpBackendAdapter.prototype, "runEphemeralPrompt").mockResolvedValue({
      refusedRequests: 0, text: '{"summary":"footer changed"}', model, tokenUsage: { inputTokens: 17, totalTokens: 19, outputTokens: 2 },
    });
    const metered = { model: OPENAI_DECISIONS_MODEL, usage: { input_tokens: 17, output_tokens: 2, cached_tokens: 3 } };
    const http = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ...metered, error: { code: "server_is_overloaded" } },
        { status: 503, headers: { "retry-after": "0", "x-request-id": "retry" } }))
      .mockResolvedValueOnce(Response.json({ ...metered, answers: [] }, { headers: { "x-request-id": "final" } }));
    try {
      const helper = internals.resolveBoundedCommandHelper(caller)!;
      const select = () => helper.enrich(capturedEvidence, new AbortController().signal);
      if (target === "acp:grok") {
        grokEnabled = false;
        expect(internals.resolveBoundedCommandHelper(caller)).toBeUndefined();
        expect(await select()).toBeUndefined();
        grokEnabled = true;
        const host = ownerHost.getOwnerHostServices();
        const hostGate = vi.spyOn(ownerHost, "getOwnerHostServices").mockReturnValue({
          ...host, runtimePolicy: { enabledBackends: ["codex"], memberRole: "full", executionModes: [],
            approvals: "ask", sandboxByMode: {}, codexProtectedRoots: [], codexReadOnlyRoots: [] },
        });
        try {
          expect(internals.resolveBoundedCommandHelper(caller)).toBeUndefined();
          expect(await select()).toBeUndefined();
        } finally { hostGate.mockRestore(); }
        expect(grok).not.toHaveBeenCalled();
      }
      if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: stateDb.raw, dbPath: stateDb.raw.name });
      const { result, writes } = await measureSqliteWrites(select);
      const { lines } = await store.readThreadPricing(caller);
      expect(result).toBe(target === "acp:grok" ? "Summary: footer changed" : undefined);
      if (target === "openai") {
        expect(http).toHaveBeenCalledTimes(1);
        const safetyId = createHash("sha256").update(openAIDecisionSafetyMaterial({
          profileId: resolveActiveProfileName(), backend: caller.backend, threadId: caller.threadId,
        })).digest("hex");
        expect(JSON.parse(String(http.mock.calls[0]![1]?.body)).safety_identifier).toBe(safetyId);
        expect(lines.map(line => line.sourceItemId).sort()).toEqual(["system-token-miser-capture:1:retry"]);
        for (const line of lines) expect(line).toMatchObject({ accountKey: codexModelProviderAccountKey(OPENAI_DECISIONS_ORIGIN, apiKey),
          parentThreadId: caller.threadId, provider: "openai_decisions", pricingBasis: "decisions-output-uncharged",
          priceStatus: "priced", inputTokens: 17, cachedInputTokens: 3, outputTokens: 2, outputCostMicros: 0 });
      } else {
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ accountKey: usageAccountKey(undefined, group), parentThreadId: caller.threadId,
          model, inputTokens: 17, outputTokens: 2, priceStatus: "priced" });
        if (target === "claude") expect(lines[0]).toMatchObject({ totalCostMicros: 21000, pricingBasis: "provider-reported" });
      }
      expectSqliteWriteBudget({ scenario: `bounded-command-${target === "acp:grok" ? "grok" : target}-capture-usage`,
        writes, note: target === "openai" ? "One billed gate request is recorded even when the provider fails."
          : "One capture inference writes one usage line on its parent thread using the executing account." });
      if (target === "claude") {
        await service.writeConfigPatchTargeted({ experimental: { tokenMiserGate: "openai" } });
        http.mockReset().mockResolvedValueOnce(Response.json({ ...metered, answers: [
          { type: "predicate", name: "miss", probability: 0 }, { type: "predicate", name: "summary", probability: 1 },
          { type: "score", name: "noise", score: 1 },
        ] }, { headers: { "x-request-id": "combined" } }));
        const parent = { ...caller, threadId: "two-stage-parent" };
        const combined = internals.resolveBoundedCommandHelper(parent)!;
        const both = await measureSqliteWrites(() => combined.enrich(capturedEvidence, new AbortController().signal));
        expect(both.result).toBeUndefined(); // Claude's metered error still leaves the digest available.
        const pricing = await store.readThreadPricing(parent);
        expect(pricing.lines.map(line => line.provider).sort()).toEqual(["anthropic", "openai_decisions"]);
        expectSqliteWriteBudget({ scenario: "bounded-command-gate-and-summary", writes: both.writes,
          note: "One billed Decisions gate and one metered Claude summary write their own account-attributed usage lines." });
      }
    } finally {
      http.mockRestore();
      grok.mockRestore();
      claude.mockRestore();
      settings.mockRestore();
      await service.closeCommandDiscovery();
    }
  });

  it("releases previous originals on turn start, while completion leaves them readable", async () => {
    const tokenMiserStore = new TokenMiserStore(path.join(directory, "token-miser-objects"));
    const entry = await tokenMiserStore.store({
      ...metadata(randomUUID(), "helper-lifetime"), output: "fixture original",
    });
    Object.assign(registry, { tokenMiserStore });
    const emit = (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit.bind(registry);
    const lifecycle = (method: "turn/started" | "turn/completed", turnId: string): AgentEvent => ({
      backend: "codex",
      notification: method === "turn/started"
        ? { method, params: { threadId: entry.threadId, turn: { id: turnId, status: "inProgress" } } }
        : { method, params: { threadId: entry.threadId, turnId, turn: { id: turnId, status: "completed", output: [] } } },
    });
    await emit(lifecycle("turn/started", entry.turnId));
    await emit(lifecycle("turn/completed", entry.turnId));
    expect((await tokenMiserStore.readAll({ objectId: entry.objectId, threadId: entry.threadId }))?.text).toBe("fixture original");
    await emit(lifecycle("turn/started", "next-turn"));
    expect(await tokenMiserStore.readAll({ objectId: entry.objectId, threadId: entry.threadId })).toBeUndefined();
  });

  it.each([true, false])("migrates on historical demand and restores replay before first usage (enabled=%s)", async (enabled) => {
    const root = path.join(directory, "legacy-objects");
    await fs.mkdir(root);
    const legacy = { ...metadata(randomUUID(), "helper-legacy"), replayTrackingVersion: 2 as const };
    await fs.writeFile(path.join(root, `${legacy.objectId}.json`), JSON.stringify(legacy));
    await fs.writeFile(path.join(root, `${legacy.objectId}.txt`), "contrived private output");
    const tokenMiserStore = new TokenMiserStore(root);
    const internals = registryModules(registry).threadUsageLedger as unknown as {
      recordTokenMiserParentModelRequest(event: AgentEvent): Promise<void>;
      activeTokenMiserReplayEntries: Map<string, Map<string, unknown>>;
      withTokenMiserAccounting(params: { backend: "codex"; threadId: string; accounting: ThreadToolAccounting }): Promise<ThreadToolAccounting>;
    };
    const prepareRuntime = vi.fn();
    Object.assign(registry, {
      tokenMiserStore, resolveTokenMiserEnabledFn: () => enabled,
      prepareTokenMiserRuntime: prepareRuntime,
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const prune = tokenMiserStore.prune.bind(tokenMiserStore);
    vi.spyOn(tokenMiserStore, "prune").mockImplementation(async (options) => {
      await barrier;
      await prune(options);
    });
    const startup = registry.prepareTokenMiserRuntimeAtStartup();
    const read = internals.withTokenMiserAccounting({ backend: "codex", threadId: legacy.threadId, accounting: await store.readThreadToolAccounting({ backend: "codex", threadId: legacy.threadId }) });
    release();
    await startup;
    expect((await read).tokenMiser?.interceptionCount).toBe(1);
    expect(internals.activeTokenMiserReplayEntries.has(legacy.threadId)).toBe(false);
    expect(prepareRuntime).toHaveBeenCalledTimes(enabled ? 1 : 0);
    for (const tokens of [100, 200, 300]) await internals.recordTokenMiserParentModelRequest(parentUsageEvent(tokens));
    expect(internals.activeTokenMiserReplayEntries.get(legacy.threadId)?.has(legacy.objectId)).toBe(true);
    expect((await tokenMiserStore.readMetadata(legacy.objectId))?.cachedReplayCount).toBe(1);
    await expect(fs.stat(path.join(root, `${legacy.objectId}.txt`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts the live hook even when a legacy import cannot be read", async () => {
    const tokenMiserStore = new TokenMiserStore(path.join(directory, "legacy-objects"));
    const prune = vi.spyOn(tokenMiserStore, "prune").mockRejectedValueOnce(new Error("invalid legacy JSON"));
    const start = vi.fn(async () => {});
    Object.assign(registry, {
      tokenMiserStore, resolveTokenMiserEnabledFn: () => true,
      tokenMiserHookBridge: { start, close: async () => {} },
      tokenMiserPluginManager: { ensurePluginSource: async () => {} },
    });
    await registry.prepareTokenMiserRuntimeAtStartup();
    expect(start).toHaveBeenCalledOnce();
    const ledger = registryModules(registry).threadUsageLedger;
    await expect(ledger.prepareTokenMiserStorage()).rejects.toThrow("invalid legacy JSON");
    await expect(ledger.prepareTokenMiserStorage()).resolves.toBeUndefined();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("drains active-turn replay estimates even if another shutdown resource fails (%s)", async (failClose) => {
    const root = path.join(directory, "token-miser-objects");
    const tokenMiserStore = new TokenMiserStore(root);
    const entry = await tokenMiserStore.store({
      ...metadata(randomUUID(), "helper-shutdown"), output: "fixture output",
    });
    Object.assign(registry, { tokenMiserStore });
    for (const tokens of [100, 200]) {
      await tokenMiserStore.recordParentModelRequest({ objectId: entry.objectId, cumulativeInputTokens: tokens });
    }
    const queuedUpdate = tokenMiserStore.recordParentModelRequest({ objectId: entry.objectId, cumulativeInputTokens: 300 });
    if (failClose) {
      const internals = registry as unknown as { codexClient: { close(): Promise<void> } };
      const closeClient = vi.spyOn(internals.codexClient, "close").mockRejectedValueOnce(new Error("fixture close failure"));
      expectedCloseFailure = "codex";
      const closing = registry.close();
      await expect(closing).rejects.toThrow(expectedCloseFailure);
      expect(registry.close()).toBe(closing);
      expect(closeClient).toHaveBeenCalledOnce();
    } else {
      await registry.close();
    }
    await queuedUpdate;
    expect(await new TokenMiserStore(root).readMetadata(entry.objectId, entry.threadId)).toMatchObject({ cachedReplayCount: 1 });
  });

  it("reads thread metadata once for both accounting and savings", async () => {
    const tokenMiserStore = new TokenMiserStore(path.join(directory, "token-miser-objects"));
    for (const threadId of ["thread-parent", "thread-unrelated"]) {
      await tokenMiserStore.store({
        ...metadata(randomUUID(), `helper-${threadId}`),
        threadId,
        output: "fixture output",
        parentModel: "gpt-5.6-terra",
      });
    }
    (registry as unknown as { tokenMiserStore?: TokenMiserStore }).tokenMiserStore = tokenMiserStore;
    const listMetadata = vi.spyOn(tokenMiserStore, "listMetadata");
    const accounting = await registryModules(registry).threadUsageLedger.withTokenMiserAccounting({
      backend: "codex",
      threadId: "thread-parent",
      accounting: await store.readThreadToolAccounting({ backend: "codex", threadId: "thread-parent" }),
    });
    expect(accounting.tokenMiser?.interceptionCount).toBe(1);
    expect(accounting.tokenMiser?.savings?.gateCount).toBe(1);
    expect(listMetadata).toHaveBeenCalledExactlyOnceWith("thread-parent");
  });

  it("does not read Token Miser files when publishing accounting invalidation", async () => {
    const tokenMiserStore = new TokenMiserStore(path.join(directory, "token-miser-objects"));
    await tokenMiserStore.store({
      ...metadata(randomUUID(), "helper-notification"), output: "fixture output",
    });
    Object.assign(registry, { tokenMiserStore });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    const readFile = vi.spyOn(fs, "readFile");
    try {
      await registryModules(registry).threadUsageLedger.emitThreadToolAccountingUpdated({ backend: "codex", threadId: "thread-parent" });
      expect(events.some((event) => event.notification.method === "thread/toolAccounting/updated")).toBe(true);
      expect(readFile.mock.calls.filter(([file]) => String(file).includes("token-miser-objects"))).toEqual([]);
    } finally {
      readFile.mockRestore();
    }
  });

  it("batches gate cards and Luna usage into the parent ledgers", async () => {
    await store.upsertThreadUsageLine({
      line: {
        backend: "codex",
        cachedInputCostMicros: 0,
        cachedInputTokens: 0,
        createdAt: 1_800_000_000_000,
        currency: "USD",
        inputTokens: 10_000,
        model: "gpt-5.6-terra",
        outputCostMicros: 0,
        outputTokens: 100,
        priceStatus: "unpriced",
        provider: "openai",
        reasoningOutputTokens: 0,
        scope: "turn",
        serviceTier: "standard",
        source: "live",
        sourceItemId: "thread-token-usage",
        status: "finalized",
        threadId: "thread-parent",
        totalCostMicros: 0,
        totalTokens: 10_100,
        turnId: "turn-parent",
        uncachedInputCostMicros: 0,
        uncachedInputTokens: 10_000,
        usageLineId: "parent-turn-usage",
      },
    });
    await Promise.all([
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-1", 1),
      }),
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-2", 2),
      }),
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-3", 3),
      }),
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-4", 4),
      }),
    ]);
    const upsertSubAgents = vi.spyOn(store, "upsertThreadSubAgents");
    const upsertUsageLines = vi.spyOn(store, "upsertThreadUsageLines");
    const persist = (
      registryModules(registry).threadUsageLedger as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registryModules(registry).threadUsageLedger);

    await persist([metadata("gate-1", "helper-1"), metadata("gate-2", "helper-2")]);

    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
    const subAgents = await store.listThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(subAgents).toHaveLength(2);
    expect(subAgents[0]).toMatchObject({
      agentName: "Token Miser",
      monitorId: "system:token-miser:gate-2",
      monitorThreadId: "helper-2",
      preferredModel: "gpt-5.6-luna",
      preferredReasoningEffort: "medium",
      status: "success",
      tokenMiserAccounting: {
        baselineParentCostMicros: 12_000,
        baselineParentTokens: 6_000,
        cachedReplayCount: 1,
        cachedBaselineTokens: 6_000,
        gateCostMicros: 520,
        gateModel: "gpt-5.6-luna",
        gateTotalTokens: 2_100,
        originalModel: "gpt-5.6-terra",
        revealedParentCostMicros: 450,
        revealedParentTokens: 225,
        cachedRevealedTokens: 225,
      },
    });
    const accounting = subAgents[0]?.tokenMiserAccounting;
    expect(accounting?.cachedBaselineCostMicros).toBeGreaterThan(0);
    expect(accounting?.cachedRevealedCostMicros).toBeGreaterThan(0);
    expect(accounting?.savingsMicros).toBe(
      accounting!.baselineParentCostMicros
      + accounting!.cachedBaselineCostMicros!
      - accounting!.gateCostMicros
      - accounting!.revealedParentCostMicros
      - accounting!.cachedRevealedCostMicros!,
    );
    expect(accounting?.savingsMicros).toBeGreaterThan(11_030);
    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    const gateLines = pricing.lines.filter((line) => line.scope === "monitor");
    expect(gateLines).toHaveLength(2);
    expect(gateLines[0]).toMatchObject({
      model: "gpt-5.6-luna",
      parentThreadId: "thread-parent",
      scope: "monitor",
      sourceItemId: "system:token-miser:gate-2",
      totalTokens: 2_100,
    });

    await persist([metadata("gate-1", "helper-1"), metadata("gate-2", "helper-2")]);
    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
  });

  it("labels a deliberate pass-through as an evaluation with no claimed token savings", async () => {
    const persist = (
      registryModules(registry).threadUsageLedger as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registryModules(registry).threadUsageLedger);
    await persist([{
      ...metadata("gate-1", "helper-1"),
      disposition: "passed_through",
      replacementCharacters: 24_000,
      parentModel: "gpt-5.6-sol",
    }]);

    const subAgents = await store.listThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(subAgents[0]).toMatchObject({
      task: "Evaluate commandExecution output",
      lastMessage:
        "Passed 24,000 characters from commandExecution through unchanged after evaluation.",
      completionSource: {
        reason: "system_token_miser_pass_through",
      },
      tokenMiserAccounting: {
        disposition: "passed_through",
        baselineParentTokens: 6_000,
        revealedParentTokens: 6_000,
      },
    });
    expect(
      subAgents[0]?.tokenMiserAccounting?.savingsMicros,
    ).toBeLessThan(0);
  });

  it("prices a deterministic pass-through without inventing a Luna charge", async () => {
    const persist = (
      registryModules(registry).threadUsageLedger as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registryModules(registry).threadUsageLedger);
    const { helperUsage: _helperUsage, ...policyEntry } = metadata(
      "gate-1",
      "unused-helper",
    );
    await persist([{
      ...policyEntry,
      disposition: "passed_through",
      replacementCharacters: 24_000,
      parentModel: "gpt-5.6-sol",
    }]);

    const subAgents = await store.listThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(subAgents[0]).toMatchObject({
      task: "Pass through commandExecution output by policy",
      lastMessage:
        "Passed 24,000 characters from commandExecution through unchanged by deterministic policy.",
      tokenMiserAccounting: {
        gateModel: "policy",
        gateTotalTokens: 0,
        gateCostMicros: 0,
        revealedParentTokens: 6_000,
        savingsMicros: 0,
      },
    });
    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(pricing.lines.filter((line) => line.scope === "monitor"))
      .toHaveLength(0);
  });

  // A native review runs on the parent thread with no usage line of its own,
  // and its hook fires under an inner turn id that no line will ever carry.
  // The model stamped at creation is the only rate source such a gate has.
  // Reconcile used to compare only the accounting, so a gate whose numbers had
  // not moved was never rewritten — and a field the rail newly renders never
  // reached it. After a restart every existing gate stayed un-nested.
  it("rewrites a persisted gate when its rendered projection changes", async () => {
    const persist = (
      registryModules(registry).threadUsageLedger as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registryModules(registry).threadUsageLedger);

    // A gate persisted by an older build: same accounting, no parentTurnId.
    await store.upsertThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
      subAgents: [{
        agentName: "Token Miser",
        backend: "codex",
        createdAt: 1_800_000_000_001,
        monitorId: "system:token-miser:gate-1",
        status: "success",
        task: "Gate commandExecution output",
        updatedAt: 1_800_000_000_001,
      }],
    });
    const upsertSubAgents = vi.spyOn(store, "upsertThreadSubAgents");

    await persist([metadata("gate-1", "helper-1")]);

    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
    const subAgents = await store.listThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(subAgents[0]?.parentTurnId).toBe("turn-parent");

    // And once the projection matches, a second reconcile is a no-op.
    await persist([metadata("gate-1", "helper-1")]);
    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
  });

  it("prices a gate from its stamped parent model when no parent line exists", async () => {
    const persist = (
      registryModules(registry).threadUsageLedger as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registryModules(registry).threadUsageLedger);

    await persist([{
      ...metadata("gate-1", "helper-1"),
      parentModel: "gpt-5.6-sol",
      parentServiceTier: "standard",
      replayTrackingVersion: 2,
      turnId: "review-inner-turn-with-no-usage-line",
    }]);

    const subAgents = await store.listThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
    });
    const accounting = subAgents[0]?.tokenMiserAccounting;
    expect(accounting).toBeDefined();
    expect(accounting?.originalModel).toBe("gpt-5.6-sol");
    expect(accounting?.originalServiceTier).toBe("standard");
    // No replays were observed, so this is baseline once − revealed once −
    // summarizer: honest, small, and non-zero.
    expect(accounting?.cachedReplayCount).toBe(0);
    expect(accounting?.baselineParentCostMicros).toBeGreaterThan(0);
  });

  it("persists authoritative live gate usage once before parent completion", async () => {
    await store.upsertThreadUsageLine({
      line: {
        backend: "codex",
        cachedInputCostMicros: 0,
        cachedInputTokens: 0,
        createdAt: 1_800_000_000_000,
        currency: "USD",
        inputTokens: 10_000,
        model: "gpt-5.6-terra",
        outputCostMicros: 0,
        outputTokens: 100,
        priceStatus: "unpriced",
        provider: "openai",
        reasoningOutputTokens: 0,
        scope: "turn",
        source: "live",
        sourceItemId: "thread-token-usage",
        status: "pending",
        threadId: "thread-parent",
        totalCostMicros: 0,
        totalTokens: 10_100,
        turnId: "turn-parent",
        uncachedInputCostMicros: 0,
        uncachedInputTokens: 10_000,
        usageLineId: "parent-turn-usage",
      },
    });
    const upsertSubAgents = vi.spyOn(store, "upsertThreadSubAgents");
    const upsertUsageLines = vi.spyOn(store, "upsertThreadUsageLines");
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const internals = registryModules(registry).threadUsageLedger as unknown as {
      publishLiveTokenMiserLedgerEntry(
        entry: TokenMiserObjectMetadata,
      ): Promise<void>;
      writePendingLiveThreadUsageLines(): Promise<void>;
    };
    const publish = internals.publishLiveTokenMiserLedgerEntry.bind(internals);
    const baseLiveEntry = metadata("gate-live", "helper-live");
    const liveEntry = {
      ...baseLiveEntry,
      helperUsage: {
        ...baseLiveEntry.helperUsage,
        tokenUsage: {
          cachedInputTokens: 500,
          inputTokens: 2_000,
          outputTokens: 100,
          reasoningOutputTokens: 25,
          totalTokens: 2_100,
        },
      },
    } satisfies TokenMiserObjectMetadata;

    await publish(liveEntry);

    expect(upsertSubAgents).not.toHaveBeenCalled();
    expect(upsertUsageLines).not.toHaveBeenCalled();
    await internals.writePendingLiveThreadUsageLines();
    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
    const livePricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(
      livePricing.lines.filter((line) =>
        line.sourceItemId === "system:token-miser:gate-live"
      ),
    ).toEqual([
      expect.objectContaining({
        cachedInputTokens: 500,
        inputTokens: 2_000,
        outputTokens: 100,
        parentThreadId: "thread-parent",
        reasoningOutputTokens: 25,
        status: "finalized",
        threadId: "helper-live",
        totalTokens: 2_100,
        uncachedInputTokens: 1_500,
      }),
    ]);
    expect(livePricing.summaries).toEqual([
      expect.objectContaining({
        threadId: "thread-parent",
        usageLineCount: 2,
      }),
    ]);
    expect(await store.listThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([]);
    // The event only invalidates; readers take the live card from the registry.
    const subAgentEvent = events.find(
      (event) => event.notification.method === "thread/subAgents/updated",
    );
    expect(subAgentEvent?.notification.params).toEqual({
      navigationChanged: false,
      threadId: "thread-parent",
    });
    expect(registry.listLiveTokenMiserSubAgents("thread-parent")).toMatchObject([
      {
        agentName: "Token Miser",
        monitorId: "system:token-miser:gate-live",
        tokenMiserAccounting: {
          savingsMicros: 11_090,
        },
      },
    ]);
    const pricingEvent = events.find(
      (event) => event.notification.method === "thread/pricing/updated",
    );
    expect(pricingEvent?.notification.params).toMatchObject({
      threadId: "thread-parent",
      displayInvalidated: true,
      pricing: { lines: [], summaries: [] },
    });
    const snapshot = registry.withLiveTokenMiserNavigationSnapshot({
      backend: "all",
      directories: [],
      fetchedAt: 1,
      inboxThreadKeys: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [
        {
          id: "thread-parent",
          inbox: { inInbox: false },
          linkedDirectories: [],
          source: "codex",
          summary: "Parent",
          title: "Parent",
          titleSource: "explicit",
          updatedAt: 1,
        },
      ],
      unchanged: false,
    } satisfies NavigationSnapshot);
    expect(snapshot.threads[0]?.subAgents?.[0]?.monitorId).toBe(
      "system:token-miser:gate-live",
    );

    const retrieved = {
      ...liveEntry,
      retrievedCharacters: 4_000,
    };
    const subAgentEventsBefore = events.filter(
      (event) => event.notification.method === "thread/subAgents/updated",
    ).length;
    await publish(retrieved);
    expect(events.filter(
      (event) => event.notification.method === "thread/subAgents/updated",
    ).length).toBe(subAgentEventsBefore + 1);
    expect(registry.listLiveTokenMiserSubAgents("thread-parent")).toMatchObject([
      {
        tokenMiserAccounting: {
          revealedParentTokens: 1_225,
          savingsMicros: 9_090,
        },
      },
    ]);
    const updatedPricingEvents = events.filter(
      (event) => event.notification.method === "thread/pricing/updated",
    );
    expect(updatedPricingEvents.at(-1)?.notification.params).toMatchObject({ displayInvalidated: true });
    const updatedPricing = await registryModules(registry).threadUsageLedger.readThreadPricingWithLiveTokenMiser({
      backend: "codex", threadId: "thread-parent",
    });
    expect(updatedPricing.lines.filter((line) => line.sourceItemId === "system:token-miser:gate-live")).toHaveLength(1);

    const persist = (
      registryModules(registry).threadUsageLedger as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registryModules(registry).threadUsageLedger);
    await persist([retrieved]);
    await persist([retrieved]);

    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
    const completedPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(
      completedPricing.lines.filter((line) =>
        line.sourceItemId === "system:token-miser:gate-live"
      ),
    ).toHaveLength(1);
  });

  it("republishes live gate-card savings when cached replays accrue", async () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    const tokenMiserStore = new TokenMiserStore(
      path.join(directory, "token-miser-objects"),
    );
    const entry = await tokenMiserStore.store({
      baselineCharacters: 24_000,
      helperUsage: metadata("gate-live", "helper-live").helperUsage,
      objectId,
      output: "x".repeat(24_000),
      parentCumulativeInputTokens: 1_000,
      parentModel: "gpt-5.6-terra",
      parentServiceTier: "standard",
      replacementCharacters: 900,
      summary: {
        summary: "The command returned a large result.",
        usefulDetails: [],
      },
      threadId: "thread-parent",
      toolName: "commandExecution",
      toolUseId: "tool-live",
      turnId: "turn-parent",
    });
    (registry as unknown as { tokenMiserStore?: TokenMiserStore }).tokenMiserStore = tokenMiserStore;
    const internals = registryModules(registry).threadUsageLedger;
    internals.rememberActiveTokenMiserReplayEntry(entry);

    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const readAccounting = () =>
      registry.listLiveTokenMiserSubAgents("thread-parent")[0]
        ?.tokenMiserAccounting;
    await internals.publishLiveTokenMiserLedgerEntryInOrder(entry);
    expect(events.some(
      (event) => event.notification.method === "thread/subAgents/updated",
    )).toBe(true);
    const initialAccounting = readAccounting();
    expect(initialAccounting?.cachedReplayCount).toBe(0);
    events.length = 0;

    for (const inputTokens of [2_000, 3_000, 4_000]) {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-parent",
            turnId: "turn-parent",
            tokenUsage: {
              last: {
                inputTokens,
                cachedInputTokens: inputTokens - 100,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: inputTokens,
              },
              total: {
                inputTokens,
                cachedInputTokens: inputTokens - 100,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: inputTokens,
              },
            },
          },
        },
      });
    }

    // Each accrual republishes the card, so a reader refreshes it.
    expect(events.some(
      (event) => event.notification.method === "thread/subAgents/updated",
    )).toBe(true);
    const replayAccounting = readAccounting();
    expect(replayAccounting?.cachedReplayCount).toBe(1);
    expect(replayAccounting?.savingsMicros)
      .toBeGreaterThan(initialAccounting?.savingsMicros ?? 0);
  });

  it.each(["source", "summary"] as const)("charges the requesting round's entire cached prompt once for a %s retrieval", async (kind) => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();
    const entry = (await tokenMiserStore.readMetadata(objectId))!;
    const internals = registryModules(registry).threadUsageLedger as unknown as {
      withTokenMiserAccounting(params: { backend: "codex"; threadId: string; accounting: ThreadToolAccounting }): Promise<ThreadToolAccounting>;
      buildTokenMiserLedgerArtifact(params: { entry: TokenMiserObjectMetadata; indexes: { pricing: ReturnType<typeof indexTokenMiserPricingLines>; replays: ReturnType<typeof indexTokenMiserCachedReplays> } }): { subAgent: ThreadSubAgentSummary };
    };
    const readAccounting = async () => (await internals.withTokenMiserAccounting({
      backend: "codex", threadId: entry.threadId,
      accounting: await store.readThreadToolAccounting({ backend: "codex", threadId: entry.threadId }),
    })).tokenMiser!;
    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    const requestingRound = parentContextUsageEvent({
      cumulativeInputTokens: 203_000, cachedInputTokens: 199_000,
      inputTokens: 200_000, outputTokens: 100,
    });
    await registry.publishLocalEvent(requestingRound);
    const before = await readAccounting();
    const delivery = await tokenMiserStore.prepareRetrievalDelivery({
      objectId, threadId: entry.threadId, visibleText: "xxxx", kind,
    });
    // Preparing or privately inspecting a result does not charge the round.
    await tokenMiserStore.readSelectionSource({ objectId, threadId: entry.threadId });
    expect((await readAccounting()).savings).toEqual(before.savings);
    await tokenMiserStore.confirmModelVisibleRetrievals({ threadId: entry.threadId, output: delivery!.text });
    const after = await readAccounting();
    const overhead = estimateTokenUsageCost({
      model: entry.parentModel!, serviceTier: entry.parentServiceTier, at: entry.createdAt,
      cachedInputTokens: 199_000, uncachedInputTokens: 1, outputTokens: 0,
    })!.totalCostMicros;
    expect(before.savings!.savingsMicros - after.savings!.savingsMicros).toBe(overhead);
    expect(after.savings!.revealedCostMicros - before.savings!.revealedCostMicros).toBe(overhead);
    expect(after.cachedRevealedTokens! - before.cachedRevealedTokens!).toBe(199_000);

    // Repeated usage notifications and other gates in the same request cannot
    // bill that entire prompt again. Catalog transport is never a source read.
    await registry.publishLocalEvent(requestingRound);
    const second = await tokenMiserStore.store({
      ...entry, objectId: randomUUID(), toolUseId: "second-gate", output: "xxxx",
    });
    const catalog = await tokenMiserStore.prepareOwnerTextDelivery({ threadId: entry.threadId, turnId: entry.turnId, visibleText: "schemas" });
    await tokenMiserStore.confirmModelVisibleRetrievals({ threadId: entry.threadId, output: catalog!.text });
    const another = await tokenMiserStore.prepareRetrievalDelivery({ objectId: second.objectId, threadId: entry.threadId, visibleText: "xxxx" });
    await tokenMiserStore.confirmModelVisibleRetrievals({ threadId: entry.threadId, output: another!.text });
    expect((await tokenMiserStore.readMetadata(second.objectId))?.retrievalRequestCachedTokens ?? 0).toBe(0);
    const updated = (await tokenMiserStore.readMetadata(objectId))!;
    expect(updated.retrievalRequestCachedTokens).toBe(199_000);
    const gate = internals.buildTokenMiserLedgerArtifact({ entry: updated, indexes: { pricing: indexTokenMiserPricingLines([]), replays: indexTokenMiserCachedReplays([]) } }).subAgent.tokenMiserAccounting;
    expect(buildTokenMiserSavingsSummary({ gateAccountings: [gate] })?.terms?.savingsMicros).toBe(after.savings!.savingsMicros);
    expect((await new TokenMiserStore(path.join(directory, "token-miser-objects")).readMetadata(objectId))?.retrievalRequestCachedTokens).toBe(199_000);

    await registry.publishLocalEvent(parentContextUsageEvent({
      cumulativeInputTokens: 403_000, cachedInputTokens: 198_000,
      inputTokens: 200_000, outputTokens: 100,
    }));
    const next = await tokenMiserStore.prepareRetrievalDelivery({ objectId, threadId: entry.threadId, visibleText: "xxxx" });
    await tokenMiserStore.confirmModelVisibleRetrievals({ threadId: entry.threadId, output: next!.text });
    expect((await tokenMiserStore.readMetadata(objectId))?.retrievalRequestCachedTokens).toBe(397_000);
  });

  it.each([false, true])("uses fresh retrieval usage after all replay gates compact (previous request charged=%s)", async (previouslyCharged) => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();
    const retrieve = async () => {
      const delivery = await tokenMiserStore.prepareRetrievalDelivery({
        objectId, threadId: "thread-parent", visibleText: "xxxx",
      });
      await tokenMiserStore.confirmModelVisibleRetrievals({ threadId: "thread-parent", output: delivery!.text });
    };
    await registry.publishLocalEvent(parentContextUsageEvent({
      cumulativeInputTokens: 200_000, cachedInputTokens: 199_900,
      inputTokens: 200_000, outputTokens: 0,
    }));
    if (previouslyCharged) await retrieve();
    await registry.publishLocalEvent({
      backend: "codex", notification: { method: "item/completed", params: {
        threadId: "thread-parent", turnId: "turn-parent",
        item: { id: "compact-retrieval", type: "ContextCompaction" },
      } },
    });
    const internals = registryModules(registry).threadUsageLedger as unknown as { activeTokenMiserReplayEntries: Map<string, Map<string, unknown>> };
    expect(internals.activeTokenMiserReplayEntries.has("thread-parent")).toBe(false);
    const before = (await tokenMiserStore.readMetadata(objectId))!;
    const requestingRound = parentContextUsageEvent({
      cumulativeInputTokens: 210_000, cachedInputTokens: 9_000,
      inputTokens: 10_000, outputTokens: 0,
    });
    await registry.publishLocalEvent(requestingRound);
    await retrieve();
    await registry.publishLocalEvent(requestingRound);
    await retrieve();
    const after = (await tokenMiserStore.readMetadata(objectId))!;
    expect((after.retrievalRequestCachedTokens ?? 0) - (before.retrievalRequestCachedTokens ?? 0)).toBe(9_000);
    expect(after.cachedRevealedTokens! - before.cachedRevealedTokens!).toBe(9_000);
    expect(after.cachedReplayCount).toBe(before.cachedReplayCount);
    expect(after.parentRequestsObservedAfterGate).toBe(before.parentRequestsObservedAfterGate);
  });

  it("charges fresh reported cached usage from a session-reset request exactly once", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();
    await registry.publishLocalEvent(parentContextUsageEvent({
      cumulativeInputTokens: 1_000_000, cachedInputTokens: 190_000,
      inputTokens: 200_000, outputTokens: 0,
    }));
    const before = (await tokenMiserStore.readMetadata(objectId))!;
    const resetRound = parentContextUsageEvent({
      cumulativeInputTokens: 200_000, cachedInputTokens: 199_000,
      inputTokens: 200_000, outputTokens: 0,
    });
    await registry.publishLocalEvent(resetRound);
    for (let index = 0; index < 2; index += 1) {
      const delivery = await tokenMiserStore.prepareRetrievalDelivery({
        objectId, threadId: "thread-parent", visibleText: "xxxx",
      });
      await tokenMiserStore.confirmModelVisibleRetrievals({ threadId: "thread-parent", output: delivery!.text });
      await registry.publishLocalEvent(resetRound);
    }
    const after = (await tokenMiserStore.readMetadata(objectId))!;
    expect(after.retrievalRequestCachedTokens).toBe(199_000);
    expect(after.cachedRevealedTokens! - before.cachedRevealedTokens!).toBe(199_000);
    expect(after.parentRequestsObservedAfterGate).toBe(before.parentRequestsObservedAfterGate);
  });

  it("stops baseline and revealed replay accounting at ContextCompaction", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));
    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
      cachedBaselineTokens: 6_000,
      cachedRevealedTokens: 225,
      parentRequestsObservedAfterGate: 3,
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "compact-item-1",
            type: "ContextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });

    await registry.publishLocalEvent(parentUsageEvent(5_000));
    await registry.publishLocalEvent(parentUsageEvent(6_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
      cachedBaselineTokens: 6_000,
      cachedRevealedTokens: 225,
      parentRequestsObservedAfterGate: 3,
    });
    expect(
      (await tokenMiserStore.readMetadata(objectId))?.replayTrackingStoppedAt,
    ).toEqual(expect.any(Number));
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([
      expect.objectContaining({
        itemId: "compact-item-1",
        threadId: "thread-parent",
        turnId: "turn-parent",
      }),
    ]);
  });

  it("stops cached replay counting when a ContextCompaction item starts", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/started",
        params: {
          item: {
            id: "compact-item-started",
            type: "contextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });
    await registry.publishLocalEvent(parentUsageEvent(5_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
      parentRequestsObservedAfterGate: 3,
    });
  });

  it("infers a missing compaction boundary when live context drops", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 199_000,
      cumulativeInputTokens: 200_000,
      inputTokens: 200_000,
      outputTokens: 1_000,
    }));
    const beforeDrop = await tokenMiserStore.readMetadata(objectId);

    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 0,
      cumulativeInputTokens: 221_000,
      inputTokens: 21_000,
      outputTokens: 500,
    }));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      parentRequestsObservedAfterGate:
        beforeDrop?.parentRequestsObservedAfterGate,
      replayTrackingStoppedAt: expect.any(Number),
    });
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([
      expect.objectContaining({
        threadId: "thread-parent",
        turnId: "turn-parent",
      }),
    ]);
  });

  it("keeps counting when a hot replay has a smaller context", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 178_400,
      cumulativeInputTokens: 182_300,
      inputTokens: 182_300,
      outputTokens: 185,
    }));
    const beforeSmallerReplay = await tokenMiserStore.readMetadata(objectId);

    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 159_104,
      cumulativeInputTokens: 342_121,
      inputTokens: 159_821,
      outputTokens: 6,
    }));
    const afterSmallerReplay = await tokenMiserStore.readMetadata(objectId);

    expect(afterSmallerReplay?.parentRequestsObservedAfterGate).toBe(
      (beforeSmallerReplay?.parentRequestsObservedAfterGate ?? 0) + 1,
    );
    expect(afterSmallerReplay?.replayTrackingStoppedAt).toBeUndefined();
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([]);
  });

  it("does not infer a second marker for an already reported compaction", async () => {
    await startLiveReplayGate();
    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 199_000,
      cumulativeInputTokens: 200_000,
      inputTokens: 200_000,
      outputTokens: 1_000,
    }));
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "compact-item-before-drop",
            type: "ContextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });

    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 0,
      cumulativeInputTokens: 221_000,
      inputTokens: 21_000,
      outputTokens: 500,
    }));

    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([
      expect.objectContaining({ itemId: "compact-item-before-drop" }),
    ]);
  });

  it("does infer a new boundary past an older unattributed marker", async () => {
    await startLiveReplayGate();
    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 199_000,
      cumulativeInputTokens: 200_000,
      inputTokens: 200_000,
      outputTokens: 1_000,
    }));
    // The fixture is older even when both SQLite operations share a millisecond.
    const staleObservedAt = Date.now() - 1;
    await store.recordThreadCompaction({
      compaction: {
        backend: "codex",
        compactionId: "stale-unattributed-marker",
        observedAt: staleObservedAt,
        threadId: "thread-parent",
        turnId: "turn-old",
        updatedAt: staleObservedAt,
      },
    });
    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 209_000,
      cumulativeInputTokens: 410_000,
      inputTokens: 210_000,
      outputTokens: 1_000,
    }));

    await registry.publishLocalEvent(parentContextUsageEvent({
      cachedInputTokens: 0,
      cumulativeInputTokens: 431_000,
      inputTokens: 21_000,
      outputTokens: 500,
    }));

    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([
      expect.objectContaining({ compactionId: "stale-unattributed-marker" }),
      expect.objectContaining({ turnId: "turn-parent" }),
    ]);
  });

  it("does not treat a non-compaction item as a replay boundary", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "command-1",
            type: "CommandExecution",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });
    await registry.publishLocalEvent(parentUsageEvent(5_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 2,
      parentRequestsObservedAfterGate: 4,
    });
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([]);
  });

  it("records one marker when ContextCompaction and thread/compacted share an item id", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "compact-item-shared",
            type: "ContextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/compacted",
        params: {
          itemId: "compact-item-shared",
          threadId: "thread-parent",
        },
      },
    });
    await registry.publishLocalEvent(parentUsageEvent(5_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
    });
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toHaveLength(1);
  });

  it("records one marker when thread/compacted omits the ContextCompaction item id", async () => {
    await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "compact-item-with-optional-id",
            type: "ContextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/compacted",
        params: {
          threadId: "thread-parent",
        },
      },
    });

    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([
      expect.objectContaining({
        itemId: "compact-item-with-optional-id",
      }),
    ]);
  });

  async function startLiveReplayGate(): Promise<{
    objectId: string;
    tokenMiserStore: TokenMiserStore;
  }> {
    const objectId = "22222222-2222-4222-8222-222222222222";
    const tokenMiserStore = new TokenMiserStore(
      path.join(directory, "token-miser-objects"),
      {
        // Match the production store callback: stopped gates leave the active
        // replay set, even while their original outputs remain retrievable.
        onMetadataUpdated: (entry) => {
          registryModules(registry).threadUsageLedger.rememberActiveTokenMiserReplayEntry(entry);
        },
      },
    );
    const entry = await tokenMiserStore.store({
      baselineCharacters: 24_000,
      helperUsage: metadata("gate-live", "helper-live").helperUsage,
      objectId,
      output: "x".repeat(24_000),
      parentCumulativeInputTokens: 1_000,
      parentModel: "gpt-5.6-terra",
      parentServiceTier: "standard",
      replacementCharacters: 900,
      summary: {
        summary: "The command returned a large result.",
        usefulDetails: [],
      },
      threadId: "thread-parent",
      toolName: "commandExecution",
      toolUseId: "tool-live",
      turnId: "turn-parent",
    });
    (registry as unknown as { tokenMiserStore?: TokenMiserStore }).tokenMiserStore = tokenMiserStore;
    registryModules(registry).threadUsageLedger.rememberActiveTokenMiserReplayEntry(entry);
    return { objectId, tokenMiserStore };
  }
});

function parentUsageEvent(inputTokens: number): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-parent",
        turnId: "turn-parent",
        tokenUsage: {
          last: {
            cachedInputTokens: inputTokens - 100,
            inputTokens,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: inputTokens,
          },
          total: {
            cachedInputTokens: inputTokens - 100,
            inputTokens,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: inputTokens,
          },
        },
      },
    },
  };
}

function parentContextUsageEvent(params: {
  cachedInputTokens: number;
  cumulativeInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-parent",
        turnId: "turn-parent",
        tokenUsage: {
          last: {
            cachedInputTokens: params.cachedInputTokens,
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            reasoningOutputTokens: 0,
            totalTokens: params.inputTokens + params.outputTokens,
          },
          modelContextWindow: 258_400,
          total: {
            cachedInputTokens: params.cachedInputTokens,
            inputTokens: params.cumulativeInputTokens,
            outputTokens: params.outputTokens,
            reasoningOutputTokens: 0,
            totalTokens: params.cumulativeInputTokens + params.outputTokens,
          },
        },
      },
    },
  };
}

function metadata(
  objectId: string,
  helperThreadId: string,
): TokenMiserObjectMetadata {
  const ordinal = objectId === "gate-1" ? 1 : 2;
  return {
    version: 1,
    objectId,
    threadId: "thread-parent",
    turnId: "turn-parent",
    toolUseId: `tool-${ordinal}`,
    toolName: "commandExecution",
    createdAt: 1_800_000_000_000 + ordinal,
    originalCharacters: 24_000,
    baselineParentTokens: 6_000,
    replacementCharacters: 900,
    retrievedCharacters: 0,
    summary: {
      summary: "The command returned a large result.",
      usefulDetails: [],
      suggestedNextStep: "Read a targeted line range.",
    },
    helperUsage: {
      helperThreadId,
      helperTurnId: `helper-turn-${ordinal}`,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: {
        inputTokens: 2_000,
        outputTokens: 100,
        totalTokens: 2_100,
      },
    },
  };
}

function toolInvocation(
  itemId: string,
  ordinal: number,
): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    threadId: "thread-parent",
    turnId: "turn-parent",
    itemId,
    invocationId: `invocation-${ordinal}`,
    toolName: "commandExecution",
    category: "search",
    status: "completed",
    observedAt: 1_800_000_000_000 + ordinal,
    updatedAt: 1_800_000_000_000 + ordinal,
    outputChars: 1_000,
    outputLines: 10,
    estimatedOutputTokens: 250,
    warningLines: 0,
    errorLines: 0,
    infoLines: 0,
    debugLines: 0,
    outputTruncated: false,
    noisy: false,
  };
}
