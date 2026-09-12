import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeLeaseManager } from "../runtime-lease-manager";
import { RuntimeFederationLeaseCoordinator } from "../runtime-federation-lease";
import { RuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { RUNTIME_LEASE_RETRY_MS } from "../runtime-lease-retry";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import type { DesktopMessagingConfigLoadOptions, DesktopMessagingConfig } from "../messaging/messaging-config";
import type { DesktopMessagingRuntime } from "../messaging/messaging-runtime";

let db: StateDb;
let directory: string;
let store: AppRuntimeInstanceStore;
let owner: RuntimeLeaseManager;
let ownerAlive: boolean;
let federation: RuntimeFederationLeaseCoordinator;
let messaging: RuntimeMessagingLeaseCoordinator;
let messagingEnabled: boolean;
const config: DesktopMessagingConfig = {
  enabled: true,
  inputDebounceMs: 500,
  telegram: {
    channel: "telegram",
    enabled: true,
    botToken: "fixture-token",
    streamingResponses: false,
    authorizedActorIds: [],
    authorizedSupergroupIds: [],
  },
};
const messagingRuntime = {
  isEnabled: () => messagingEnabled,
  failClosedFullAccessPolicy: vi.fn(),
  applyConfig: vi.fn(async () => { messagingEnabled = true; }),
  stop: vi.fn(async () => { messagingEnabled = false; }),
} as unknown as DesktopMessagingRuntime;
const federationRuntime = {
  stop: vi.fn(async () => {}),
  restart: vi.fn(async () => { await federation.applyMode(federationRuntime, "gateway"); }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-lease-recovery-"));
  db = StateDb.open(path.join(directory, "state.db"), { profileName: "dev" });
  store = new AppRuntimeInstanceStore(db);
  ownerAlive = true;
  messagingEnabled = false;
  vi.clearAllMocks();
  const options = { store, profileName: "dev", systemBootedAt: 0, cwd: "/tmp/fixture", processIsAlive: () => ownerAlive };
  owner = new RuntimeLeaseManager({ ...options, instanceId: "owner", processId: 123 });
  owner.acquire("messaging");
  owner.acquire("federation");
  const challenger = new RuntimeLeaseManager({ ...options, instanceId: "challenger", processId: 456 });
  federation = new RuntimeFederationLeaseCoordinator({ leaseManager: challenger });
  messaging = new RuntimeMessagingLeaseCoordinator({ leaseManager: challenger });
});

afterEach(() => {
  federation.shutdownSync();
  messaging.shutdownSync();
  vi.useRealTimers();
  db.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function startBlocked() {
  await federation.applyMode(federationRuntime, "gateway");
  await messaging.applyLatestConfig(messagingRuntime, async () => config);
  expect(federation.snapshot().leaseHeld).toBe(false);
  expect(messaging.snapshot().leaseHeld).toBe(false);
}

function expectRecovered() {
  expect(federation.snapshot().leaseHeld).toBe(true);
  expect(messaging.snapshot().leaseHeld).toBe(true);
  expect(messagingEnabled).toBe(true);
  expect(federationRuntime.restart).toHaveBeenCalledTimes(1);
}

describe("automatic runtime lease recovery", () => {
  it("writes nothing during an hour blocked behind a live owner", async () => {
    await startBlocked();
    const { writes } = await measureSqliteWrites(async () => {
      await vi.advanceTimersByTimeAsync(3_600_000);
    });
    expectSqliteWriteBudget({ scenario: "runtime-lease-recovery-live-hour", note: "one hour of blocked messaging and federation recovery checks", writes });
    expect(federationRuntime.restart).not.toHaveBeenCalled();
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
  });

  it("recovers both leases after a dead owner grace without a manual toggle", async () => {
    ownerAlive = false;
    await startBlocked();
    expect(federation.snapshot().disabledReason).toContain("Waiting to retry");
    expect(federation.snapshot().leaseHolder).toBeUndefined();
    const { writes } = await measureSqliteWrites(async () => {
      await vi.advanceTimersByTimeAsync(60_000 - 1);
      expect(federation.snapshot().leaseHeld).toBe(false);
      expect(messaging.snapshot().leaseHeld).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expectRecovered();
      await vi.advanceTimersByTimeAsync(3_600_000);
    });
    expectSqliteWriteBudget({ scenario: "runtime-lease-recovery-takeover", note: "automatic takeover of both leases after grace, then one idle hour", writes });
    expect(federationRuntime.restart).toHaveBeenCalledTimes(1);
  });

  it("observes an owner that dies after startup and waits the full grace", async () => {
    await startBlocked();
    ownerAlive = false;
    await vi.advanceTimersByTimeAsync(RUNTIME_LEASE_RETRY_MS);
    expect(store.getInstance("owner")?.exitedAt).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(messagingEnabled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // One restart observes the death; the second acquires after grace.
    expect(federationRuntime.restart).toHaveBeenCalledTimes(2);
    expect(federation.snapshot().leaseHeld).toBe(true);
    expect(messagingEnabled).toBe(true);
  });

  it("takes over released leases on the next check", async () => {
    await startBlocked();
    owner.release("messaging");
    owner.release("federation");
    await vi.advanceTimersByTimeAsync(RUNTIME_LEASE_RETRY_MS);
    expectRecovered();
  });

  it.each(["disabled", "shutdown"])("cancels recovery on %s", async (action) => {
    await startBlocked();
    if (action === "disabled") {
      await federation.applyMode(federationRuntime, "disabled", true);
      await messaging.disableForSession(messagingRuntime);
    } else {
      federation.stopRecovery();
      messaging.stopRecovery();
    }
    ownerAlive = false;
    owner.release("messaging");
    owner.release("federation");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(federationRuntime.restart).not.toHaveBeenCalled();
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
  });

  it("does not rearm recovery when shutdown races a pending stop", async () => {
    let finishStop!: () => void;
    vi.mocked(messagingRuntime.stop).mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    const start = messaging.applyLatestConfig(messagingRuntime, async () => config);
    await vi.advanceTimersByTimeAsync(0);
    messaging.stopRecovery();
    finishStop();
    await start;
    owner.release("messaging");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
    await messaging.applyLatestConfig(messagingRuntime, async () => config);
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
  });

  it("does not steal a lease acquired by another challenger during grace", async () => {
    ownerAlive = false;
    await startBlocked();
    await vi.advanceTimersByTimeAsync(59_999);
    vi.setSystemTime(Date.now() + 1);
    const winner = new RuntimeLeaseManager({
      store, instanceId: "winner", processId: 789, profileName: "dev",
      cwd: "/tmp/winner", systemBootedAt: 0, processIsAlive: () => false,
    });
    expect(winner.acquire("federation")).toEqual({ acquired: true });
    expect(winner.acquire("messaging")).toEqual({ acquired: true });
    ownerAlive = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(federationRuntime.restart).not.toHaveBeenCalled();
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
    winner.release("federation");
    winner.release("messaging");
  });

  it.each(["replaced", "cleared"])("reloads a secret %s by another instance before takeover", async (change) => {
    let currentConfig = config;
    const loadConfig = vi.fn(async () => currentConfig);
    await messaging.start(messagingRuntime, loadConfig);
    currentConfig = {
      ...config,
      telegram: change === "cleared" ? undefined : { ...config.telegram!, botToken: "replacement-token" },
    };
    owner.release("messaging");
    await vi.advanceTimersByTimeAsync(RUNTIME_LEASE_RETRY_MS);
    expect(loadConfig).toHaveBeenCalledTimes(2);
    if (change === "cleared") {
      expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
      expect(messaging.snapshot().leaseHeld).toBe(false);
    } else {
      expect(messagingRuntime.applyConfig).toHaveBeenCalledExactlyOnceWith(currentConfig, { allowStart: true });
    }
  });

  it("preserves the session enable override when reloading for takeover", async () => {
    let token = "old-token";
    const loadConfig = vi.fn(async (options?: DesktopMessagingConfigLoadOptions) => ({
      ...config,
      enabled: options?.messagingEnabledOverride ?? false,
      telegram: { ...config.telegram!, botToken: token },
    }));
    await messaging.applyLatestConfig(messagingRuntime, loadConfig, { messagingEnabledOverride: true });
    token = "new-token";
    owner.release("messaging");
    await vi.advanceTimersByTimeAsync(RUNTIME_LEASE_RETRY_MS);
    expect(loadConfig).toHaveBeenLastCalledWith({ messagingEnabledOverride: true, logStartupEligibility: false });
    expect(messagingRuntime.applyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, telegram: expect.objectContaining({ botToken: "new-token" }) }),
      { allowStart: true },
    );
  });

  it.each(["disable", "shutdown", "new-config"])("discards an in-flight recovery read superseded by %s", async (action) => {
    let finishRead!: (value: DesktopMessagingConfig) => void;
    const loadConfig = vi.fn(async () => config);
    await messaging.start(messagingRuntime, loadConfig);
    loadConfig.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    owner.release("messaging");
    await vi.advanceTimersByTimeAsync(RUNTIME_LEASE_RETRY_MS);
    if (action === "disable") await messaging.disableForSession(messagingRuntime);
    else if (action === "shutdown") messaging.stopRecovery();
    else await messaging.applyLatestConfig(messagingRuntime, async () => ({ ...config, enabled: false }));
    finishRead(config);
    await vi.advanceTimersByTimeAsync(RUNTIME_LEASE_RETRY_MS);
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
    expect(messaging.snapshot().leaseHeld).toBe(false);
  });

  it("fails closed when the recovery configuration cannot be loaded", async () => {
    const loadConfig = vi.fn(async () => config);
    await messaging.start(messagingRuntime, loadConfig);
    loadConfig.mockRejectedValueOnce(new Error("shared secrets unavailable"));
    owner.release("messaging");
    await vi.advanceTimersByTimeAsync(RUNTIME_LEASE_RETRY_MS);
    expect(messagingRuntime.failClosedFullAccessPolicy).toHaveBeenCalled();
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
    expect(messaging.snapshot().leaseHeld).toBe(false);
  });

  it("a newer disabled config supersedes the blocked messaging config", async () => {
    await startBlocked();
    await messaging.applyResolvedConfig(messagingRuntime, { ...config, enabled: false });
    owner.release("messaging");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(messagingRuntime.applyConfig).not.toHaveBeenCalled();
  });
});
