import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import {
  awaitElectronFixtureTeardown,
  closeElectronApplication,
} from "../../../e2e/fixtures/electron-app";
import {
  ElectronFixtureTeardownTimeoutError,
  ElectronShutdownCircuitOpenError,
  type ElectronShutdownSummary,
} from "../../../e2e/fixtures/electron-shutdown-policy";

describe("closeElectronApplication", () => {
  it("is a no-op when Playwright throws for an exited Electron handle", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const process = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy",
      forceExitOutcome: "not-needed",
    });
    expect(process).toHaveBeenCalledOnce();
  });

  it("is a no-op when Playwright returns no process for an exited handle", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const process = vi.fn(() => undefined);
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy",
      forceExitOutcome: "not-needed",
    });
    expect(process).toHaveBeenCalledOnce();
  });

  it("propagates an open circuit when the overall fixture teardown times out", async () => {
    await expect(awaitElectronFixtureTeardown({
      closeApplication: async () => shutdownSummary(true),
      running: new Promise<void>(() => undefined),
      timeoutMs: 0,
    })).rejects.toThrow(ElectronShutdownCircuitOpenError);
  });

  it("fails an ordinary overall fixture teardown timeout explicitly", async () => {
    await expect(awaitElectronFixtureTeardown({
      closeApplication: async () => shutdownSummary(false),
      running: new Promise<void>(() => undefined),
      timeoutMs: 0,
    })).rejects.toThrow(ElectronFixtureTeardownTimeoutError);
  });
});

function shutdownSummary(tripped: boolean): ElectronShutdownSummary {
  const phase = { durationMs: null, outcome: "not-observed" as const };
  return {
    schemaVersion: 1,
    kind: "close-summary",
    launchId: "launch-timeout",
    classification: tripped ? "force-killed" : "healthy",
    elapsedMs: tripped ? 6_100 : 100,
    quitRequestOutcome: "completed",
    gracefulCloseOutcome: tripped ? "timeout" : "closed",
    forceExitOutcome: tripped ? "exited" : "not-needed",
    phases: {
      rendererWindow: phase,
      messaging: phase,
      appServer: phase,
      overall: phase,
    },
    circuit: {
      enabled: true,
      consecutiveAbnormalCloses: tripped ? 2 : 0,
      limit: 2,
      tripped,
    },
  };
}
