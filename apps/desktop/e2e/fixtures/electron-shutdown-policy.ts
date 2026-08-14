import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  E2eShutdownPhase,
  E2eShutdownPhaseEvent,
} from "../../src/main/e2e-shutdown-diagnostics";

export const E2E_SHUTDOWN_CIRCUIT_BREAKER_ENV =
  "PWRAGENT_E2E_SHUTDOWN_CIRCUIT_BREAKER";
export const E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV =
  "PWRAGENT_E2E_SHUTDOWN_CIRCUIT_STATE_FILE";
export const ELECTRON_SHUTDOWN_CIRCUIT_ERROR_NAME =
  "ElectronShutdownCircuitOpenError";

/**
 * A healthy replay-backed app normally closes well below the renderer's own
 * 2s ceiling. Four seconds leaves a second full renderer budget for loaded
 * runners while still classifying a close before the harness's 6s force-kill.
 */
export const SLOW_ELECTRON_CLOSE_THRESHOLD_MS = 4_000;
/** One isolated abnormal close is tolerated; the second consecutive one trips. */
export const ABNORMAL_ELECTRON_CLOSE_LIMIT = 2;

export type ElectronCloseClassification =
  | "healthy"
  | "slow"
  | "force-killed";
export type ElectronCloseHandshakeOutcome = "closed" | "rejected" | "timeout";

export type ElectronCloseExecution = {
  elapsedMs: number;
  forceExitOutcome: "not-needed" | "exited" | "timed-out";
  forced: boolean;
  gracefulCloseOutcome: ElectronCloseHandshakeOutcome;
  quitRequestOutcome: "completed" | "rejected";
};

export type ElectronShutdownCircuitState = {
  schemaVersion: 1;
  consecutiveAbnormalCloses: number;
  open: boolean;
};

export type ElectronShutdownCircuitDecision = {
  enabled: boolean;
  consecutiveAbnormalCloses: number;
  limit: number;
  tripped: boolean;
};

export type ElectronShutdownPhaseSummary = {
  durationMs: number | null;
  outcome:
    | "completed"
    | "failed"
    | "timed-out"
    | "skipped"
    | "interrupted"
    | "not-observed";
};

export type ElectronShutdownSummary = {
  schemaVersion: 1;
  kind: "close-summary";
  launchId: string;
  classification: ElectronCloseClassification;
  elapsedMs: number;
  quitRequestOutcome: ElectronCloseExecution["quitRequestOutcome"];
  gracefulCloseOutcome: ElectronCloseHandshakeOutcome;
  forceExitOutcome: ElectronCloseExecution["forceExitOutcome"];
  phases: {
    rendererWindow: ElectronShutdownPhaseSummary;
    messaging: ElectronShutdownPhaseSummary;
    appServer: ElectronShutdownPhaseSummary;
    overall: ElectronShutdownPhaseSummary;
  };
  circuit: ElectronShutdownCircuitDecision;
};

export function memoizeElectronClose(
  closeApplication: () => Promise<ElectronShutdownSummary>,
): () => Promise<ElectronShutdownSummary> {
  let closePromise: Promise<ElectronShutdownSummary> | undefined;
  return () => {
    closePromise ??= closeApplication();
    return closePromise;
  };
}

type ElectronCloseActions = {
  forceKillTree(): Promise<void>;
  hasExited(): boolean;
  now(): number;
  requestQuit(): Promise<void>;
  startClose(): Promise<void>;
  waitForForcedExit(): Promise<boolean>;
  waitForGracefulClose(
    closePromise: Promise<void>,
  ): Promise<ElectronCloseHandshakeOutcome>;
  waitForPostKillClose(closePromise: Promise<void>): Promise<void>;
};

