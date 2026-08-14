import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createE2eShutdownDiagnosticsRecorder,
  readE2eShutdownPhaseEvents,
} from "../e2e-shutdown-diagnostics";

describe("E2E shutdown diagnostics", () => {
  it("records deterministic phase and overall elapsed times", () => {
    let now = 1_000;
    const lines: string[] = [];
    const recorder = createE2eShutdownDiagnosticsRecorder({
      enabled: true,
      launchId: "launch-1",
      now: () => now,
      writeLine: (line) => lines.push(line),
    });

    recorder.beginOverall();
    recorder.beginPhase("renderer-window");
    now = 1_125;
    recorder.finishPhase("renderer-window", "completed", 124.6);
    now = 1_500;
    recorder.finishOverall("completed");

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        schemaVersion: 1,
        kind: "phase",
        launchId: "launch-1",
        phase: "overall",
        outcome: "started",
        durationMs: 0,
      },
      {
        schemaVersion: 1,
        kind: "phase",
        launchId: "launch-1",
        phase: "renderer-window",
        outcome: "started",
        durationMs: 0,
      },
      {
        schemaVersion: 1,
        kind: "phase",
        launchId: "launch-1",
        phase: "renderer-window",
        outcome: "completed",
        durationMs: 125,
      },
      {
        schemaVersion: 1,
        kind: "phase",
        launchId: "launch-1",
        phase: "overall",
        outcome: "completed",
        durationMs: 500,
      },
    ]);
  });

  it("allowlists structured fields instead of replaying raw app detail", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "shutdown-diagnostics-"));
    const filePath = path.join(root, "diagnostics.jsonl");
    try {
      writeFileSync(
        filePath,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "phase",
          launchId: "launch-2",
          phase: "integrated-terminal",
          outcome: "timed-out",
          durationMs: 7_500,
          homeRoot: "/Users/alice/private-home",
          username: "alice",
          command: "Electron --secret token",
          error: "raw app log with a secret",
        })}\n`,
        "utf8",
      );

      const events = readE2eShutdownPhaseEvents(filePath, "launch-2");

      expect(events).toEqual([{
        schemaVersion: 1,
        kind: "phase",
        launchId: "launch-2",
        phase: "integrated-terminal",
        outcome: "timed-out",
        durationMs: 7_500,
      }]);
      expect(JSON.stringify(events)).not.toMatch(
        /alice|private-home|Electron|secret|raw app log/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
