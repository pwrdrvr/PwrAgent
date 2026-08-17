import { describe, expect, it, vi } from "vitest";
import type { CodexDiscoverySnapshot } from "@pwrdrvr/codex-discovery";
import { CodexDiscoveryCoordinator } from "../codex-discovery-coordinator";

function selectedSnapshot(command: string): CodexDiscoverySnapshot {
  return {
    candidates: [
      {
        command,
        executable: true,
        selected: true,
        source: "path",
        version: "0.126.0",
      },
    ],
    selectedCommand: command,
    selectedSource: "path",
  };
}

function notInstalledSnapshot(): CodexDiscoverySnapshot {
  return { candidates: [] };
}

function unvalidatedSnapshot(command: string): CodexDiscoverySnapshot {
  return {
    candidates: [
      {
        command,
        executable: true,
        selected: true,
        source: "path",
        versionFailureReason: "version_not_reported",
      },
    ],
    selectedCommand: command,
    selectedSource: "path",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("CodexDiscoveryCoordinator", () => {
  it("delegates Windows PATHEXT resolution to shared Codex discovery", async () => {
    const windowsCommand = "C:\\nvm4w\\nodejs\\codex.CMD";
    const env = {
      Path: "C:\\nvm4w\\nodejs;C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    const discover = vi.fn(async () => selectedSnapshot(windowsCommand));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      platform: "win32",
      resolveEnv: async () => env,
    });

    await expect(coordinator.resolve()).resolves.toMatchObject({
      command: windowsCommand,
      version: "0.126.0",
    });
    expect(discover).toHaveBeenCalledWith({
      configuredCommand: undefined,
      env,
      platform: "win32",
    });
  });

  it("selects a Codex PowerShell shim resolved from Windows PATH", async () => {
    const command = "C:\\nvm4w\\nodejs\\codex.ps1";
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => notInstalledSnapshot(),
      discoverPowerShell: async () => [
        {
          command,
          executable: true,
          selected: false,
          source: "path",
          version: "0.144.0",
        },
      ],
      platform: "win32",
      resolveEnv: async () => ({ Path: "C:\\nvm4w\\nodejs" }),
    });

    await expect(coordinator.resolve()).resolves.toEqual({
      command,
      source: "path",
      version: "0.144.0",
    });
  });

  it("falls back to PowerShell when shared Windows discovery selects an unvalidated command", async () => {
    const unresolvedCommand = "C:\\nvm4w\\nodejs\\codex";
    const powerShellCommand = `${unresolvedCommand}.ps1`;
    const discoverPowerShell = vi.fn(async () => [
      {
        command: powerShellCommand,
        executable: true,
        selected: false,
        source: "path" as const,
        version: "0.144.0",
      },
    ]);
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => unvalidatedSnapshot(unresolvedCommand),
      discoverPowerShell,
      platform: "win32",
      resolveEnv: async () => ({ Path: "C:\\nvm4w\\nodejs" }),
    });

    await expect(coordinator.discover()).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          command: unresolvedCommand,
          executable: false,
          selected: false,
        }),
        expect.objectContaining({
          command: powerShellCommand,
          executable: true,
          selected: true,
          version: "0.144.0",
        }),
      ],
      selectedCommand: powerShellCommand,
      selectedSource: "path",
    });
    expect(discoverPowerShell).toHaveBeenCalledWith({
      configuredCommand: undefined,
      env: { Path: "C:\\nvm4w\\nodejs" },
      includePath: true,
    });
  });

  it("rejects executable-looking candidates whose Codex version did not validate", async () => {
    const command = "C:\\nvm4w\\nodejs\\codex";
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => unvalidatedSnapshot(command),
      resolveEnv: async () => ({ PATH: "C:\\nvm4w\\nodejs" }),
    });

    await expect(coordinator.discover()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          command,
          executable: false,
          failureReason: "version_not_reported",
          selected: false,
        }),
      ],
    });
    await expect(coordinator.resolve()).rejects.toThrow(
      "codex CLI not found",
    );
  });

  it("selects a validated fallback after rejecting the discovered selection", async () => {
    const invalidCommand = "C:\\nvm4w\\nodejs\\codex";
    const validCommand = "C:\\nvm4w\\nodejs\\codex.cmd";
    const snapshot: CodexDiscoverySnapshot = {
      candidates: [
        {
          command: invalidCommand,
          executable: true,
          selected: true,
          source: "path",
          versionFailureReason: "version_not_reported",
        },
        {
          command: validCommand,
          executable: true,
          selected: false,
          source: "application",
          version: "0.126.0",
        },
      ],
      selectedCommand: invalidCommand,
      selectedSource: "path",
    };
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => snapshot,
      resolveEnv: async () => ({ PATH: "C:\\nvm4w\\nodejs" }),
    });

    await expect(coordinator.discover()).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          command: invalidCommand,
          executable: false,
          selected: false,
        }),
        expect.objectContaining({
          command: validCommand,
          selected: true,
          version: "0.126.0",
        }),
      ],
      selectedCommand: validCommand,
      selectedSource: "application",
    });
    await expect(coordinator.resolve()).resolves.toMatchObject({
      command: validCommand,
      source: "application",
      version: "0.126.0",
    });
  });

  it("single-flights concurrent probes and waits for the hydrated environment", async () => {
    const hydratedEnv = deferred<NodeJS.ProcessEnv>();
    const discover = vi.fn(async () => selectedSnapshot("/nvm/bin/codex"));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      resolveEnv: () => hydratedEnv.promise,
    });

    const first = coordinator.discover();
    const second = coordinator.discover();
    await Promise.resolve();

    expect(discover).not.toHaveBeenCalled();
    hydratedEnv.resolve({ PATH: "/nvm/bin:/usr/bin", NVM_DIR: "/nvm" });

    await expect(first).resolves.toEqual(selectedSnapshot("/nvm/bin/codex"));
    await expect(second).resolves.toEqual(selectedSnapshot("/nvm/bin/codex"));
    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith({
      configuredCommand: undefined,
      env: { PATH: "/nvm/bin:/usr/bin", NVM_DIR: "/nvm" },
    });
  });

  it("expires successful results and only serves them stale during a refresh", async () => {
    let now = 0;
    const refresh = deferred<CodexDiscoverySnapshot>();
    const discover = vi.fn()
      .mockResolvedValueOnce(selectedSnapshot("/old/codex"))
      .mockReturnValueOnce(refresh.promise);
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      now: () => now,
      resolveEnv: async () => ({ PATH: "/bin" }),
      staleSuccessTtlMs: 1_000,
      successTtlMs: 100,
    });

    await coordinator.discover();
    now = 100;
    const freshProbe = coordinator.discover();
    await Promise.resolve();

    await expect(
      coordinator.discover(undefined, { allowStaleSuccess: true }),
    ).resolves.toEqual(selectedSnapshot("/old/codex"));
    refresh.resolve(selectedSnapshot("/new/codex"));
    await expect(freshProbe).resolves.toEqual(selectedSnapshot("/new/codex"));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("re-probes not-installed results after their short TTL", async () => {
    let now = 0;
    const discover = vi.fn()
      .mockResolvedValueOnce(notInstalledSnapshot())
      .mockResolvedValueOnce(selectedSnapshot("/installed/codex"));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      notInstalledTtlMs: 15,
      now: () => now,
      resolveEnv: async () => ({ PATH: "/bin" }),
    });

    await expect(coordinator.discover()).resolves.toEqual(notInstalledSnapshot());
    now = 14;
    await coordinator.discover();
    expect(discover).toHaveBeenCalledOnce();

    now = 15;
    await expect(coordinator.discover()).resolves.toEqual(
      selectedSnapshot("/installed/codex"),
    );
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("uses the latest hydrated PATH when an expired result is re-probed", async () => {
    let now = 0;
    let path = "/old/bin";
    const discover = vi.fn(async (params?: { env?: NodeJS.ProcessEnv }) =>
      selectedSnapshot(`${params?.env?.PATH}/codex`),
    );
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      now: () => now,
      resolveEnv: async () => ({ PATH: path }),
      successTtlMs: 10,
    });

    await expect(coordinator.resolve()).resolves.toMatchObject({
      command: "/old/bin/codex",
    });
    path = "/new/bin";
    now = 10;
    await expect(coordinator.resolve()).resolves.toMatchObject({
      command: "/new/bin/codex",
    });
  });

  it("bounds failed probes and recovers after the failure TTL", async () => {
    let now = 0;
    const failure = new Error("probe failed");
    const discover = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(selectedSnapshot("/recovered/codex"));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      failureTtlMs: 5,
      now: () => now,
      resolveEnv: async () => ({ PATH: "/bin" }),
    });

    await expect(coordinator.discover()).rejects.toBe(failure);
    now = 4;
    await expect(coordinator.discover()).rejects.toBe(failure);
    expect(discover).toHaveBeenCalledOnce();

    now = 5;
    await expect(coordinator.discover()).resolves.toEqual(
      selectedSnapshot("/recovered/codex"),
    );
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("coalesces force refreshes and bypasses a fresh cache entry", async () => {
    let now = 0;
    const discover = vi.fn()
      .mockResolvedValueOnce(selectedSnapshot("/old/codex"))
      .mockResolvedValueOnce(selectedSnapshot("/forced/codex"));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      forceReuseTtlMs: 5,
      now: () => now,
      resolveEnv: async () => ({ PATH: "/bin" }),
    });
    await coordinator.discover();
    now = 5;

    const [first, second] = await Promise.all([
      coordinator.discover(undefined, { force: true }),
      coordinator.discover(undefined, { force: true }),
    ]);

    expect(first).toEqual(selectedSnapshot("/forced/codex"));
    expect(second).toEqual(first);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("reuses a just-finished result for sequential force requests", async () => {
    let now = 0;
    const discover = vi.fn(async () => selectedSnapshot("/bin/codex"));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      forceReuseTtlMs: 5_000,
      now: () => now,
      resolveEnv: async () => ({ PATH: "/bin" }),
    });

    const first = await coordinator.discover(undefined, { force: true });
    now = 4_999;
    const second = await coordinator.discover(undefined, { force: true });

    expect(second).toEqual(first);
    expect(discover).toHaveBeenCalledOnce();
  });

  it("serializes probes for different configured Codex targets", async () => {
    const firstProbe = deferred<CodexDiscoverySnapshot>();
    const discover = vi.fn()
      .mockReturnValueOnce(firstProbe.promise)
      .mockResolvedValueOnce(selectedSnapshot("/second/codex"));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      resolveEnv: async () => ({ PATH: "/bin" }),
    });

    const first = coordinator.discover("/first/codex");
    const second = coordinator.discover("/second/codex");
    await Promise.resolve();
    await Promise.resolve();
    expect(discover).toHaveBeenCalledOnce();

    firstProbe.resolve(selectedSnapshot("/first/codex"));
    await expect(first).resolves.toMatchObject({
      selectedCommand: "/first/codex",
    });
    await expect(second).resolves.toMatchObject({
      selectedCommand: "/second/codex",
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("invalidates config-sensitive results and shares selection with launch", async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce(selectedSnapshot("/configured/codex"))
      .mockResolvedValueOnce(selectedSnapshot("/changed/codex"));
    const coordinator = new CodexDiscoveryCoordinator({
      discover,
      resolveEnv: async () => ({ PATH: "/bin" }),
    });

    const settings = await coordinator.discover("codex-custom");
    const launch = await coordinator.resolve("codex-custom");
    expect(launch.command).toBe(settings.selectedCommand);
    expect(discover).toHaveBeenCalledOnce();

    coordinator.invalidate();
    await expect(coordinator.resolve("codex-custom")).resolves.toMatchObject({
      command: "/changed/codex",
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
