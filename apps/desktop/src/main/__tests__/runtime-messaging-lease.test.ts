import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PWRAGENT_INSTANCE_ROOT_ENV,
  RuntimeMessagingLeaseCoordinator,
} from "../runtime-messaging-lease";
import {
  AppRuntimeInstanceStore,
  hashCwd,
  RUNTIME_LEASE_DEAD_OWNER_GRACE_MS,
} from "../state/app-runtime-instance-store";
import { StateDb } from "../state/state-db";
import type { DesktopMessagingConfig } from "../messaging/messaging-config";
import type { DesktopMessagingRuntime } from "../messaging/messaging-runtime";

let stateDb: StateDb;
let store: AppRuntimeInstanceStore;
let tempDir: string;
let liveProcessIds: Set<number>;

function createRuntime(options: { failApply?: boolean } = {}): DesktopMessagingRuntime {
  let enabled = false;
  return {
    applyConfig: vi.fn(async () => {
      if (options.failApply) throw new Error("apply failed");
      enabled = true;
    }),
    isEnabled: vi.fn(() => enabled),
    stop: vi.fn(async () => {
      enabled = false;
    }),
  } as unknown as DesktopMessagingRuntime;
}

function createCoordinator(
  options: NonNullable<
    ConstructorParameters<typeof RuntimeMessagingLeaseCoordinator>[0]
  >,
): RuntimeMessagingLeaseCoordinator {
  const processId = options.processId ?? process.pid;
  liveProcessIds.add(processId);
  return new RuntimeMessagingLeaseCoordinator({
    ...options,
    processId,
    processIsAlive: (candidate) => liveProcessIds.has(candidate),
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-lease-coordinator-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"), {
    profileName: "dev",
  });
  store = new AppRuntimeInstanceStore(stateDb);
  liveProcessIds = new Set();
});

