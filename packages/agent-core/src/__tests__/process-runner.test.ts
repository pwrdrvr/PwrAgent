import { describe, expect, it } from "vitest";
import { runProcess } from "../tools/process-runner.js";

describe("process runner", () => {
  it("captures stdout and stderr while reporting a successful exit", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('hello stdout'); process.stderr.write('hello stderr');",
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "completed",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      }),
    );
    expect(result.stdout).toBe("hello stdout");
    expect(result.stderr).toBe("hello stderr");
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  it("drains output beyond the retained cap and reports truncation metadata", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('A'.repeat(1024));"],
      outputLimitBytes: 64,
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(1024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain("output truncated");
    expect(result.stdout.length).toBeLessThan(256);
  });

  it("emits output deltas while retaining capped output", async () => {
    const deltas: string[] = [];

    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('first'); process.stdout.write('second');"],
      outputLimitBytes: 8,
      onOutputDelta: (delta) => {
        deltas.push(`${delta.stream}:${delta.text}`);
      },
    });

    expect(result.status).toBe("completed");
    expect(result.stdoutTruncated).toBe(true);
    expect(deltas.join("|")).toContain("first");
    expect(deltas.join("|")).toContain("second");
  });

  it("terminates timed out processes and reports timeout status", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('tick\\n'), 10);"],
      timeoutMs: 30,
      killGraceMs: 10,
    });

    expect(result.status).toBe("timed_out");
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("terminates aborted processes and reports cancellation status", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('tick\\n'), 10);"],
      signal: controller.signal,
      killGraceMs: 10,
    });

    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});
