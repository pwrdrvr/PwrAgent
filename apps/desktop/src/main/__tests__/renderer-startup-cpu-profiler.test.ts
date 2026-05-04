import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemporaryTestDirectory } from "@pwragent/agent-core";
import { createStartupCpuProfileSession } from "../diagnostics/startup-cpu-profile-session";
import { RendererStartupCpuProfiler } from "../diagnostics/renderer-startup-cpu-profiler";
import { resolveStartupCpuProfileConfig } from "../diagnostics/startup-cpu-profile-config";

function createEnabledConfig(repoRoot: string) {
  const config = resolveStartupCpuProfileConfig({
    env: {
      PWRAGENT_STARTUP_CPU_PROFILING: "1",
    },
    repoRoot,
  });

  expect(config.enabled).toBe(true);
  if (!config.enabled) {
    throw new Error("Expected startup CPU profiling to be enabled.");
  }

  return config;
}

function createTarget(options?: {
  alreadyAttached?: boolean;
  stopError?: Error;
}) {
  let attached = Boolean(options?.alreadyAttached);
  const detachListeners = new Set<(event: unknown, reason: string) => void>();

  const debuggerApi = {
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async (method: string) => {
      if (method === "Profiler.stop") {
        if (options?.stopError) {
          throw options.stopError;
        }

        return {
          profile: {
            nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "" } }],
            samples: [],
            timeDeltas: [],
          },
        };
      }

      return {};
    }),
    on: vi.fn((event: "detach", listener: (event: unknown, reason: string) => void) => {
      if (event === "detach") {
        detachListeners.add(listener);
      }
    }),
    off: vi.fn((event: "detach", listener: (event: unknown, reason: string) => void) => {
      if (event === "detach") {
        detachListeners.delete(listener);
      }
    }),
  };

  return {
    target: {
      debugger: debuggerApi,
      isDestroyed: vi.fn(() => false),
    },
    debuggerApi,
    emitDetach(reason = "target closed") {
      for (const listener of detachListeners) {
        listener(undefined, reason);
      }
    },
  };
}

describe("RendererStartupCpuProfiler", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("attaches, captures, and writes a renderer CPU profile artifact", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const sessionResult = await createStartupCpuProfileSession({
      config: createEnabledConfig(workspace.path),
      createdAt: new Date(2026, 3, 19, 9, 30, 3),
      sessionId: "abc123",
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) {
      return;
    }

    const { target, debuggerApi } = createTarget();
    const profiler = new RendererStartupCpuProfiler({
      target,
      session: sessionResult.session,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date("2026-04-19T13:30:09.000Z"),
    });

    await expect(profiler.start()).resolves.toBe(true);
    await expect(profiler.stop("startup-window-complete")).resolves.toBe(true);

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(1, "Profiler.enable");
    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(2, "Profiler.start");
    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(3, "Profiler.stop");
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);

    const profile = JSON.parse(
      await fs.readFile(sessionResult.session.rendererProfilePath, "utf8"),
    );
    expect(profile).toMatchObject({
      nodes: [{ id: 1 }],
    });
  });

  it("skips profiling when the renderer debugger is already attached", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const sessionResult = await createStartupCpuProfileSession({
      config: createEnabledConfig(workspace.path),
      createdAt: new Date(2026, 3, 19, 9, 30, 3),
      sessionId: "abc123",
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) {
      return;
    }

    const { target } = createTarget({ alreadyAttached: true });
    const profiler = new RendererStartupCpuProfiler({
      target,
      session: sessionResult.session,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date("2026-04-19T13:30:09.000Z"),
    });

    await expect(profiler.start()).resolves.toBe(false);
    await expect(profiler.stop("startup-window-complete")).resolves.toBe(false);

    const events = (
      await fs.readFile(sessionResult.session.eventsPath, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "profiler-start-skipped",
          detail: {
            reason: "debugger-already-attached",
          },
        }),
      ]),
    );
  });

  it("records debugger detachment and does not write a profile afterward", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const sessionResult = await createStartupCpuProfileSession({
      config: createEnabledConfig(workspace.path),
      createdAt: new Date(2026, 3, 19, 9, 30, 3),
      sessionId: "abc123",
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) {
      return;
    }

    const { target, emitDetach } = createTarget();
    const profiler = new RendererStartupCpuProfiler({
      target,
      session: sessionResult.session,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date("2026-04-19T13:30:09.000Z"),
    });

    await profiler.start();
    emitDetach("devtools-opened");
    await expect(profiler.stop("startup-window-complete")).resolves.toBe(false);

    await expect(fs.readFile(sessionResult.session.rendererProfilePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
