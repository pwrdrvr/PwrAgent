import { describe, expect, it } from "vitest";
import {
  buildHotCpuProfileHandoffMessage,
  type HotCpuProfileCapturedEvent,
} from "../hot-cpu-profile";

const capturedEvent: HotCpuProfileCapturedEvent = {
  capturedAt: "2026-10-06T14:48:39.892Z",
  profileFilename: "renderer-hot-0001.cpuprofile",
  profilePath: "/tmp/hot-cpu/renderer-hot-0001.cpuprofile",
  sessionDirectory: "/tmp/hot-cpu",
  sessionDirectoryName: "hot-cpu",
  triggerConsecutiveSamples: 1,
  triggerCpuPercent: 87.3,
  triggerMode: "spike",
  triggerThresholdPercent: 50,
};

describe("hot CPU profile handoff message", () => {
  it("identifies main-process captures", () => {
    const message = buildHotCpuProfileHandoffMessage({
      target: "main",
      sourceHostname: "fixture-m5.local",
      appBuildMetadata: {
        applicationVersion: "2.3.4",
        buildIdentity: { kind: "packaged" },
      },
      capturedAt: "2026-09-05T23:00:00.000Z",
      profileFilename: "main-hot-0001.cpuprofile",
      profilePath: "/tmp/hot-cpu/main-hot-0001.cpuprofile",
      sessionDirectory: "/tmp/hot-cpu",
      sessionDirectoryName: "hot-cpu",
      triggerConsecutiveSamples: 2,
      triggerCpuPercent: 206,
      triggerMode: "sustained",
      triggerThresholdPercent: 50,
    });
    expect(message).toContain("PwrAgent captured a main CPU profile.");
    expect(message).toContain("Source: Local app on fixture-m5.local");
    expect(message).toContain("Captured at: 2026-09-05T23:00:00.000Z");
    expect(message).toContain("PwrAgent version: 2.3.4\nPwrAgent build: Packaged");
    expect(message).not.toContain("development branch");
  });

  it.each(["main", "renderer"] as const)(
    "includes the startup checkout identity for %s captures",
    (target) => {
      const message = buildHotCpuProfileHandoffMessage({
        ...capturedEvent,
        target,
        appBuildMetadata: {
          applicationVersion: "2.3.4-dev",
          buildIdentity: {
            kind: "development",
            appPath: "/repo/apps/desktop",
            checkoutPath: "/repo",
            branch: "fix/cpu-profile-build-diagnostics",
            commitSha: "1234567890abcdef1234567890abcdef12345678",
          },
        },
      });
      expect(message).toContain([
        "PwrAgent version: 2.3.4-dev",
        "PwrAgent build: Development",
        "PwrAgent development app path: /repo/apps/desktop",
        "PwrAgent development checkout path: /repo",
        "PwrAgent development branch (startup): fix/cpu-profile-build-diagnostics",
        "PwrAgent development commit SHA (startup): 1234567890abcdef1234567890abcdef12345678",
      ].join("\n"));
    },
  );

  it("identifies a detached startup checkout and unavailable Git details", () => {
    const message = buildHotCpuProfileHandoffMessage({
      ...capturedEvent,
      appBuildMetadata: {
        applicationVersion: "2.3.4-dev",
        buildIdentity: {
          kind: "development",
          appPath: "/repo/apps/desktop",
          detachedHead: true,
        },
      },
    });
    expect(message).toContain("PwrAgent development branch (startup): Detached HEAD");
    expect(message).toContain("PwrAgent development checkout path: Unavailable");
    expect(message).toContain("PwrAgent development commit SHA (startup): Unavailable");
  });

  it("includes copyable basenames and absolute paths", () => {
    expect(
      buildHotCpuProfileHandoffMessage({
        capturedAt: "2026-06-10T12:00:00.000Z",
        profileFilename: "renderer-hot-0001.cpuprofile",
        profilePath:
          "/Users/test/.pwragent/profiles/dev/diagnostics/hot-cpu/20260610T120000Z/renderer-hot-0001.cpuprofile",
        sessionDirectory:
          "/Users/test/.pwragent/profiles/dev/diagnostics/hot-cpu/20260610T120000Z",
        sessionDirectoryName: "20260610T120000Z",
        triggerConsecutiveSamples: 2,
        triggerCpuPercent: 24.25,
        triggerMode: "slowburn",
        triggerThresholdPercent: 15,
      }),
    ).toBe(
      [
        "PwrAgent captured a renderer CPU profile.",
        "Source: Local app",
        "Captured at: 2026-06-10T12:00:00.000Z",
        "PwrAgent version: Unavailable",
        "PwrAgent build: Unavailable",
        "Trigger: Slowburn (2 consecutive samples >= 15%; trigger sample 24.3%)",
        "Session basename: 20260610T120000Z",
        "Session directory path: /Users/test/.pwragent/profiles/dev/diagnostics/hot-cpu/20260610T120000Z",
        "CPU profile basename: renderer-hot-0001.cpuprofile",
        "CPU profile path: /Users/test/.pwragent/profiles/dev/diagnostics/hot-cpu/20260610T120000Z/renderer-hot-0001.cpuprofile",
        "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots.",
      ].join("\n"),
    );
  });

  it("includes heap snapshot artifacts when present", () => {
    expect(
      buildHotCpuProfileHandoffMessage({
        capturedAt: "2026-06-10T12:00:00.000Z",
        heapSnapshotArtifacts: [
          {
            filename: "renderer-hot-0001-start.heapsnapshot",
            path: "/tmp/hot-cpu/renderer-hot-0001-start.heapsnapshot",
            phase: "start",
          },
          {
            filename: "renderer-hot-0001-stop.heapsnapshot",
            path: "/tmp/hot-cpu/renderer-hot-0001-stop.heapsnapshot",
            phase: "stop",
          },
        ],
        profileFilename: "renderer-hot-0001.cpuprofile",
        profilePath: "/tmp/hot-cpu/renderer-hot-0001.cpuprofile",
        sessionDirectory: "/tmp/hot-cpu",
        sessionDirectoryName: "hot-cpu",
        triggerConsecutiveSamples: 1,
        triggerCpuPercent: 80,
        triggerMode: "spike",
        triggerThresholdPercent: 50,
      }),
    ).toBe(
      [
        "PwrAgent captured a renderer CPU profile.",
        "Source: Local app",
        "Captured at: 2026-06-10T12:00:00.000Z",
        "PwrAgent version: Unavailable",
        "PwrAgent build: Unavailable",
        "Trigger: Spike (1 sample >= 50%; trigger sample 80%)",
        "Session basename: hot-cpu",
        "Session directory path: /tmp/hot-cpu",
        "CPU profile basename: renderer-hot-0001.cpuprofile",
        "CPU profile path: /tmp/hot-cpu/renderer-hot-0001.cpuprofile",
        "Heap snapshots captured: 2",
        "Heap snapshot start basename: renderer-hot-0001-start.heapsnapshot",
        "Heap snapshot start path: /tmp/hot-cpu/renderer-hot-0001-start.heapsnapshot",
        "Heap snapshot stop basename: renderer-hot-0001-stop.heapsnapshot",
        "Heap snapshot stop path: /tmp/hot-cpu/renderer-hot-0001-stop.heapsnapshot",
        "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots.",
      ].join("\n"),
    );
  });
});
