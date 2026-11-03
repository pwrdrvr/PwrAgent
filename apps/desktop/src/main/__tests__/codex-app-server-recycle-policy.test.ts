import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS,
  codexAppServerRecycleCheckIntervalMs,
  decideCodexAppServerRecycle,
  type CodexAppServerProcessSample,
} from "../codex-app-server/app-server-recycle-policy";
import { parseDesktopSettingsToml } from "../settings/desktop-config";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const settings = DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS;

function sample(overrides: Partial<CodexAppServerProcessSample>): CodexAppServerProcessSample {
  return {
    pid: 4242,
    startedAt: 0,
    sampledAt: 2 * HOUR,
    uptimeMs: 2 * HOUR,
    childProcessCount: 4,
    ...overrides,
  };
}

describe("decideCodexAppServerRecycle", () => {
  it("keeps a healthy server", () => {
    expect(decideCodexAppServerRecycle(settings, sample({}))).toEqual([]);
  });

  it("names every limit the server is over", () => {
    expect(decideCodexAppServerRecycle(settings, sample({ uptimeMs: 8 * HOUR }))).toEqual(["uptime"]);
    // The Nov 3, 2026 incident: 557 MCP children after 25 hours.
    expect(decideCodexAppServerRecycle(settings, sample({
      uptimeMs: 25 * HOUR,
      childProcessCount: 557,
      openFdCount: 1_670,
    }))).toEqual(["uptime", "child-processes", "open-fds"]);
    expect(decideCodexAppServerRecycle(settings, sample({ childProcessCount: 64 })))
      .toEqual(["child-processes"]);
  });

  it("never replaces a server younger than the minimum uptime", () => {
    expect(decideCodexAppServerRecycle(settings, sample({
      uptimeMs: 29 * MINUTE,
      childProcessCount: 500,
    }))).toEqual([]);
  });

  it("ignores counts the platform could not read", () => {
    expect(decideCodexAppServerRecycle(settings, sample({
      childProcessCount: undefined,
      openFdCount: undefined,
    }))).toEqual([]);
  });

  it("does nothing when disabled", () => {
    expect(decideCodexAppServerRecycle(
      { ...settings, enabled: false },
      sample({ uptimeMs: 48 * HOUR, childProcessCount: 900 }),
    )).toEqual([]);
  });

  it("checks a quarter of the idle window, between 30 seconds and 5 minutes", () => {
    expect(codexAppServerRecycleCheckIntervalMs(settings)).toBe(5 * MINUTE);
    expect(codexAppServerRecycleCheckIntervalMs({ ...settings, idleMs: 8 * MINUTE })).toBe(2 * MINUTE);
    expect(codexAppServerRecycleCheckIntervalMs({ ...settings, idleMs: MINUTE })).toBe(30_000);
  });
});

describe("[models.codex.app_server_recycle]", () => {
  it("reads the table and drops values that are not positive numbers", () => {
    const config = parseDesktopSettingsToml(
      [
        "[models.codex.app_server_recycle]",
        "enabled = false",
        "idle_minutes = 5",
        "max_uptime_hours = 2.5",
        "max_child_processes = 0",
        "max_open_fds = \"many\"",
        "",
      ].join("\n"),
      "/fixture/config.toml",
    );
    expect(config.models?.codex?.appServerRecycle).toEqual({
      enabled: false,
      idleMinutes: 5,
      maxUptimeHours: 2.5,
      maxChildProcesses: undefined,
      maxOpenFds: undefined,
    });
  });

  it("is absent when the table is absent", () => {
    const config = parseDesktopSettingsToml("[models.codex]\nallow_fast = true\n", "/fixture/config.toml");
    expect(config.models?.codex).not.toHaveProperty("appServerRecycle");
  });
});
