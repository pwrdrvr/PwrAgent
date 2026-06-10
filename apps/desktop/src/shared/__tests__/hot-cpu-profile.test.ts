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
      }),
    ).toBe(
      [
        "PwrAgent captured a renderer CPU profile.",
        "Session basename: 20260610T120000Z",
        "Session directory path: /Users/test/.pwragent/profiles/dev/diagnostics/hot-cpu/20260610T120000Z",
        "CPU profile basename: renderer-hot-0001.cpuprofile",
        "CPU profile path: /Users/test/.pwragent/profiles/dev/diagnostics/hot-cpu/20260610T120000Z/renderer-hot-0001.cpuprofile",
        "Open the .cpuprofile in Chrome DevTools Performance, or inspect the full session directory for samples, events, and optional heap snapshots.",
      ].join("\n"),
    );
  });
});