export async function executeElectronClose(
  actions: ElectronCloseActions,
): Promise<ElectronCloseExecution> {
  const startedAt = actions.now();
  let quitRequestOutcome: ElectronCloseExecution["quitRequestOutcome"] =
    "completed";
  try {
    await actions.requestQuit();
  } catch {
    quitRequestOutcome = "rejected";
  }

  let closePromise: Promise<void>;
  try {
    closePromise = actions.startClose();
  } catch {
    closePromise = Promise.reject(new Error("Electron close rejected"));
    closePromise.catch(() => undefined);
  }
  const gracefulCloseOutcome = await actions.waitForGracefulClose(closePromise);
  if (actions.hasExited()) {
    return {
      elapsedMs: normalizeDuration(actions.now() - startedAt),
      forceExitOutcome: "not-needed",
      forced: false,
      gracefulCloseOutcome,
      quitRequestOutcome,
    };
  }

  await actions.forceKillTree();
  const forcedExit = await actions.waitForForcedExit();
  await actions.waitForPostKillClose(closePromise);
  return {
    elapsedMs: normalizeDuration(actions.now() - startedAt),
    forceExitOutcome: forcedExit ? "exited" : "timed-out",
    forced: true,
    gracefulCloseOutcome,
    quitRequestOutcome,
  };
}

export function classifyElectronClose(
  execution: Pick<ElectronCloseExecution, "elapsedMs" | "forced"> & {
    shutdownElapsedMs?: number;
  },
): ElectronCloseClassification {
  if (execution.forced) {
    return "force-killed";
  }
  const elapsedMs = Math.max(
    execution.elapsedMs,
    execution.shutdownElapsedMs ?? 0,
  );
  if (elapsedMs >= SLOW_ELECTRON_CLOSE_THRESHOLD_MS) {
    return "slow";
  }
  return "healthy";
}

export function advanceElectronShutdownCircuit(
  state: ElectronShutdownCircuitState,
  classification: ElectronCloseClassification,
  limit = ABNORMAL_ELECTRON_CLOSE_LIMIT,
): ElectronShutdownCircuitState {
  if (state.open) {
    return state;
  }
  const consecutiveAbnormalCloses = classification === "healthy"
    ? 0
    : state.consecutiveAbnormalCloses + 1;
  return {
    schemaVersion: 1,
    consecutiveAbnormalCloses,
    open: consecutiveAbnormalCloses >= limit,
  };
}

export function recordElectronShutdownCircuit(params: {
  classification: ElectronCloseClassification;
  enabled: boolean;
  stateFile?: string;
}): ElectronShutdownCircuitDecision {
  if (!params.enabled || !params.stateFile) {
    return {
      enabled: false,
      consecutiveAbnormalCloses: 0,
      limit: ABNORMAL_ELECTRON_CLOSE_LIMIT,
      tripped: false,
    };
  }
  const previous = readCircuitState(params.stateFile);
  const next = advanceElectronShutdownCircuit(
    previous,
    params.classification,
  );
  writeCircuitState(params.stateFile, next);
  return {
    enabled: true,
    consecutiveAbnormalCloses: next.consecutiveAbnormalCloses,
    limit: ABNORMAL_ELECTRON_CLOSE_LIMIT,
    tripped: next.open,
  };
}

export function assertElectronShutdownCircuitClosed(params: {
  enabled: boolean;
  stateFile?: string;
}): void {
  if (!params.enabled || !params.stateFile) {
    return;
  }
  if (readCircuitState(params.stateFile).open) {
    throw new ElectronShutdownCircuitOpenError();
  }
}

export function resetElectronShutdownCircuit(
  stateFile: string | undefined,
): void {
  if (stateFile) {
    rmSync(stateFile, { force: true });
  }
}

