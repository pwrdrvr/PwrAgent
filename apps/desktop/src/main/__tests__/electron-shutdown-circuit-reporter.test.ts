import type { TestCase, TestResult } from "@playwright/test/reporter";
import { describe, expect, it, vi } from "vitest";
import ElectronShutdownCircuitReporter from "../../../e2e/fixtures/electron-shutdown-circuit-reporter";

function resultWithError(error: { message?: string; stack?: string }): TestResult {
  return {
    errors: [error],
  } as TestResult;
}

describe("Electron shutdown circuit reporter", () => {
  it("does not stop the run for an ordinary test failure", async () => {
    const stopRun = vi.fn();
    const reporter = new ElectronShutdownCircuitReporter({ stopRun });

    reporter.onTestEnd(
      {} as TestCase,
      resultWithError({ message: "ordinary assertion failed" }),
    );

    expect(stopRun).not.toHaveBeenCalled();
    await expect(reporter.onEnd({} as never)).resolves.toBeUndefined();
  });

  it("stops and fails the run once for a circuit-open failure", async () => {
    const stopRun = vi.fn();
    const reporter = new ElectronShutdownCircuitReporter({ stopRun });
    const result = resultWithError({
      message: "circuit opened",
      stack: "ElectronShutdownCircuitOpenError: circuit opened",
    });

    reporter.onTestEnd({} as TestCase, result);
    reporter.onTestEnd({} as TestCase, result);

    expect(stopRun).toHaveBeenCalledOnce();
    await expect(reporter.onEnd({} as never)).resolves.toEqual({
      status: "failed",
    });
  });
});
