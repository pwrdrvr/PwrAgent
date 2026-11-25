import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseAccountTokenUsageObservation,
  parseAccountTokenUsagePayload,
  type AccountTokenUsageObservation,
} from "@pwragent/shared/contracts/usage-activity";
import { FEDERATION_BACKEND_METHODS, FEDERATION_BACKEND_METHOD_CAPABILITIES } from "@pwragent/federation/federation-backend-methods";
import { FederationRouter } from "@pwragent/federation/federation-router";
import { FederationRpcEndpoint } from "@pwragent/federation/federation-rpc";
import {
  classifyAccountTokenUsageError,
  readCodexAccountTokenUsage,
} from "../app-server/codex-account-token-usage";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import {
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { codexRequestCountsAsActivity } from "../codex-app-server/request-activity";
import { usageAccountKey } from "../usage-account-identity";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { StateDb } from "../state/state-db";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseAccountTokenUsagePayload and parseAccountTokenUsageObservation", () => {
  it("parses Codex account/usage/read buckets and summary without inventing zeros for omitted dates", () => {
    const parsed = parseAccountTokenUsagePayload({
      summary: {
        lifetimeTokens: 111_907_589_643,
        peakDailyTokens: 3_355_766_635,
        longestRunningTurnSec: 95_849,
        currentStreakDays: 121,
        longestStreakDays: 121,
      },
      dailyUsageBuckets: [
        { startDate: "2026-11-23", tokens: 3_355_766_635 },
        { startDate: "2026-11-20", tokens: 942_115_356 },
        // Duplicate date keeps the max; invalid dates and negatives are dropped.
        { startDate: "2026-11-20", tokens: 999_000_000 },
        { startDate: "2026-02-30", tokens: 123 },
        { startDate: "2026-11-21", tokens: -5 },
        { startDate: "not-a-date", tokens: 500 },
      ],
      threadUsage: null,
    });

    expect(parsed).toEqual({
      summary: {
        lifetimeTokens: 111_907_589_643,
        peakDailyTokens: 3_355_766_635,
        longestRunningTurnSec: 95_849,
        currentStreakDays: 121,
        longestStreakDays: 121,
      },
      // 2026-11-21 and 2026-11-22 remain omitted, never zero-filled.
      dailyUsageBuckets: [
        { startDate: "2026-11-20", tokens: 999_000_000 },
        { startDate: "2026-11-23", tokens: 3_355_766_635 },
      ],
    });
  });

  it("handles null dailyUsageBuckets with summary or malformed payloads cleanly", () => {
    expect(parseAccountTokenUsagePayload({
      summary: { lifetimeTokens: 42, peakDailyTokens: null },
      dailyUsageBuckets: null,
    })).toEqual({
      summary: { lifetimeTokens: 42 },
      dailyUsageBuckets: [],
    });
    expect(parseAccountTokenUsagePayload({ summary: {}, dailyUsageBuckets: null })).toBeUndefined();
    expect(parseAccountTokenUsagePayload(null)).toBeUndefined();
  });

  it("sanitizes relayed observations across federation boundaries", () => {
    expect(parseAccountTokenUsageObservation({
      provider: "openai",
      accountKey: "acct-key",
      planType: "pro",
      observedAt: 1_700_000_000_000,
      status: "available",
      dailyUsageBuckets: [{ startDate: "2026-11-23", tokens: 1234 }],
    })).toEqual({
      provider: "openai",
      accountKey: "acct-key",
      planType: "pro",
      observedAt: 1_700_000_000_000,
      status: "available",
      dailyUsageBuckets: [{ startDate: "2026-11-23", tokens: 1234 }],
    });
    expect(parseAccountTokenUsageObservation({
      provider: "openai",
      observedAt: 1_700_000_000_000,
      status: "auth_required",
    })).toEqual({
      provider: "openai",
      observedAt: 1_700_000_000_000,
      status: "auth_required",
    });
    expect(parseAccountTokenUsageObservation({ status: "bogus", observedAt: 1 })).toBeUndefined();
    expect(parseAccountTokenUsageObservation({ status: "available", observedAt: 1 })).toBeUndefined();
  });
});

