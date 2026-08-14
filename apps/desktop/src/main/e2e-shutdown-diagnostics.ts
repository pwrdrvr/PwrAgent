import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV =
  "PWRAGENT_E2E_SHUTDOWN_DIAGNOSTICS_FILE";
export const E2E_SHUTDOWN_LAUNCH_ID_ENV =
  "PWRAGENT_E2E_SHUTDOWN_LAUNCH_ID";

export const E2E_SHUTDOWN_PHASES = [
  "overall",
  "renderer-window",
  "messaging",
  "app-server",
] as const;

export type E2eShutdownPhase = (typeof E2E_SHUTDOWN_PHASES)[number];
export type E2eShutdownPhaseOutcome =
  | "started"
  | "completed"
  | "failed"
  | "timed-out"
  | "skipped";

export type E2eShutdownPhaseEvent = {
  schemaVersion: 1;
  kind: "phase";
  launchId: string;
  phase: E2eShutdownPhase;
  outcome: E2eShutdownPhaseOutcome;
  durationMs: number;
};

type E2eShutdownDiagnosticsRecorder = {
  beginOverall(): void;
  beginPhase(phase: Exclude<E2eShutdownPhase, "overall">): void;
  finishOverall(outcome: Exclude<E2eShutdownPhaseOutcome, "started">): void;
  finishPhase(
    phase: Exclude<E2eShutdownPhase, "overall">,
    outcome: Exclude<E2eShutdownPhaseOutcome, "started">,
    durationMs: number,
  ): void;
};

type E2eShutdownDiagnosticsRecorderOptions = {
  enabled: boolean;
  filePath?: string;
  launchId?: string;
  now?: () => number;
  writeLine?: (line: string) => void;
};

/**
 * Record the E2E-only shutdown timeline without copying normal app logs into
 * CI. Every persisted field is an allowlisted enum, opaque launch id, or
 * elapsed millisecond count: no paths, usernames, commands, or error strings
 * can cross this boundary.
 */
export function createE2eShutdownDiagnosticsRecorder(
  options: E2eShutdownDiagnosticsRecorderOptions,
): E2eShutdownDiagnosticsRecorder {
  const now = options.now ?? performance.now.bind(performance);
  const writeLine = options.writeLine
    ?? createFileLineWriter(options.enabled ? options.filePath : undefined);
  const launchId = normalizeLaunchId(options.launchId);
  const enabled =
    options.enabled
    && launchId !== undefined
    && writeLine !== undefined;
  let overallStartedAt: number | undefined;

  const write = (
    phase: E2eShutdownPhase,
    outcome: E2eShutdownPhaseOutcome,
    durationMs: number,
  ): void => {
    if (!enabled || launchId === undefined || writeLine === undefined) {
      return;
    }
    const event: E2eShutdownPhaseEvent = {
      schemaVersion: 1,
      kind: "phase",
      launchId,
      phase,
      outcome,
      durationMs: normalizeDuration(durationMs),
    };
    try {
      writeLine(`${JSON.stringify(event)}\n`);
    } catch {
      // Diagnostics must never delay or block the shutdown they observe.
    }
  };

  return {
    beginOverall: () => {
      if (overallStartedAt !== undefined) {
        return;
      }
      overallStartedAt = now();
      write("overall", "started", 0);
    },
    beginPhase: (phase) => {
      write(phase, "started", 0);
    },
    finishOverall: (outcome) => {
      const startedAt = overallStartedAt ?? now();
      write("overall", outcome, now() - startedAt);
    },
    finishPhase: (phase, outcome, durationMs) => {
      write(phase, outcome, durationMs);
    },
  };
}

export function readE2eShutdownPhaseEvents(
  filePath: string | undefined,
  launchId: string,
): E2eShutdownPhaseEvent[] {
  if (!filePath) {
    return [];
  }
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: E2eShutdownPhaseEvent[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = parseE2eShutdownPhaseEvent(JSON.parse(line));
      if (event?.launchId === launchId) {
        events.push(event);
      }
    } catch {
      // A force-kill can interrupt the final append. Earlier complete lines
      // remain useful and identify the phase that was interrupted.
    }
  }
  return events;
}

function createFileLineWriter(
  filePath: string | undefined,
): ((line: string) => void) | undefined {
  if (!filePath) {
    return undefined;
  }
  return (line) => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, line, "utf8");
  };
}

function parseE2eShutdownPhaseEvent(
  value: unknown,
): E2eShutdownPhaseEvent | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "phase") {
    return undefined;
  }
  const launchId = normalizeLaunchId(value.launchId);
  if (
    launchId === undefined
    || !isShutdownPhase(value.phase)
    || !isShutdownPhaseOutcome(value.outcome)
    || typeof value.durationMs !== "number"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    kind: "phase",
    launchId,
    phase: value.phase,
    outcome: value.outcome,
    durationMs: normalizeDuration(value.durationMs),
  };
}

function normalizeLaunchId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function isShutdownPhase(value: unknown): value is E2eShutdownPhase {
  return typeof value === "string"
    && E2E_SHUTDOWN_PHASES.includes(value as E2eShutdownPhase);
}

function isShutdownPhaseOutcome(
  value: unknown,
): value is E2eShutdownPhaseOutcome {
  return value === "started"
    || value === "completed"
    || value === "failed"
    || value === "timed-out"
    || value === "skipped";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
