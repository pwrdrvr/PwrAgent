// What the managed-build progress strip says, as pure functions.
//
// Split out of the component for the same reason as the update banner's
// `update-progress.ts`: the interesting part is the wording and the
// arithmetic, and neither needs a DOM to be checked.

import {
  MANAGED_RUNTIME_INSTALL_PHASES,
  type ManagedRuntimeId,
  type ManagedRuntimeInstallPhase,
  type ManagedRuntimeProgress,
} from "../../../../shared/managed-runtime-progress";
import { formatByteCount } from "../../lib/format-bytes";

/** How long the finished strip stays up before it hands back to the status line. */
export const MANAGED_RUNTIME_READY_LINGER_MS = 6_000;

export type ManagedRuntimeStepState = "done" | "now" | "failed" | "todo";

export type ManagedRuntimeStep = {
  phase: ManagedRuntimeInstallPhase;
  label: string;
  state: ManagedRuntimeStepState;
};

export type ManagedRuntimeProgressTone = "busy" | "ok" | "error" | "notice";

export type ManagedRuntimeProgressCopy = {
  tone: ManagedRuntimeProgressTone;
  eyebrow: string;
  /** Release tag, shown beside the eyebrow once one is known. */
  tag: string | undefined;
  message: string | undefined;
  /** 0-100 for a determinate bar, `undefined` for the indeterminate sweep. */
  percent: number | undefined;
  /** A finished bar with nothing left to run. */
  full: boolean;
  /** Byte counts and rate, or `undefined` when there is nothing to meter. */
  meter: string | undefined;
  steps: ManagedRuntimeStep[] | undefined;
};

const STEP_LABELS: Record<ManagedRuntimeInstallPhase, string> = {
  downloading: "Download",
  verifying: "Verify",
  unpacking: "Unpack",
  activating: "Activate",
};

const RUNTIME_NAMES: Record<ManagedRuntimeId, string> = {
  codex: "pwrdrvr/codex",
  grok: "pwrdrvr/grok-build",
};

/** A finished or failed strip is stale once this much time has passed. */
export function isManagedRuntimeProgressVisible(
  progress: ManagedRuntimeProgress,
  now: number,
): boolean {
  if (progress.phase === "idle") return false;
  if (progress.phase === "ready") {
    return now - progress.updatedAt < MANAGED_RUNTIME_READY_LINGER_MS;
  }
  return true;
}

export function managedRuntimeSteps(
  progress: ManagedRuntimeProgress,
): ManagedRuntimeStep[] | undefined {
  if (progress.phase === "failed") {
    // A failure while checking has no install step to blame.
    if (progress.failedPhase === undefined || progress.failedPhase === "checking") {
      return undefined;
    }
  }
  if (progress.phase === "idle") return undefined;
  const at = progress.phase === "failed"
    ? MANAGED_RUNTIME_INSTALL_PHASES.indexOf(
        progress.failedPhase as ManagedRuntimeInstallPhase,
      )
    : progress.phase === "ready"
      ? MANAGED_RUNTIME_INSTALL_PHASES.length
      : progress.phase === "checking"
        ? 0
        : MANAGED_RUNTIME_INSTALL_PHASES.indexOf(progress.phase);
  return MANAGED_RUNTIME_INSTALL_PHASES.map((phase, index) => ({
    phase,
    label: STEP_LABELS[phase],
    state:
      index < at
        ? "done"
        : index === at
          ? progress.phase === "failed" ? "failed" : "now"
          : "todo",
  }));
}

/** "41.2 MB of 96.0 MB · 8.3 MB/s · about 7 s left", trimmed to what is known. */
export function managedRuntimeDownloadMeter(
  progress: ManagedRuntimeProgress,
): string | undefined {
  const received = progress.receivedBytes;
  if (received === undefined) return undefined;
  const total = progress.totalBytes;
  const parts = [
    total !== undefined && total > 0
      ? `${formatByteCount(received)} of ${formatByteCount(total)}`
      : formatByteCount(received),
  ];
  const rate = progress.bytesPerSecond;
  if (rate !== undefined && rate > 0) {
    parts.push(`${formatByteCount(Math.round(rate))}/s`);
    if (total !== undefined && total > received) {
      parts.push(`about ${formatEta((total - received) / rate)} left`);
    }
  }
  return parts.join(" · ");
}

function formatEta(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function managedRuntimeProgressCopy(
  progress: ManagedRuntimeProgress,
  waitingForIdle: boolean,
): ManagedRuntimeProgressCopy {
  const runtimeName = RUNTIME_NAMES[progress.runtime];
  const base = {
    tag: progress.tag,
    percent: undefined,
    full: false,
    meter: undefined,
    steps: managedRuntimeSteps(progress),
  } as const;
  switch (progress.phase) {
    case "checking":
      return {
        ...base,
        tone: "busy",
        eyebrow: "Checking for a build",
        message: `Asking GitHub for the latest ${runtimeName} release…`,
      };
    case "downloading": {
      const { receivedBytes, totalBytes } = progress;
      return {
        ...base,
        tone: "busy",
        eyebrow: "Downloading",
        message: undefined,
        percent:
          receivedBytes !== undefined && totalBytes !== undefined && totalBytes > 0
            ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
            : undefined,
        meter: managedRuntimeDownloadMeter(progress),
      };
    }
    case "verifying":
      return {
        ...base,
        tone: "busy",
        eyebrow: "Verifying",
        message: "Checking the SHA-256 and the signature…",
      };
    case "unpacking":
      return {
        ...base,
        tone: "busy",
        eyebrow: "Unpacking",
        message: "Extracting the archive and checking the bundle…",
      };
    case "activating":
      return {
        ...base,
        tone: "busy",
        eyebrow: "Activating",
        message: "Moving the verified build into place…",
      };
    case "ready":
      return waitingForIdle
        ? {
            ...base,
            tone: "notice",
            eyebrow: "Downloaded · waiting for idle",
            message:
              "Installed and verified. It takes over after active Codex turns finish.",
            full: true,
          }
        : {
            ...base,
            tone: "ok",
            eyebrow: "Installed",
            message: "Verified and ready.",
          };
    case "failed":
      return progress.fallbackTag
        ? {
            ...base,
            tone: "notice",
            eyebrow: "Could not check for updates",
            tag: progress.fallbackTag,
            message: `Still using the installed build. ${progress.error ?? ""}`.trim(),
            steps: undefined,
          }
        : {
            ...base,
            tone: "error",
            eyebrow: progress.failedPhase === "checking"
              ? "Could not find a build"
              : "Download failed",
            message: `${progress.error ?? "Nothing was installed."}`,
          };
    case "idle":
      return {
        ...base,
        tone: "ok",
        eyebrow: "",
        message: undefined,
        steps: undefined,
      };
  }
}
