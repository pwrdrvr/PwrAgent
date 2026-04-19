import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deferred, createTemporaryTestDirectory } from "@pwragnt/agent-core";
import { resolveHeapMonitorConfig } from "../diagnostics/heap-monitor-config";
import { createHeapSession } from "../diagnostics/heap-session";
import { RendererHeapMonitor } from "../diagnostics/renderer-heap-monitor";

type HeapUsageResponse = {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
};

type SessionStub = ReturnType<typeof createSessionStub>;

function createMonitorConfig(overrides?: Partial<Extract<ReturnType<typeof resolveHeapMonitorConfig>, { enabled: true }>>) {
  const config = resolveHeapMonitorConfig({
    env: {
      PWRAGNT_HEAP_DIAGNOSTICS: "1",
      PWRAGNT_HEAP_DIAGNOSTICS_SETTLE_MS: "1",
      PWRAGNT_HEAP_DIAGNOSTICS_INTERVAL_MS: "5",
      PWRAGNT_HEAP_DIAGNOSTICS_DELTA_BYTES: "100",
      PWRAGNT_HEAP_DIAGNOSTICS_COOLDOWN_MS: "10",
      PWRAGNT_HEAP_DIAGNOSTICS_MAX_SNAPSHOTS: "2",
    },
    repoRoot: "/repo",
  });

  expect(config.enabled).toBe(true);
  if (!config.enabled) {
    throw new Error("Expected enabled config.");
  }

  return {
    ...config,
    ...overrides,
  };
}

function createSessionStub() {
  const samples: unknown[] = [];
  const events: unknown[] = [];
  const snapshotFiles: string[] = [];

  return {
    samples,
    events,
    snapshotFiles,
    session: {
      id: "abc123",
      directoryName: "heap-2026-04-18-1702-abc123",
      directoryPath: "/repo/.local/heap-2026-04-18-1702-abc123",
      samplesPath: "/repo/.local/heap-2026-04-18-1702-abc123/samples.ndjson",
      eventsPath: "/repo/.local/heap-2026-04-18-1702-abc123/events.ndjson",
      appendSample: vi.fn(async (sample) => {
        samples.push(sample);
      }),
      appendEvent: vi.fn(async (event) => {
        events.push(event);
      }),
      registerSnapshotFile: vi.fn(async (filename) => {
        snapshotFiles.push(filename);
      }),
    },
  };
}

