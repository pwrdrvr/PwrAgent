import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAppLogsForTests,
  appendAppLogEntry,
  readAppLogSnapshot,
  subscribeAppLogEntries,
} from "../app-logs";

describe("app log snapshots", () => {
  beforeEach(() => {
    _resetAppLogsForTests();
  });

  it("returns buffered in-memory log entries", () => {
    appendAppLogEntry({
      timestamp: 1778616000000,
      level: "info",
      scope: "pwragent:test",
      line: "[2026-05-12 20:00:00.000] [info] (pwragent:test) ready",
    });

    expect(readAppLogSnapshot()).toMatchObject({
      kind: "log-snapshot",
      entries: [
        {
          sequence: 1,
          timestamp: 1778616000000,
          level: "info",
          scope: "pwragent:test",
        },
      ],
      truncated: false,
    });
  });

  it("notifies subscribers as entries are appended", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppLogEntries(listener);

    const entry = appendAppLogEntry({
      timestamp: 1778616000000,
      level: "warn",
      line: "[2026-05-12 20:00:00.000] [warn] warning",
    });

    expect(listener).toHaveBeenCalledWith(entry);
    unsubscribe();
    appendAppLogEntry({
      timestamp: 1778616000001,
      level: "info",
      line: "[2026-05-12 20:00:00.001] [info] ready",
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
