import type { CodexEnvironmentSetupProgressEvent } from "@pwragent/shared";

export type LaunchpadEnvironmentSetupProgress = {
  sequence?: number;
  lastEventAt?: number;
  command: string;
  cwd?: string;
  directoryKey: string;
  durationMs?: number;
  environmentId: string;
  environmentName: string;
  error?: string;
  exitCode?: number;
  output: string;
  /** Owner start time, independent of viewer delivery/reconnect time. */
  startedAt?: number;
  status: "starting" | "running" | "completed" | "failed";
};

export function applyLaunchpadEnvironmentSetupProgress(
  current: LaunchpadEnvironmentSetupProgress | undefined,
  event: CodexEnvironmentSetupProgressEvent,
): LaunchpadEnvironmentSetupProgress {
  if (current?.directoryKey === event.directoryKey && current.environmentId === event.environmentId
    && event.sequence !== undefined && current.sequence !== undefined
    && event.sequence <= current.sequence) {
    if (event.sequence === current.sequence && event.output !== undefined && event.output !== current.output) {
      return { ...current, output: event.output, startedAt: event.startedAt ?? current.startedAt };
    }
    return current;
  }
  const base =
    event.phase !== "started" &&
    current?.directoryKey === event.directoryKey &&
    current.environmentId === event.environmentId
      ? current
      : {
          command: event.command,
          cwd: event.cwd,
          directoryKey: event.directoryKey,
          environmentId: event.environmentId,
          environmentName: event.environmentName,
          output: event.output ?? "",
          startedAt: event.startedAt ?? (event.durationMs !== undefined ? event.at - event.durationMs : event.at),
          status: "starting" as const,
        };
  const timed = { ...base, sequence: event.sequence, lastEventAt: event.at,
    startedAt: event.startedAt ?? base.startedAt };

  if (event.phase === "stdout" || event.phase === "stderr") {
    return {
      ...timed,
      output: event.output ?? `${base.output}${event.chunk ?? ""}`.slice(-32_000),
      status: "running",
    };
  }

  if (event.phase === "completed") {
    return {
      ...timed,
      durationMs: event.durationMs,
      exitCode: event.exitCode,
      output: event.output ?? base.output,
      status: "completed",
    };
  }

  if (event.phase === "failed") {
    return {
      ...timed,
      durationMs: event.durationMs,
      error: event.error,
      exitCode: event.exitCode,
      output: event.output ?? base.output,
      status: "failed",
    };
  }

  return {
    ...timed,
    status: "running",
  };
}