function createTarget(
  responses: Array<HeapUsageResponse | Error>,
  options?: {
    takeHeapSnapshot?: (filePath: string) => Promise<void>;
  },
) {
  let attached = false;
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
      expect(method).toBe("Runtime.getHeapUsage");
      const next = responses.shift();
      if (next instanceof Error) {
        throw next;
      }

      if (!next) {
        throw new Error("No more heap responses queued.");
      }

      return next;
    }),
    on: vi.fn((event: string, listener: (event: unknown, reason: string) => void) => {
      if (event === "detach") {
        detachListeners.add(listener);
      }
    }),
    off: vi.fn((event: string, listener: (event: unknown, reason: string) => void) => {
      if (event === "detach") {
        detachListeners.delete(listener);
      }
    }),
  };

  const takeHeapSnapshot = vi.fn(
    options?.takeHeapSnapshot ??
      (async () => {
        return undefined;
      }),
  );

  return {
    target: {
      debugger: debuggerApi,
      takeHeapSnapshot,
    },
    debuggerApi,
    takeHeapSnapshot,
    emitDetach(reason = "target closed") {
      for (const listener of detachListeners) {
        listener(undefined, reason);
      }
    },
  };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("RendererHeapMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T21:02:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a baseline after settle and recurring follow-up samples", async () => {
    const session = createSessionStub();
    const { target, debuggerApi } = createTarget([
      { usedSize: 100, totalSize: 200 },
      { usedSize: 120, totalSize: 220 },
      { usedSize: 125, totalSize: 225 },
    ]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");

    await advance(1);
    expect(session.samples).toEqual([
      expect.objectContaining({
        source: "renderer",
        usedSize: 100,
        isBaseline: true,
        deltaBytes: null,
      }),
    ]);

    await advance(5);
    await advance(5);

    expect(session.samples).toEqual([
      expect.objectContaining({ source: "renderer", usedSize: 100, isBaseline: true, deltaBytes: null }),
      expect.objectContaining({ source: "renderer", usedSize: 120, isBaseline: false, deltaBytes: 20 }),
      expect.objectContaining({ source: "renderer", usedSize: 125, isBaseline: false, deltaBytes: 5 }),
    ]);

    await monitor.stop();
  });

  it("captures the baseline immediately when settle delay is zero", async () => {
    const session = createSessionStub();
    const { target } = createTarget([{ usedSize: 100, totalSize: 200 }]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig({
        settleDelayMs: 0,
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();

    expect(session.samples).toEqual([
      expect.objectContaining({
        source: "renderer",
        usedSize: 100,
        isBaseline: true,
        deltaBytes: null,
      }),
    ]);

    await monitor.stop();
  });

  it("captures a heap snapshot when adjacent samples cross the threshold", async () => {
    const session = createSessionStub();
    const { target, takeHeapSnapshot } = createTarget([
      { usedSize: 100, totalSize: 200 },
      { usedSize: 250, totalSize: 350 },
    ]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await advance(1);
    await advance(5);

    expect(takeHeapSnapshot).toHaveBeenCalledWith(
      "/repo/.local/heap-2026-04-18-1702-abc123/heap-0001.heapsnapshot",
    );
    expect(session.snapshotFiles).toEqual(["heap-0001.heapsnapshot"]);
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "snapshot-triggered",
          detail: expect.objectContaining({
            filename: "heap-0001.heapsnapshot",
            deltaBytes: 150,
          }),
        }),
        expect.objectContaining({
          source: "renderer",
          type: "snapshot-completed",
          detail: expect.objectContaining({
            filename: "heap-0001.heapsnapshot",
          }),
        }),
      ]),
    );

    await monitor.stop();
  });

  it("does not snapshot when growth stays below the adjacent-sample threshold", async () => {
    const session = createSessionStub();
    const { target, takeHeapSnapshot } = createTarget([
      { usedSize: 100, totalSize: 200 },
      { usedSize: 150, totalSize: 250 },
      { usedSize: 199, totalSize: 299 },
    ]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await advance(1);
    await advance(5);
    await advance(5);

    expect(takeHeapSnapshot).not.toHaveBeenCalled();
    expect(session.snapshotFiles).toEqual([]);

    await monitor.stop();
  });

  it("skips triggers while a snapshot is already in flight", async () => {
    const session = createSessionStub();
    const snapshotDeferred = new Deferred<void>();
    const { target } = createTarget(
      [
        { usedSize: 100, totalSize: 200 },
        { usedSize: 250, totalSize: 350 },
        { usedSize: 400, totalSize: 500 },
      ],
      {
        takeHeapSnapshot: async () => {
          await snapshotDeferred.promise;
        },
      },
    );

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig(),
      logger,
    });

    await monitor.start();
    await advance(1);
    await advance(5);
    await advance(5);

    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "snapshot-skipped",
          detail: expect.objectContaining({
            reason: "in-flight",
          }),
        }),
      ]),
    );

    snapshotDeferred.resolve();
    await Promise.resolve();
    await monitor.stop();
  });

  it("applies cooldown and then allows a later threshold crossing to capture again", async () => {
    const session = createSessionStub();
    const { target, takeHeapSnapshot } = createTarget([
      { usedSize: 100, totalSize: 200 },
      { usedSize: 250, totalSize: 350 },
      { usedSize: 360, totalSize: 460 },
      { usedSize: 470, totalSize: 570 },
    ]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await advance(1);
    await advance(5);
    await advance(5);
    await advance(5);

    expect(takeHeapSnapshot).toHaveBeenCalledTimes(2);
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "snapshot-skipped",
          detail: expect.objectContaining({
            reason: "cooldown",
          }),
        }),
      ]),
    );

    await monitor.stop();
  });

  it("stops taking new snapshots after reaching the session cap", async () => {
    const session = createSessionStub();
    const { target, takeHeapSnapshot } = createTarget([
      { usedSize: 100, totalSize: 200 },
      { usedSize: 250, totalSize: 350 },
      { usedSize: 400, totalSize: 500 },
    ]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig({
        maxSnapshots: 1,
        snapshotCooldownMs: 1,
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await advance(1);
    await advance(5);
    await advance(5);

    expect(takeHeapSnapshot).toHaveBeenCalledTimes(1);
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "snapshot-skipped",
          detail: expect.objectContaining({
            reason: "max-snapshots",
          }),
        }),
      ]),
    );

    await monitor.stop();
  });

  it("logs sample failures without crashing the monitor", async () => {
    const session = createSessionStub();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { target } = createTarget([
      { usedSize: 100, totalSize: 200 },
      new Error("heap exploded"),
      { usedSize: 130, totalSize: 230 },
    ]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig(),
      logger,
    });

    await monitor.start();
    await advance(1);
    await advance(5);
    await advance(5);

    expect(logger.error).toHaveBeenCalled();
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "sample-failed",
          detail: expect.objectContaining({
            error: "heap exploded",
          }),
        }),
      ]),
    );
    expect(session.samples).toEqual([
      expect.objectContaining({ source: "renderer", usedSize: 100 }),
      expect.objectContaining({ source: "renderer", usedSize: 130 }),
    ]);

    await monitor.stop();
  });

  it("logs debugger detachment and pauses further monitoring", async () => {
    const session = createSessionStub();
    const { target, debuggerApi, emitDetach } = createTarget([
      { usedSize: 100, totalSize: 200 },
      { usedSize: 250, totalSize: 350 },
      { usedSize: 400, totalSize: 500 },
    ]);

    const monitor = new RendererHeapMonitor({
      target,
      session: session.session,
      config: createMonitorConfig(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await advance(1);
    emitDetach("devtools opened");
    await Promise.resolve();
    await advance(50);

    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "debugger-detached",
          detail: expect.objectContaining({
            reason: "devtools opened",
          }),
        }),
      ]),
    );

    await monitor.stop();
  });

  it("stops cleanly when the renderer target has already been destroyed", async () => {
    const session = createSessionStub();
    const { target, debuggerApi } = createTarget([{ usedSize: 100, totalSize: 200 }]);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const monitor = new RendererHeapMonitor({
      target: {
        ...target,
        isDestroyed: () => true,
      },
      session: session.session,
      config: createMonitorConfig(),
      logger,
    });

    await monitor.start();
    await advance(1);
    await monitor.stop("window-closed");

    expect(debuggerApi.off).not.toHaveBeenCalled();
    expect(debuggerApi.detach).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(session.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "monitor-stopped",
          detail: expect.objectContaining({
            reason: "window-closed",
          }),
        }),
      ]),
    );
  });

  it("writes a heap snapshot file and matching events into a real session directory", async () => {
    vi.useRealTimers();
    const workspace = await createTemporaryTestDirectory();
    const config = resolveHeapMonitorConfig({
      env: {
        PWRAGNT_HEAP_DIAGNOSTICS: "1",
        PWRAGNT_HEAP_DIAGNOSTICS_SETTLE_MS: "1",
        PWRAGNT_HEAP_DIAGNOSTICS_INTERVAL_MS: "5",
        PWRAGNT_HEAP_DIAGNOSTICS_DELTA_BYTES: "100",
      },
      repoRoot: workspace.path,
    });

    expect(config.enabled).toBe(true);
    if (!config.enabled) {
      await workspace.cleanup();
      return;
    }

    const created = await createHeapSession({
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

    expect(created.ok).toBe(true);
    if (!created.ok) {
      await workspace.cleanup();
      return;
    }

    const snapshotWritten = new Deferred<void>();
    const { target } = createTarget(
      [
        { usedSize: 100, totalSize: 200 },
        { usedSize: 250, totalSize: 350 },
      ],
      {
        takeHeapSnapshot: async (filePath) => {
          await fs.writeFile(filePath, '{"snapshot":true}', "utf8");
          snapshotWritten.resolve();
        },
      },
    );

    const monitor = new RendererHeapMonitor({
      target,
      session: created.session,
      config,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await snapshotWritten.promise;

    await expect(
      fs.readFile(path.join(created.session.directoryPath, "heap-0001.heapsnapshot"), "utf8"),
    ).resolves.toContain('"snapshot":true');

    const eventsPath = path.join(created.session.directoryPath, "events.ndjson");
    let eventLines: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 1_000;

    while (Date.now() < deadline) {
      eventLines = (await fs.readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const hasCompletedSnapshot = eventLines.some(
        (line) =>
          line.type === "snapshot-completed" &&
          typeof line.detail === "object" &&
          line.detail !== null &&
          (line.detail as { filename?: string }).filename === "heap-0001.heapsnapshot"
      );
      if (hasCompletedSnapshot) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(eventLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "renderer",
          type: "snapshot-triggered",
          detail: expect.objectContaining({
            filename: "heap-0001.heapsnapshot",
          }),
        }),
        expect.objectContaining({
          source: "renderer",
          type: "snapshot-completed",
          detail: expect.objectContaining({
            filename: "heap-0001.heapsnapshot",
          }),
        }),
      ]),
    );

    await monitor.stop();
    await workspace.cleanup();
  });
});
