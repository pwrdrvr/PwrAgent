import type { CodexEnvironmentSetupProgressEvent } from "@pwragent/shared";

export type LaunchpadEnvironmentSetupProgress = {
  command: string;
  cwd?: string;
  directoryKey: string;
  durationMs?: number;
  environmentId: string;
  environmentName: string;
  error?: string;
  exitCode?: number;
  output: string;
  status: "starting" | "running" | "completed" | "failed";
};

export function applyLaunchpadEnvironmentSetupProgress(
  current: LaunchpadEnvironmentSetupProgress | undefined,
  event: CodexEnvironmentSetupProgressEvent,
): LaunchpadEnvironmentSetupProgress {
  const base =
    current?.directoryKey === event.directoryKey &&
    current.environmentId === event.environmentId
      ? current
      : {
          command: event.command,
          cwd: event.cwd,
          directoryKey: event.directoryKey,
          environmentId: event.environmentId,
          environmentName: event.environmentName,
          output: "",
          status: "starting" as const,
        };

  if (event.phase === "stdout" || event.phase === "stderr") {
    return {
      ...base,
      output: `${base.output}${event.chunk ?? ""}`.slice(-32_000),
      status: "running",
    };
  }

  if (event.phase === "completed") {
    return {
      ...base,
      durationMs: event.durationMs,
      exitCode: event.exitCode,
      output: event.output ?? base.output,
      status: "completed",
    };
  }

  if (event.phase === "failed") {
    return {
      ...base,
      durationMs: event.durationMs,
      error: event.error,
      exitCode: event.exitCode,
      output: event.output ?? base.output,
      status: "failed",
    };
  }

  return {
    ...base,
    status: "running",
  };
}
