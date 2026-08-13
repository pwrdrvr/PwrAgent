export type ShutdownPhase = {
  name: string;
  timeoutMs: number;
  run: () => Promise<void> | void;
};

export type ShutdownBarrierLogger = {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
};

export type ShutdownPhaseOutcome = {
  name: string;
  outcome: "completed" | "failed" | "timed-out" | "skipped";
  durationMs: number;
  error?: string;
};

export type ShutdownSummary = {
  source: string;
  durationMs: number;
  outcomes: ShutdownPhaseOutcome[];
};

export type ShutdownBarrierObserver = {
  phaseStarted?(phase: string): void;
  phaseFinished?(outcome: ShutdownPhaseOutcome): void;
};

export function createShutdownBarrier(options: {
  phases: ShutdownPhase[];
  globalTimeoutMs: number;
  logger: ShutdownBarrierLogger;
  now?: () => number;
  observer?: ShutdownBarrierObserver;
}): (source: string) => Promise<ShutdownSummary> {
  let shutdownPromise: Promise<ShutdownSummary> | undefined;
  return (source) => {
    shutdownPromise ??= runShutdownPhases({ ...options, source });
    return shutdownPromise;
  };
}

async function runShutdownPhases(options: {
  phases: ShutdownPhase[];
  globalTimeoutMs: number;
  logger: ShutdownBarrierLogger;
  now?: () => number;
  observer?: ShutdownBarrierObserver;
  source: string;
}): Promise<ShutdownSummary> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + options.globalTimeoutMs;
  const outcomes: ShutdownPhaseOutcome[] = [];
  options.logger.info("shutdown barrier started", {
    source: options.source,
    globalTimeoutMs: options.globalTimeoutMs,
  });

  for (const phase of options.phases) {
    const remainingMs = Math.max(0, deadline - now());
    if (remainingMs === 0) {
      const outcome: ShutdownPhaseOutcome = {
        name: phase.name,
        outcome: "skipped",
        durationMs: 0,
      };
      outcomes.push(outcome);
      options.observer?.phaseFinished?.(outcome);
      options.logger.warn("shutdown phase skipped after global deadline", {
        source: options.source,
        phase: phase.name,
      });
      continue;
    }

    const phaseStartedAt = now();
    const timeoutMs = Math.min(phase.timeoutMs, remainingMs);
    options.observer?.phaseStarted?.(phase.name);
    const result = await runPhase(phase.run, timeoutMs);
    const outcome: ShutdownPhaseOutcome = {
      name: phase.name,
      outcome: result.outcome,
      durationMs: Math.max(0, now() - phaseStartedAt),
      ...(result.error ? { error: result.error } : {}),
    };
    outcomes.push(outcome);
    options.observer?.phaseFinished?.(outcome);
    const detail = {
      source: options.source,
      phase: phase.name,
      timeoutMs,
      durationMs: outcome.durationMs,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    if (outcome.outcome === "completed") {
      options.logger.info("shutdown phase completed", detail);
    } else {
      options.logger.warn(`shutdown phase ${outcome.outcome}`, detail);
    }
  }

  const summary = {
    source: options.source,
    durationMs: Math.max(0, now() - startedAt),
    outcomes,
  };
  options.logger.info("shutdown barrier completed", summary);
  return summary;
}

async function runPhase(
  run: () => Promise<void> | void,
  timeoutMs: number,
): Promise<{
  outcome: "completed" | "failed" | "timed-out";
  error?: string;
}> {
  let timer: NodeJS.Timeout | undefined;
  const operation = Promise.resolve()
    .then(run)
    .then(
      () => ({ outcome: "completed" as const }),
      (error: unknown) => ({
        outcome: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  const outcome = await Promise.race([
    operation,
    new Promise<{ outcome: "timed-out" }>((resolve) => {
      timer = setTimeout(() => resolve({ outcome: "timed-out" }), timeoutMs);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}