export function buildElectronShutdownSummary(params: {
  circuit: ElectronShutdownCircuitDecision;
  classification: ElectronCloseClassification;
  events: E2eShutdownPhaseEvent[];
  execution: ElectronCloseExecution;
  launchId: string;
}): ElectronShutdownSummary {
  return {
    schemaVersion: 1,
    kind: "close-summary",
    launchId: params.launchId,
    classification: params.classification,
    elapsedMs: normalizeDuration(params.execution.elapsedMs),
    quitRequestOutcome: params.execution.quitRequestOutcome,
    gracefulCloseOutcome: params.execution.gracefulCloseOutcome,
    forceExitOutcome: params.execution.forceExitOutcome,
    phases: {
      rendererWindow: summarizePhase(params.events, "renderer-window"),
      messaging: summarizePhase(params.events, "messaging"),
      appServer: summarizePhase(params.events, "app-server"),
      overall: summarizePhase(params.events, "overall"),
    },
    circuit: params.circuit,
  };
}

export function observedOverallShutdownDuration(
  events: E2eShutdownPhaseEvent[],
): number | undefined {
  return [...events].reverse().find(
    (event) => event.phase === "overall" && event.outcome !== "started",
  )?.durationMs;
}

export function appendElectronShutdownSummary(
  filePath: string | undefined,
  summary: ElectronShutdownSummary,
): void {
  if (!filePath) {
    return;
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    // Lead with a newline so a force-killed, partially appended phase record
    // cannot swallow the parent-authored summary into the same invalid line.
    appendFileSync(filePath, `\n${JSON.stringify(summary)}\n`, "utf8");
  } catch {
    // Reporting must not replace the teardown result with an I/O failure.
  }
}

/**
 * Circuit failure is deliberately last: force-kill/profile cleanup and temp
 * directory removal must finish before Playwright is told to stop the lane.
 */
export async function finalizeElectronFixtureTeardown(params: {
  cleanupProfileProcesses(): Promise<void>;
  closeApplication(): Promise<ElectronShutdownSummary>;
  removeHomeRoot(): Promise<void>;
}): Promise<ElectronShutdownSummary> {
  const summary = await params.closeApplication();
  await params.cleanupProfileProcesses();
  await params.removeHomeRoot();
  if (summary.circuit.tripped) {
    throw new ElectronShutdownCircuitOpenError();
  }
  return summary;
}

export class ElectronShutdownCircuitOpenError extends Error {
  constructor() {
    super(
      [
        "Electron shutdown circuit opened after two consecutive abnormal closes;",
        "stopping this macOS E2E lane after deterministic cleanup.",
        "Recycle the cold runner guest before retrying.",
      ].join(" "),
    );
    this.name = ELECTRON_SHUTDOWN_CIRCUIT_ERROR_NAME;
  }
}

function summarizePhase(
  events: E2eShutdownPhaseEvent[],
  phase: E2eShutdownPhase,
): ElectronShutdownPhaseSummary {
  const matching = events.filter((event) => event.phase === phase);
  const terminal = [...matching].reverse().find(
    (event) => event.outcome !== "started",
  );
  if (terminal && terminal.outcome !== "started") {
    return {
      durationMs: normalizeDuration(terminal.durationMs),
      outcome: terminal.outcome,
    };
  }
  if (matching.some((event) => event.outcome === "started")) {
    return { durationMs: null, outcome: "interrupted" };
  }
  return { durationMs: null, outcome: "not-observed" };
}

function readCircuitState(stateFile: string): ElectronShutdownCircuitState {
  try {
    const value = JSON.parse(readFileSync(stateFile, "utf8")) as unknown;
    if (
      isRecord(value)
      && value.schemaVersion === 1
      && typeof value.consecutiveAbnormalCloses === "number"
      && Number.isInteger(value.consecutiveAbnormalCloses)
      && value.consecutiveAbnormalCloses >= 0
      && typeof value.open === "boolean"
    ) {
      return {
        schemaVersion: 1,
        consecutiveAbnormalCloses: value.consecutiveAbnormalCloses,
        open: value.open,
      };
    }
  } catch {
    // A missing or interrupted state file starts a new closed circuit.
  }
  return {
    schemaVersion: 1,
    consecutiveAbnormalCloses: 0,
    open: false,
  };
}

function writeCircuitState(
  stateFile: string,
  state: ElectronShutdownCircuitState,
): void {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporaryFile, stateFile);
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
