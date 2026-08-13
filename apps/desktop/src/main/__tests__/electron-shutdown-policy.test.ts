import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceElectronShutdownCircuit,
  assertElectronShutdownCircuitClosed,
  buildElectronShutdownSummary,
  classifyElectronClose,
  ElectronShutdownCircuitOpenError,
  executeElectronClose,
  finalizeElectronFixtureTeardown,
  memoizeElectronClose,
  recordElectronShutdownCircuit,
  SLOW_ELECTRON_CLOSE_THRESHOLD_MS,
  type ElectronShutdownCircuitState,
  type ElectronShutdownSummary,
} from "../../../e2e/fixtures/electron-shutdown-policy";

const CLOSED_STATE: ElectronShutdownCircuitState = {
  schemaVersion: 1,
  consecutiveAbnormalCloses: 0,
  open: false,
};

describe("Electron shutdown policy", () => {
  it("classifies slow and force-killed closes at measured boundaries", () => {
    expect(classifyElectronClose({
      elapsedMs: SLOW_ELECTRON_CLOSE_THRESHOLD_MS - 1,
      forced: false,
    })).toBe("healthy");
    expect(classifyElectronClose({
      elapsedMs: SLOW_ELECTRON_CLOSE_THRESHOLD_MS,
      forced: false,
    })).toBe("slow");
    expect(classifyElectronClose({
      elapsedMs: 0,
      forced: false,
      shutdownElapsedMs: SLOW_ELECTRON_CLOSE_THRESHOLD_MS,
    })).toBe("slow");
    expect(classifyElectronClose({ elapsedMs: 1, forced: true })).toBe(
      "force-killed",
    );
  });

  it("tolerates one abnormal close, resets on health, and trips on two consecutive closes", () => {
    const oneSlow = advanceElectronShutdownCircuit(CLOSED_STATE, "slow");
    expect(oneSlow).toEqual({
      schemaVersion: 1,
      consecutiveAbnormalCloses: 1,
      open: false,
    });
    expect(advanceElectronShutdownCircuit(oneSlow, "healthy")).toEqual(
      CLOSED_STATE,
    );
    const open = advanceElectronShutdownCircuit(oneSlow, "force-killed");
    expect(open).toEqual({
      schemaVersion: 1,
      consecutiveAbnormalCloses: 2,
      open: true,
    });
    expect(advanceElectronShutdownCircuit(open, "healthy")).toBe(open);
  });

  it("persists the open circuit across Playwright worker replacement", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "shutdown-circuit-"));
    const stateFile = path.join(root, "state.json");
    try {
      expect(recordElectronShutdownCircuit({
        classification: "slow",
        enabled: true,
        stateFile,
      }).tripped).toBe(false);
      expect(recordElectronShutdownCircuit({
        classification: "force-killed",
        enabled: true,
        stateFile,
      })).toMatchObject({
        consecutiveAbnormalCloses: 2,
        tripped: true,
      });
      expect(() => assertElectronShutdownCircuitClosed({
        enabled: true,
        stateFile,
      })).toThrow(ElectronShutdownCircuitOpenError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records one close result when a launch is closed repeatedly", async () => {
    let closes = 0;
    const summary = trippedSummary();
    const closeOnce = memoizeElectronClose(async () => {
      closes += 1;
      return summary;
    });

    await expect(closeOnce()).resolves.toBe(summary);
    await expect(closeOnce()).resolves.toBe(summary);
    expect(closes).toBe(1);
  });

  it("force-kills only after the bounded graceful close and then waits for reaping", async () => {
    const order: string[] = [];
    let now = 100;
    const closePromise = Promise.resolve();

    const result = await executeElectronClose({
      now: () => now,
      requestQuit: async () => {
        order.push("request-quit");
      },
      startClose: () => {
        order.push("start-close");
        return closePromise;
      },
      waitForGracefulClose: async (promise) => {
        expect(promise).toBe(closePromise);
        order.push("wait-graceful");
        now = 6_100;
        return "timeout";
      },
      hasExited: () => {
        order.push("check-exit");
        return false;
      },
      forceKillTree: async () => {
        order.push("force-kill-tree");
      },
      waitForForcedExit: async () => {
        order.push("wait-forced-exit");
        now = 6_150;
        return true;
      },
      waitForPostKillClose: async () => {
        order.push("wait-post-kill-close");
      },
    });

    expect(order).toEqual([
      "request-quit",
      "start-close",
      "wait-graceful",
      "check-exit",
      "force-kill-tree",
      "wait-forced-exit",
      "wait-post-kill-close",
    ]);
    expect(result).toMatchObject({
      elapsedMs: 6_050,
      forced: true,
      forceExitOutcome: "exited",
    });
  });

  it("reports terminal, interrupted, and unobserved phases structurally", () => {
    const summary = buildElectronShutdownSummary({
      circuit: {
        enabled: true,
        consecutiveAbnormalCloses: 1,
        limit: 2,
        tripped: false,
      },
      classification: "force-killed",
      events: [
        phaseEvent("overall", "started", 0),
        phaseEvent("renderer-window", "completed", 8),
        phaseEvent("messaging", "started", 0),
        phaseEvent("federation", "started", 0),
        phaseEvent("mcp-connections", "completed", 12),
      ],
      execution: {
        elapsedMs: 6_100,
        forceExitOutcome: "exited",
        forced: true,
        gracefulCloseOutcome: "timeout",
        quitRequestOutcome: "rejected",
      },
      launchId: "launch-3",
    });

    expect(summary.phases).toEqual({
      rendererWindow: { durationMs: 8, outcome: "completed" },
      messaging: { durationMs: null, outcome: "interrupted" },
      federation: { durationMs: null, outcome: "interrupted" },
      mcpConnections: { durationMs: 12, outcome: "completed" },
      appServer: { durationMs: null, outcome: "not-observed" },
      overall: { durationMs: null, outcome: "interrupted" },
    });
  });

  it("raises a tripped circuit only after every cleanup step completes", async () => {
    const order: string[] = [];
    await expect(finalizeElectronFixtureTeardown({
      closeApplication: async () => {
        order.push("bounded-close");
        return trippedSummary();
      },
      cleanupProfileProcesses: async () => {
        order.push("profile-process-cleanup");
      },
      removeHomeRoot: async () => {
        order.push("remove-home-root");
      },
    })).rejects.toThrow(ElectronShutdownCircuitOpenError);
    expect(order).toEqual([
      "bounded-close",
      "profile-process-cleanup",
      "remove-home-root",
    ]);
  });
});

function phaseEvent(
  phase:
    | "overall"
    | "renderer-window"
    | "messaging"
    | "federation"
    | "mcp-connections",
  outcome: "started" | "completed",
  durationMs: number,
) {
  return {
    schemaVersion: 1 as const,
    kind: "phase" as const,
    launchId: "launch-3",
    phase,
    outcome,
    durationMs,
  };
}

function trippedSummary(): ElectronShutdownSummary {
  const phase = { durationMs: null, outcome: "not-observed" as const };
  return {
    schemaVersion: 1,
    kind: "close-summary",
    launchId: "launch-4",
    classification: "force-killed",
    elapsedMs: 6_100,
    quitRequestOutcome: "rejected",
    gracefulCloseOutcome: "timeout",
    forceExitOutcome: "exited",
    phases: {
      rendererWindow: phase,
      messaging: phase,
      federation: phase,
      mcpConnections: phase,
      appServer: phase,
      overall: phase,
    },
    circuit: {
      enabled: true,
      consecutiveAbnormalCloses: 2,
      limit: 2,
      tripped: true,
    },
  };
}