describe("readCodexAccountTokenUsage", () => {
  it("reads via Codex App Server with passive activity, opaque account identity, and no email leakage", async () => {
    let countsAsActivityDuringRead: boolean | undefined;
    const readAccount = vi.fn(async () => ({
      type: "chatgpt" as const,
      accountId: "acct-openai-123",
      email: "operator@example.com",
      planType: "pro",
    }));
    const readAccountUsage = vi.fn(async () => {
      countsAsActivityDuringRead = codexRequestCountsAsActivity();
      return {
        summary: { lifetimeTokens: 5_000_000, peakDailyTokens: 1_000_000 },
        dailyUsageBuckets: [
          { startDate: "2026-11-22", tokens: 800_000 },
          { startDate: "2026-11-23", tokens: 1_000_000 },
        ],
      };
    });

    const result = await readCodexAccountTokenUsage({
      client: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
        readAccount,
        readAccountUsage,
      } as never,
      openAiProviderEnabled: true,
      codexAvailable: true,
      now: () => 1_700_000_000_000,
    });

    expect(countsAsActivityDuringRead).toBe(false);
    expect(result).toEqual({
      provider: "openai",
      accountKey: usageAccountKey({ type: "chatgpt", accountId: "acct-openai-123" }),
      planType: "pro",
      observedAt: 1_700_000_000_000,
      status: "available",
      summary: { lifetimeTokens: 5_000_000, peakDailyTokens: 1_000_000 },
      dailyUsageBuckets: [
        { startDate: "2026-11-22", tokens: 800_000 },
        { startDate: "2026-11-23", tokens: 1_000_000 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("operator@example.com");
    expect(JSON.stringify(result)).not.toContain("acct-openai-123");
  });

  it("short-circuits API-key and unauthenticated sessions as auth_required without calling account/usage/read", async () => {
    const readAccountUsage = vi.fn(async () => ({ dailyUsageBuckets: [] }));
    for (const account of [
      { type: "apiKey" as const },
      { requiresOpenaiAuth: false },
      { requiresOpenaiAuth: true },
    ]) {
      const result = await readCodexAccountTokenUsage({
        client: {
          readAccount: async () => account,
          readAccountUsage,
        } as never,
        openAiProviderEnabled: true,
        codexAvailable: true,
        now: () => 500,
      });
      expect(result).toMatchObject({ provider: "openai", observedAt: 500, status: "auth_required" });
    }
    expect(readAccountUsage).not.toHaveBeenCalled();
  });

  it("never reuses a stale cached accountKey when readAccount throws", async () => {
    const result = await readCodexAccountTokenUsage({
      client: {
        readAccount: async () => { throw new Error("transient account read failure"); },
        readAccountUsage: async () => ({
          dailyUsageBuckets: [{ startDate: "2026-11-23", tokens: 100 }],
        }),
      } as never,
      openAiProviderEnabled: true,
      codexAvailable: true,
      cachedAccount: { type: "chatgpt", accountId: "stale-account", planType: "pro" },
      now: () => 900,
    });
    expect(result).toEqual({
      provider: "openai",
      observedAt: 900,
      status: "available",
      dailyUsageBuckets: [{ startDate: "2026-11-23", tokens: 100 }],
    });
    expect(result?.accountKey).toBeUndefined();
  });

  it("classifies unsupported method, auth errors, and transient errors", async () => {
    expect(classifyAccountTokenUsageError(new Error("codex account authentication required to read token usage"))).toBe("auth_required");
    expect(classifyAccountTokenUsageError(new Error("RPC error -32601: Method not found"))).toBe("unsupported");
    expect(classifyAccountTokenUsageError(new Error("ECONNRESET"))).toBe("unavailable");

    const unsupported = await readCodexAccountTokenUsage({
      client: {
        readAccount: async () => ({ type: "chatgpt" as const, accountId: "a" }),
        readAccountUsage: async () => { throw new Error("-32601 Method not found"); },
      } as never,
      openAiProviderEnabled: true,
      codexAvailable: true,
      now: () => 700,
    });
    expect(unsupported?.status).toBe("unsupported");
  });

  it("returns undefined when OpenAI Codex provider is disabled (e.g. Outpost with openai provider off)", async () => {
    const readAccountUsage = vi.fn();
    const result = await readCodexAccountTokenUsage({
      client: { readAccountUsage } as never,
      openAiProviderEnabled: false,
      codexAvailable: true,
    });
    expect(result).toBeUndefined();
    expect(readAccountUsage).not.toHaveBeenCalled();
  });
});

describe("DesktopBackendRegistry and Federation readUsageActivity account token scoping", () => {
  let stateDb: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  const readAccount = vi.fn(async () => ({
    type: "chatgpt" as const,
    accountId: "shared-acct",
    planType: "pro",
  }));
  const readAccountUsage = vi.fn(async () => ({
    summary: { lifetimeTokens: 10_000 },
    dailyUsageBuckets: [{ startDate: "2026-11-23", tokens: 2_500 }],
  }));
  const window = { from: Date.UTC(2026, 10, 20), to: Date.UTC(2026, 10, 24) };

  beforeEach(() => {
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
    readAccount.mockClear();
    readAccountUsage.mockClear();
    registry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
        readAccount,
        readAccountUsage,
      } as never,
      overlayStore: store,
      threadTitleGenerationService: null,
    });
    // Mark Codex available as discovery would on a desktop or Outpost.
    (registry as unknown as { codexBackendSummary?: { kind: "codex"; label: string; available: boolean } })
      .codexBackendSummary = { kind: "codex", label: "Codex", available: true };
  });

  afterEach(async () => {
    await registry.close();
    stateDb.close();
  });

  it("scopes account/usage/read strictly to Usage Activity requests and adds zero SQLite writes", async () => {
    // Non-Usage-Activity callers (like sidebar pace card) omit includeAccountTokenUsage.
    const paceRead = await registry.readUsageActivity(window);
    expect(paceRead.accountTokenUsage).toBeUndefined();
    expect(readAccountUsage).not.toHaveBeenCalled();

    // Usage Activity requests opt in explicitly, with zero SQLite commits.
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-account-token-usage-");
    const diskDb = StateDb.open(temp.dbPath);
    const diskStore = new SqliteOverlayStore(diskDb);
    const diskRegistry = createDesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
        readAccount,
        readAccountUsage,
      } as never,
      overlayStore: diskStore,
      threadTitleGenerationService: null,
    });
    (diskRegistry as unknown as { codexBackendSummary?: { kind: "codex"; label: string; available: boolean } })
      .codexBackendSummary = { kind: "codex", label: "Codex", available: true };
    try {
      const { result: usageRead, writes } = await measureSqliteWrites(() =>
        diskRegistry.readUsageActivity({ ...window, includeAccountTokenUsage: true }),
      );
      expect(writes.commits).toBe(0);
      expect(writes.walBytes).toBe(0);
      expect(readAccountUsage).toHaveBeenCalledTimes(1);
      expect(usageRead.accountTokenUsage).toEqual([
        expect.objectContaining({
          provider: "openai",
          accountKey: usageAccountKey({ type: "chatgpt", accountId: "shared-acct" }),
          status: "available",
          dailyUsageBuckets: [{ startDate: "2026-11-23", tokens: 2_500 }],
        }),
      ]);
    } finally {
      await diskRegistry.close();
      diskDb.close();
      removeTempStateDbDir(temp.tempDir);
    }
  });

  it("returns an explicit empty array when OpenAI Codex is unavailable so new Outposts/desktops are not mislabeled as older peers", async () => {
    (registry as unknown as { codexBackendSummary?: { kind: "codex"; label: string; available: boolean } })
      .codexBackendSummary = { kind: "codex", label: "Codex", available: false };
    const response = await registry.readUsageActivity({ ...window, includeAccountTokenUsage: true });
    expect(response.accountTokenUsage).toEqual([]);
    expect(readAccountUsage).not.toHaveBeenCalled();
  });

  it("relays includeAccountTokenUsage and accountTokenUsage across Federation to Outposts and remote peers", async () => {
    const router = new FederationRouter({
      localInstanceId: "outpost-owner",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "desktop-viewer",
      remoteInstanceId: "outpost-owner",
      sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "desktop-viewer" }); },
    });
    router.registerConnection({
      peerId: "desktop-viewer",
      capabilities: ["thread_detail"],
      sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); },
    });
    const readUsageActivitySpy = vi.fn(async (req) => await registry.readUsageActivity(req));
    registerFederationBackendHandlers({
      router,
      backend: { readUsageActivity: readUsageActivitySpy } as unknown as FederationBackendOperations,
    });
    const remoteClient = new FederationRemoteBackendClient(rpc);

    const response = await remoteClient.readUsageActivity({ ...window, includeAccountTokenUsage: true });
    expect(readUsageActivitySpy).toHaveBeenCalledWith({ ...window, includeAccountTokenUsage: true });
    const observation: AccountTokenUsageObservation | undefined = response.accountTokenUsage?.[0];
    expect(observation).toMatchObject({
      provider: "openai",
      accountKey: usageAccountKey({ type: "chatgpt", accountId: "shared-acct" }),
      status: "available",
      dailyUsageBuckets: [{ startDate: "2026-11-23", tokens: 2_500 }],
    });
    expect(FEDERATION_BACKEND_METHODS.readUsageActivity).toBe("backend.readUsageActivity");
  });
});
