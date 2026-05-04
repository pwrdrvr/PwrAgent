import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTemporaryTestDirectory } from "@pwragent/agent-core";
import { resolveHeapMonitorConfig } from "../diagnostics/heap-monitor-config";
import { createHeapSession } from "../diagnostics/heap-session";

function createEnabledConfig(repoRoot: string) {
  const config = resolveHeapMonitorConfig({
    env: {
      PWRAGENT_HEAP_DIAGNOSTICS: "1",
    },
    repoRoot,
  });

  expect(config.enabled).toBe(true);

  if (!config.enabled) {
    throw new Error("Expected heap diagnostics to be enabled.");
  }

  return config;
}

describe("heap diagnostics session", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("creates a single timestamped session directory and manifest when enabled", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const createdAt = new Date(2026, 3, 18, 17, 2, 3);
    const result = await createHeapSession({
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
      "heap-2026-04-18-1702-abc123",
    );

    expect(result.session.directoryPath).toBe(expectedDirectory);
    await expect(fs.stat(path.join(workspace.path, ".local"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(fs.stat(expectedDirectory)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(expectedDirectory, "session.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      id: "abc123",
      directoryName: "heap-2026-04-18-1702-abc123",
      createdAt: createdAt.toISOString(),
      outputRoot: path.join(workspace.path, ".local"),
      snapshotFiles: [],
      config: {
        intervalMs: 5000,
        settleDelayMs: 1000,
        deltaThresholdBytes: 100 * 1024 * 1024,
        snapshotCooldownMs: 60000,
        maxSnapshots: 5,
      },
      versions: {
        appVersion: "0.1.0",
        electronVersion: "41.2.1",
        chromeVersion: "141.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
  });

  it("appends samples and events as ordered NDJSON records", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const result = await createHeapSession({
      config,
      createdAt: new Date(2026, 3, 18, 17, 2, 3),
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

    await result.session.appendSample({
      source: "renderer",
      capturedAt: "2026-04-18T21:02:10.000Z",
      usedSize: 12,
      totalSize: 24,
      embedderHeapUsedSize: 3,
      backingStorageSize: 4,
      isBaseline: true,
      deltaBytes: null,
    });
    await result.session.appendSample({
      source: "main",
      capturedAt: "2026-04-18T21:02:15.000Z",
      usedSize: 25,
      totalSize: 30,
      embedderHeapUsedSize: 5,
      backingStorageSize: 6,
      isBaseline: false,
      deltaBytes: 13,
    });

    await result.session.appendEvent({
      source: "renderer",
      capturedAt: "2026-04-18T21:02:10.000Z",
      type: "monitor-started",
      detail: {
        sessionId: "abc123",
      },
    });
    await result.session.appendEvent({
      source: "main",
      capturedAt: "2026-04-18T21:02:15.000Z",
      type: "snapshot-triggered",
      detail: {
        deltaBytes: 13,
      },
    });

    const sampleLines = (
      await fs.readFile(path.join(result.session.directoryPath, "samples.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const eventLines = (
      await fs.readFile(path.join(result.session.directoryPath, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(sampleLines).toEqual([
      {
        source: "renderer",
        capturedAt: "2026-04-18T21:02:10.000Z",
        usedSize: 12,
        totalSize: 24,
        embedderHeapUsedSize: 3,
        backingStorageSize: 4,
        isBaseline: true,
        deltaBytes: null,
      },
      {
        source: "main",
        capturedAt: "2026-04-18T21:02:15.000Z",
        usedSize: 25,
        totalSize: 30,
        embedderHeapUsedSize: 5,
        backingStorageSize: 6,
        isBaseline: false,
        deltaBytes: 13,
      },
    ]);
    expect(eventLines).toEqual([
      {
        source: "renderer",
        capturedAt: "2026-04-18T21:02:10.000Z",
        type: "monitor-started",
        detail: {
          sessionId: "abc123",
        },
      },
      {
        source: "main",
        capturedAt: "2026-04-18T21:02:15.000Z",
        type: "snapshot-triggered",
        detail: {
          deltaBytes: 13,
        },
      },
    ]);
  });

  it("returns a disabled config without creating .local output", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = resolveHeapMonitorConfig({
      env: {},
      repoRoot: workspace.path,
    });

    expect(config).toEqual({ enabled: false });
    await expect(fs.stat(path.join(workspace.path, ".local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("allows a zero settle delay for immediate baseline capture", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = resolveHeapMonitorConfig({
      env: {
        PWRAGENT_HEAP_DIAGNOSTICS: "1",
        PWRAGENT_HEAP_DIAGNOSTICS_SETTLE_MS: "0",
      },
      repoRoot: workspace.path,
    });

    expect(config).toMatchObject({
      enabled: true,
      settleDelayMs: 0,
    });
  });

  it("returns a typed failure when the session root cannot be created", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    await fs.writeFile(path.join(workspace.path, ".local"), "not-a-directory", "utf8");
    const config = createEnabledConfig(workspace.path);

    const result = await createHeapSession({
      config,
      createdAt: new Date(2026, 3, 18, 17, 2, 3),
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
      message: expect.stringContaining(".local"),
    });
  });
});
