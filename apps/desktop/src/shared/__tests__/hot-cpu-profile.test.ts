import { describe, expect, it } from "vitest";
import { buildHotCpuProfileHandoffMessage } from "../hot-cpu-profile";

describe("hot CPU profile handoff message", () => {
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