afterEach(() => {
  vi.useRealTimers();
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("RuntimeMessagingLeaseCoordinator", () => {
  it("records explicit no-messaging overrides without loading config", async () => {
    const runtime = createRuntime();
    const loadConfig = vi.fn(async () => ({
      enabled: true,
      inputDebounceMs: 500,
      telegram: {
        channel: "telegram" as const,
        enabled: true,
        botToken: "token",
        streamingResponses: false,
        authorizedActorIds: [],
        authorizedSupergroupIds: [],
      },
    }));
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      now: () => 1_000,
      store,
      env: { PWRAGENT_DISABLE_MESSAGING: "1" } as NodeJS.ProcessEnv,
    });

    await expect(coordinator.start(runtime, loadConfig)).resolves.toMatchObject({
      enabled: false,
      disabledReasonKind: "explicit_override",
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(runtime.applyConfig).not.toHaveBeenCalled();
    expect(store.getInstance("instance-a")).toMatchObject({
      desiredMessagingEnabled: false,
      effectiveMessagingEnabled: false,
      disabledReason: "explicit_override",
    });
    expect(store.getMessagingLease()).toBeUndefined();
  });

  it("uses the launch root env var for lease owner identity", async () => {
    const runtime = createRuntime();
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      now: () => 1_000,
      store,
      env: {
        [PWRAGENT_INSTANCE_ROOT_ENV]: "/Users/example/PwrAgnt",
      } as NodeJS.ProcessEnv,
    });

    await expect(
      coordinator.applyResolvedConfig(runtime, {
        enabled: true,
        inputDebounceMs: 500,
        toolUpdateDefaultMode: "show_some",
        telegram: {
          channel: "telegram" as const,
          enabled: true,
          botToken: "token",
          streamingResponses: false,
          authorizedActorIds: [],
          authorizedSupergroupIds: [],
        },
      }),
    ).resolves.toMatchObject({ enabled: true });

    expect(store.getInstance("instance-a")).toMatchObject({
      cwdHint: "PwrAgnt",
      // hashCwd hashes path.resolve(cwd), which gains a drive prefix +
      // backslashes on Windows, so compute the expectation through the product
      // helper instead of a POSIX-only literal (equals "c976f17804e892f9" on
      // macOS/Linux).
      cwdHash: hashCwd("/Users/example/PwrAgnt"),
    });

    coordinator.shutdownSync();
  });

  it("does not claim the lease when no adapters are runnable", async () => {
    const runtime = createRuntime();
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      now: () => 1_000,
      store,
    });

    await expect(
      coordinator.applyResolvedConfig(runtime, {
        enabled: true,
        inputDebounceMs: 500,
        toolUpdateDefaultMode: "show_some",
      }),
    ).resolves.toMatchObject({
      enabled: false,
      disabledReasonKind: "no_runnable_adapters",
    });

    expect(runtime.applyConfig).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(store.getMessagingLease()).toBeUndefined();
    expect(store.getInstance("instance-a")).toMatchObject({
      desiredMessagingEnabled: true,
      effectiveMessagingEnabled: false,
      disabledReason: "no_runnable_adapters",
    });
  });

  it("treats Feishu-only config as runnable", async () => {
    const runtime = createRuntime();
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      now: () => 1_000,
      store,
    });

    await expect(
      coordinator.applyResolvedConfig(runtime, {
        enabled: true,
        inputDebounceMs: 500,
        toolUpdateDefaultMode: "show_some",
        feishu: {
          channel: "feishu" as const,
          enabled: true,
          appId: "cli_xxx",
          appSecret: "secret",
          inboundMode: "persistent",
          tenantRegion: "feishu",
          tenantUrl: "https://open.feishu.cn",
          callbackBaseUrl: "https://example.test/feishu",
          streamingResponses: false,
          authorizedActorIds: [],
          authorizedChatIds: [],
          authorizedTenantKeys: [],
        },
      }),
    ).resolves.toMatchObject({ enabled: true });

    expect(runtime.applyConfig).toHaveBeenCalledTimes(1);
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });

    coordinator.shutdownSync();
  });

  it("starts runtime only for the profile lease holder", async () => {
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const first = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      now: () => 1_000,
      store,
    });
    const second = createCoordinator({
      instanceId: "instance-b",
      profileName: "dev",
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      now: () => 2_000,
      store,
    });
    const config: DesktopMessagingConfig = {
      enabled: true,
      inputDebounceMs: 500,
      toolUpdateDefaultMode: "show_some",
      telegram: {
        channel: "telegram" as const,
        enabled: true,
        botToken: "token",
        streamingResponses: false,
        authorizedActorIds: [],
        authorizedSupergroupIds: [],
      },
    };

    await expect(first.applyResolvedConfig(firstRuntime, config)).resolves
      .toMatchObject({ enabled: true });
    await expect(second.applyResolvedConfig(secondRuntime, config)).resolves
      .toMatchObject({
        enabled: false,
        disabledReasonKind: "lease_held",
        leaseHolder: { instanceId: "instance-a" },
      });

    expect(firstRuntime.applyConfig).toHaveBeenCalledTimes(1);
    expect(secondRuntime.applyConfig).not.toHaveBeenCalled();
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "active",
    });
    expect(store.getInstance("instance-b")).toMatchObject({
      effectiveMessagingEnabled: false,
      disabledReason: "lease_held",
    });
    first.shutdownSync();
  });

  it("stops runtime after the dead-owner grace permits replacement", async () => {
    let now = 1_000;
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const config: DesktopMessagingConfig = {
      enabled: true,
      inputDebounceMs: 500,
      toolUpdateDefaultMode: "show_some",
      telegram: {
        channel: "telegram" as const,
        enabled: true,
        botToken: "token",
        streamingResponses: false,
        authorizedActorIds: [],
        authorizedSupergroupIds: [],
      },
    };
    const first = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      now: () => now,
      store,
    });
    const second = createCoordinator({
      instanceId: "instance-b",
      profileName: "dev",
      processId: 456,
      cwd: "/tmp/PwrAgnt-b",
      now: () => now,
      store,
    });

    await first.applyResolvedConfig(firstRuntime, config);
    liveProcessIds.delete(123);
    now = 2_000;
    await expect(second.applyResolvedConfig(secondRuntime, config)).resolves
      .toMatchObject({ enabled: false, disabledReasonKind: "lease_held" });
    now += RUNTIME_LEASE_DEAD_OWNER_GRACE_MS;
    await expect(second.applyResolvedConfig(secondRuntime, config)).resolves
      .toMatchObject({ enabled: true });
    now += 1_000;
    await expect(first.applyResolvedConfig(firstRuntime, config)).resolves
      .toMatchObject({
        enabled: false,
        disabledReasonKind: "lease_held",
        leaseHolder: { instanceId: "instance-b" },
      });

    expect(firstRuntime.stop).toHaveBeenCalledTimes(1);
    expect(firstRuntime.isEnabled()).toBe(false);
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-b",
      status: "active",
    });
    second.shutdownSync();
  });

  it("does not renew a PID-owned lease on a timer", async () => {
    let now = 1_000;
    const runtime = createRuntime();
    const config: DesktopMessagingConfig = {
      enabled: true,
      inputDebounceMs: 500,
      toolUpdateDefaultMode: "show_some",
      telegram: {
        channel: "telegram" as const,
        enabled: true,
        botToken: "token",
        streamingResponses: false,
        authorizedActorIds: [],
        authorizedSupergroupIds: [],
      },
    };
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt-a",
      now: () => now,
      store,
    });

    await coordinator.applyResolvedConfig(runtime, config);
    now = 60 * 60 * 1000;

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({
      leaseHeld: true,
      effectiveMessagingEnabled: true,
    });
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      heartbeatAt: 1_000,
      status: "active",
    });
    coordinator.shutdownSync();
  });

  it("releases the lease when runtime startup fails", async () => {
    const runtime = createRuntime({ failApply: true });
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      now: () => 1_000,
      store,
    });

    await expect(
      coordinator.applyResolvedConfig(runtime, {
        enabled: true,
        inputDebounceMs: 500,
        toolUpdateDefaultMode: "show_some",
        telegram: {
          channel: "telegram",
          enabled: true,
          botToken: "token",
          streamingResponses: false,
          authorizedActorIds: [],
          authorizedSupergroupIds: [],
        },
      }),
    ).rejects.toThrow("apply failed");

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledWith({
      preserveStartupFailures: true,
    });
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "released",
      releasedAt: 1_000,
    });
    expect(store.getInstance("instance-a")).toMatchObject({
      desiredMessagingEnabled: true,
      effectiveMessagingEnabled: false,
      disabledReason: "startup_error",
    });
  });

  it("releases the lease when the session disables messaging", async () => {
    const runtime = createRuntime();
    const coordinator = createCoordinator({
      instanceId: "instance-a",
      profileName: "dev",
      processId: 123,
      cwd: "/tmp/PwrAgnt",
      now: () => 1_000,
      store,
    });

    await coordinator.applyResolvedConfig(runtime, {
      enabled: true,
      inputDebounceMs: 500,
      toolUpdateDefaultMode: "show_some",
      telegram: {
        channel: "telegram",
        enabled: true,
        botToken: "token",
        streamingResponses: false,
        authorizedActorIds: [],
        authorizedSupergroupIds: [],
      },
    });
    await expect(coordinator.disableForSession(runtime)).resolves.toMatchObject({
      enabled: false,
      disabledReasonKind: "runtime_stopped",
    });

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(store.getMessagingLease()).toMatchObject({
      ownerInstanceId: "instance-a",
      status: "released",
      releasedAt: 1_000,
    });
  });
});
