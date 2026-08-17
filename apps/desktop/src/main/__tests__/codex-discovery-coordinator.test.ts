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

type VersionProbe = (params: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}) => Promise<{ failureReason?: string; version?: string }>;

/**
 * What the shared scan returns when its 2s `--version` timeout fires: the
 * command is present and executable, but no version was read, so the desktop
 * has nothing to gate protocol compatibility on.
 */
function timedOutProbeSnapshot(command: string): CodexDiscoverySnapshot {
  return {
    candidates: [
      {
        command,
        executable: true,
        selected: true,
        source: "path",
        versionFailureReason:
          `Command failed: ${command} --version\nterminated by SIGTERM`,
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

  it("selects a Codex .cmd shim resolved beside the Windows PATH hit", async () => {
    const command = "C:\\nvm4w\\nodejs\\codex.cmd";
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => notInstalledSnapshot(),
      discoverWindows: async () => [
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

  it("replaces an unvalidated Windows PATH hit with its spawnable sibling", async () => {
    const unresolvedCommand = "C:\\nvm4w\\nodejs\\codex";
    const siblingCommand = `${unresolvedCommand}.cmd`;
    const discoverWindows = vi.fn(async () => [
      {
        command: siblingCommand,
        executable: true,
        selected: false,
        source: "path" as const,
        version: "0.144.0",
      },
    ]);
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => unvalidatedSnapshot(unresolvedCommand),
      discoverWindows,
      platform: "win32",
      resolveEnv: async () => ({ Path: "C:\\nvm4w\\nodejs" }),
    });

    // The shared PATH scan stops on the extensionless sh shim, so the
    // unusable original must not survive alongside the validated sibling.
    await expect(coordinator.discover()).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          command: siblingCommand,
          executable: true,
          selected: true,
          version: "0.144.0",
        }),
      ],
      selectedCommand: siblingCommand,
      selectedSource: "path",
    });
    expect(discoverWindows).toHaveBeenCalledWith({
      candidates: [expect.objectContaining({ command: unresolvedCommand })],
      configuredCommand: undefined,
      env: { Path: "C:\\nvm4w\\nodejs" },
    });
  });

  it("drops a PowerShell shim once its .cmd sibling validates", async () => {
    const base = "C:\\nvm4w\\nodejs\\codex";
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => unvalidatedSnapshot(`${base}.ps1`),
      discoverWindows: async () => [
        {
          command: `${base}.cmd`,
          executable: true,
          selected: false,
          source: "path" as const,
          version: "0.146.0",
        },
      ],
      platform: "win32",
      resolveEnv: async () => ({ Path: "C:\\nvm4w\\nodejs" }),
    });

    const snapshot = await coordinator.discover();
    expect(snapshot.candidates.map((candidate) => candidate.command)).toEqual([
      `${base}.cmd`,
    ]);
  });

  it("rejects executable-looking candidates whose Codex version did not validate", async () => {
    const command = "C:\\nvm4w\\nodejs\\codex";
    const coordinator = new CodexDiscoveryCoordinator({
      discover: async () => unvalidatedSnapshot(command),
      // Pin both seams: without them this test falls through to
      // process.platform and the real sibling probe, which on a Windows box
      // with this exact layout installed stats the filesystem and spawns a
      // real `codex.cmd --version`.
      discoverWindows: async () => [],
      platform: "darwin",
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
      discoverWindows: async () => [],
      platform: "win32",
      resolveEnv: async () => ({ PATH: "C:\\nvm4w\\nodejs" }),
    });

    await expect(coordinator.discover()).resolves.toMatchObject({
      candidates: [
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

  describe("unread version re-probe", () => {
    it("recovers a command whose shared version probe timed out", async () => {
      const discover = vi.fn(async () => timedOutProbeSnapshot("/slow/codex"));
      const probeVersion = vi.fn<VersionProbe>(async () => ({
        version: "0.130.0",
      }));
      const coordinator = new CodexDiscoveryCoordinator({
        discover,
        probeVersion,
        resolveEnv: async () => ({ PATH: "/bin" }),
      });

      await expect(coordinator.resolve()).resolves.toMatchObject({
        command: "/slow/codex",
        version: "0.130.0",
      });
      expect(probeVersion).toHaveBeenCalledOnce();
      expect(probeVersion.mock.calls[0]?.[0]).toMatchObject({
        command: "/slow/codex",
      });
    });

    it("keeps a configured command that a lower-priority install would have replaced", async () => {
      // The quiet half of the same failure: the machine HAS another Codex, so
      // a timed-out probe on `[models.codex] path` does not read as "missing"
      // — selection just falls through to whatever else is installed, and the
      // operator's explicit choice is silently ignored.
      const probeVersion = vi.fn<VersionProbe>(async () => ({
        version: "0.130.0",
      }));
      const coordinator = new CodexDiscoveryCoordinator({
        discover: async () => ({
          candidates: [
            {
              command: "/configured/codex",
              executable: true,
              selected: false,
              source: "config" as const,
              versionFailureReason:
                "Command failed: /configured/codex --version\n",
            },
            {
              command: "/usr/local/bin/codex",
              executable: true,
              selected: true,
              source: "application" as const,
              version: "0.146.1",
            },
          ],
          selectedCommand: "/usr/local/bin/codex",
          selectedSource: "application" as const,
        }),
        probeVersion,
        resolveEnv: async () => ({ PATH: "/bin" }),
      });

      await expect(coordinator.resolve("/configured/codex")).resolves
        .toMatchObject({
          command: "/configured/codex",
          source: "config",
          version: "0.130.0",
        });
      expect(probeVersion).toHaveBeenCalledOnce();
    });

    it("re-probes nothing when the shared scan already selected a command", async () => {
      const probeVersion = vi.fn<VersionProbe>(async () => ({
        version: "0.130.0",
      }));
      const coordinator = new CodexDiscoveryCoordinator({
        discover: async () => selectedSnapshot("/fast/codex"),
        probeVersion,
        resolveEnv: async () => ({ PATH: "/bin" }),
      });

      await expect(coordinator.resolve()).resolves.toMatchObject({
        command: "/fast/codex",
      });
      // #1720 coalesced provider probes; a re-probe on the healthy path would
      // reintroduce exactly the duplicate `--version` spawn it removed.
      expect(probeVersion).not.toHaveBeenCalled();
    });

    it("leaves settled failures alone", async () => {
      const probeVersion = vi.fn<VersionProbe>(async () => ({
        version: "0.130.0",
      }));
      const coordinator = new CodexDiscoveryCoordinator({
        discover: async () => ({
          candidates: [
            {
              command: "/absent/codex",
              executable: false,
              failureReason: "not_found",
              selected: false,
              source: "path" as const,
            },
            {
              command: "/old/codex",
              executable: false,
              failureReason: "codex_too_old",
              selected: false,
              source: "config" as const,
              version: "0.100.0",
            },
          ],
        }),
        probeVersion,
        resolveEnv: async () => ({ PATH: "/bin" }),
      });

      const snapshot = await coordinator.discover();
      expect(snapshot.selectedCommand).toBeUndefined();
      expect(probeVersion).not.toHaveBeenCalled();
    });

    it("still reports missing when the re-probe cannot read a version either", async () => {
      const probeVersion = vi.fn<VersionProbe>(async () => ({
        failureReason: "version_not_reported",
      }));
      const coordinator = new CodexDiscoveryCoordinator({
        discover: async () => timedOutProbeSnapshot("/slow/codex"),
        probeVersion,
        resolveEnv: async () => ({ PATH: "/bin" }),
      });

      await expect(coordinator.resolve()).rejects.toThrow(
        /codex CLI not found/i,
      );
      expect(probeVersion).toHaveBeenCalledOnce();
    });
  });
});
