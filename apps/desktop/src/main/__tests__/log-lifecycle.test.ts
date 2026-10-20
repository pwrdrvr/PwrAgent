import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import electronLog from "electron-log/main.js";
import { _resetAppLogsForTests, readAppLogSnapshot } from "../app-logs";
import {
  getMainLogger,
  initializeMainLogger,
  setMainLogDebugCollectionEnabled,
} from "../log";

type StdioErrorListener = (error: Error) => void;

// Exercise electron-log's real scope, hook, level and transport dispatch. Only
// the final sinks are replaced: no operator log files or terminal writes.
const lifecycleLog = getMainLogger("pwragent:backend-lifecycle");
const originalFile = electronLog.transports.file;
const originalWrite = electronLog.transports.console.writeFn;
const originalLevel = electronLog.transports.console.level;
const originalHooks = [...electronLog.hooks];
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalStdoutListeners = process.stdout.listeners("error");
const originalStderrListeners = process.stderr.listeners("error");
const fileSink = vi.fn();
const consoleSink = vi.fn();

beforeAll(() => {
  vi.spyOn(electronLog, "initialize").mockImplementation(() => {});
  electronLog.transports.file = Object.assign(fileSink, originalFile);
  electronLog.transports.console.writeFn = consoleSink;
  electronLog.transports.console.level = "info";
  initializeMainLogger();
});

beforeEach(() => {
  setMainLogDebugCollectionEnabled(false);
  _resetAppLogsForTests();
  fileSink.mockClear();
  consoleSink.mockClear();
});

afterAll(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  electronLog.transports.file = originalFile;
  electronLog.transports.console.writeFn = originalWrite;
  electronLog.transports.console.level = originalLevel;
  electronLog.hooks.splice(0, electronLog.hooks.length, ...originalHooks);
  for (const listener of process.stdout.listeners("error") as StdioErrorListener[]) {
    if (!originalStdoutListeners.includes(listener)) {
      process.stdout.off("error", listener);
    }
  }
  for (const listener of process.stderr.listeners("error") as StdioErrorListener[]) {
    if (!originalStderrListeners.includes(listener)) {
      process.stderr.off("error", listener);
    }
  }
  _resetAppLogsForTests();
  vi.restoreAllMocks();
});

describe("backend lifecycle output budget", () => {
  it("retains a burst in the file and bounded Logs buffer with zero terminal writes", () => {
    const methods = ["thread/status/changed", "turn/completed", "turn/failed", "turn/cancelled"];
    for (let index = 0; index < 6_000; index += 1) {
      lifecycleLog.info("backend lifecycle notification", {
        backend: "codex",
        method: methods[index % methods.length],
        status: "idle",
        threadId: `fixture-thread-${index}`,
        turnId: `fixture-turn-${index}`,
      });
    }

    expect(fileSink).toHaveBeenCalledTimes(6_000);
    const snapshot = readAppLogSnapshot();
    expect(snapshot.entries).toHaveLength(5_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries[0].line).toContain("threadId=fixture-thread-1000");
    expect(snapshot.entries.at(-1)?.line).toContain("turnId=fixture-turn-5999");
    expect(fileSink.mock.calls[2][0].data[0]).toContain("method=turn/failed");
    expect(consoleSink).not.toHaveBeenCalled();
  });

  it("enables live copies only while debug collection is on, without replaying a backlog", () => {
    lifecycleLog.info("before opt-in");
    expect(consoleSink).not.toHaveBeenCalled();
    setMainLogDebugCollectionEnabled(true);
    expect(consoleSink).not.toHaveBeenCalled();
    lifecycleLog.info("during opt-in");
    expect(consoleSink).toHaveBeenCalledTimes(1);
    setMainLogDebugCollectionEnabled(false);
    lifecycleLog.info("after opt-in");
    expect(consoleSink).toHaveBeenCalledTimes(1);
    expect(fileSink).toHaveBeenCalledTimes(3);
  });

  it("preserves warnings, errors, ordinary info and message-only error formatting", () => {
    lifecycleLog.warn("lifecycle warning");
    lifecycleLog.error("lifecycle failure", new Error("fixture failure"));
    getMainLogger("pwragent:backend-registry").info("backend connected");
    expect(consoleSink).toHaveBeenCalledTimes(3);
    expect(fileSink).toHaveBeenCalledTimes(3);
    expect(fileSink.mock.calls[1][0].data).toEqual([
      "lifecycle failure", "Error: fixture failure",
    ]);
    expect(readAppLogSnapshot().entries[1].line).not.toContain("at ");
  });

  it.each(["EPIPE", "ERR_STREAM_DESTROYED"])("keeps durable diagnostics after an opted-in sink closes with %s", (code) => {
    electronLog.transports.console.level = "info";
    setMainLogDebugCollectionEnabled(true);
    consoleSink.mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture closed output"), { code });
    });

    lifecycleLog.info("first transition");
    lifecycleLog.error("failure after output closed");
    setMainLogDebugCollectionEnabled(false);
    setMainLogDebugCollectionEnabled(true);
    lifecycleLog.info("later transition");

    expect(electronLog.transports.console.level).toBe(false);
    expect(consoleSink).toHaveBeenCalledTimes(1);
    expect(fileSink).toHaveBeenCalledTimes(3);
    expect(readAppLogSnapshot().entries.map((entry) => entry.level)).toEqual([
      "info", "error", "info",
    ]);
  });
});
