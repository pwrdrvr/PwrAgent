import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemporaryTestDirectory } from "@pwragent/agent-core";
import { createStartupCpuProfileSession } from "../diagnostics/startup-cpu-profile-session";
import { MainProcessCpuProfiler } from "../diagnostics/main-process-cpu-profiler";
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

describe("MainProcessCpuProfiler", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("starts, stops, and writes a main CPU profile artifact", async () => {
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

    const profilerSession = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      post: vi.fn(async (method: string) => {
        if (method === "Profiler.stop") {
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
    };

    const profiler = new MainProcessCpuProfiler({
      session: sessionResult.session,
      profilerSession,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date("2026-04-19T13:30:09.000Z"),
    });

    await expect(profiler.start()).resolves.toBe(true);
    await expect(profiler.stop("startup-window-complete")).resolves.toBe(true);

    expect(profilerSession.connect).toHaveBeenCalledTimes(1);
    expect(profilerSession.post).toHaveBeenNthCalledWith(1, "Profiler.enable");
    expect(profilerSession.post).toHaveBeenNthCalledWith(2, "Profiler.start");
    expect(profilerSession.post).toHaveBeenNthCalledWith(3, "Profiler.stop");
    expect(profilerSession.disconnect).toHaveBeenCalledTimes(1);

    const profile = JSON.parse(
      await fs.readFile(
        path.join(
          workspace.path,
          ".local",
          "startup-cpu-2026-04-19-0930-abc123",
          "main.cpuprofile",
        ),
        "utf8",
      ),
    );
    expect(profile).toMatchObject({
      nodes: [{ id: 1 }],
    });
  });

  it("records a stop failure without throwing", async () => {
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

    const profilerSession = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      post: vi.fn(async (method: string) => {
        if (method === "Profiler.stop") {
          throw new Error("Profiler.stop exploded");
        }

        return {};
      }),
    };

    const profiler = new MainProcessCpuProfiler({
      session: sessionResult.session,
      profilerSession,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date("2026-04-19T13:30:09.000Z"),
    });

    await profiler.start();
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
          source: "main",
          type: "profiler-stop-failed",
          detail: expect.objectContaining({
            error: "Profiler.stop exploded",
          }),
        }),
      ]),
    );
  });
});
