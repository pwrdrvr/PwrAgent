import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTemporaryTestDirectory } from "@pwragent/agent-core";
import { createStartupCpuProfileSession } from "../diagnostics/startup-cpu-profile-session";
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

describe("startup CPU profiling session", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("creates a single timestamped session directory and manifest when enabled", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const createdAt = new Date(2026, 3, 19, 9, 30, 3);
    const result = await createStartupCpuProfileSession({
      config,
      createdAt,
      sessionId: "abc123",
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const expectedDirectory = path.join(
      workspace.path,
      ".local",
      "startup-cpu-2026-04-19-0930-abc123",
    );

    expect(result.session.directoryPath).toBe(expectedDirectory);
    expect(result.session.mainProfilePath).toBe(path.join(expectedDirectory, "main.cpuprofile"));
    expect(result.session.rendererProfilePath).toBe(
      path.join(expectedDirectory, "renderer.cpuprofile"),
    );
    expect(result.session.analysisPath).toBe(path.join(expectedDirectory, "analysis.json"));
    expect(result.session.summaryPath).toBe(path.join(expectedDirectory, "summary.md"));

    const manifest = JSON.parse(
      await fs.readFile(path.join(expectedDirectory, "session.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      id: "abc123",
      directoryName: "startup-cpu-2026-04-19-0930-abc123",
      createdAt: createdAt.toISOString(),
      outputRoot: path.join(workspace.path, ".local"),
      status: "running",
      mainProfile: {
        filename: "main.cpuprofile",
        capturedAt: null,
      },
      rendererProfile: {
        filename: "renderer.cpuprofile",
        capturedAt: null,
      },
      analysis: {
        jsonFilename: "analysis.json",
        summaryFilename: "summary.md",
        generatedAt: null,
      },
      config: {
        postLoadDurationMs: 5000,
        hardTimeoutMs: 15000,
      },
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
  });

  it("appends ordered NDJSON events and updates manifest state", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const result = await createStartupCpuProfileSession({
      config,
      createdAt: new Date(2026, 3, 19, 9, 30, 3),
      sessionId: "abc123",
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    await result.session.appendEvent({
      source: "main",
      capturedAt: "2026-04-19T13:30:03.000Z",
      type: "controller-started",
      detail: {
        sessionId: "abc123",
      },
    });
    await result.session.appendEvent({
      source: "renderer",
      capturedAt: "2026-04-19T13:30:08.000Z",
      type: "profile-written",
      detail: {
        filename: "renderer.cpuprofile",
      },
    });

    await result.session.markProfileCaptured("main", "2026-04-19T13:30:09.000Z");
    await result.session.markAnalysisGenerated("2026-04-19T13:30:10.000Z");
    await result.session.complete({
      completedAt: "2026-04-19T13:30:11.000Z",
      status: "partial",
    });

    const eventLines = (
      await fs.readFile(path.join(result.session.directoryPath, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(eventLines).toEqual([
      {
        source: "main",
        capturedAt: "2026-04-19T13:30:03.000Z",
        type: "controller-started",
        detail: {
          sessionId: "abc123",
        },
      },
      {
        source: "renderer",
        capturedAt: "2026-04-19T13:30:08.000Z",
        type: "profile-written",
        detail: {
          filename: "renderer.cpuprofile",
        },
      },
    ]);

    const manifest = JSON.parse(
      await fs.readFile(path.join(result.session.directoryPath, "session.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      status: "partial",
      completedAt: "2026-04-19T13:30:11.000Z",
      mainProfile: {
        filename: "main.cpuprofile",
        capturedAt: "2026-04-19T13:30:09.000Z",
      },
      rendererProfile: {
        filename: "renderer.cpuprofile",
        capturedAt: null,
      },
      analysis: {
        jsonFilename: "analysis.json",
        summaryFilename: "summary.md",
        generatedAt: "2026-04-19T13:30:10.000Z",
      },
    });
  });

  it("returns a disabled config without creating .local output", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = resolveStartupCpuProfileConfig({
      env: {},
      repoRoot: workspace.path,
    });

    expect(config).toEqual({ enabled: false });
    await expect(fs.stat(path.join(workspace.path, ".local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("allows tuning the bounded capture window", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = resolveStartupCpuProfileConfig({
      env: {
        PWRAGENT_STARTUP_CPU_PROFILING: "1",
        PWRAGENT_STARTUP_CPU_PROFILE_POST_LOAD_MS: "8000",
        PWRAGENT_STARTUP_CPU_PROFILE_HARD_TIMEOUT_MS: "25000",
      },
      repoRoot: workspace.path,
    });

    expect(config).toMatchObject({
      enabled: true,
      postLoadDurationMs: 8000,
      hardTimeoutMs: 25000,
    });
  });

  it("returns a typed failure when the session root cannot be created", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    await fs.writeFile(path.join(workspace.path, ".local"), "not-a-directory", "utf8");
    const config = createEnabledConfig(workspace.path);

    const result = await createStartupCpuProfileSession({
      config,
      createdAt: new Date(2026, 3, 19, 9, 30, 3),
      sessionId: "abc123",
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "SESSION_CREATE_FAILED",
    });
  });
});
