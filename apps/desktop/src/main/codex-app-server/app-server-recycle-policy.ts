/**
 * When PwrAgent replaces a long-lived Codex app server that is doing nothing.
 *
 * A stdio `codex app-server` starts MCP servers for the threads it loads. A
 * leak in that path once kept 557 MCP children alive for 25 hours, and their
 * pipes exhausted the Mac's kernel pipe memory. Replacing an idle server
 * bounds how long any such leak can grow, whichever backend causes it.
 *
 * The rule, in full:
 *
 * - The server must be quiescent for `idleMs`: no turn, approval, user-input
 *   request, helper turn, voice session, background terminal or in-flight RPC,
 *   and no message from Codex in that window. The caller checks that; this
 *   module only names the reason.
 * - It must have run for at least `minUptimeMs`, so a resource limit set too
 *   low cannot restart a fresh server over and over.
 * - Then any one of these restarts it: uptime of `maxUptimeMs` or more,
 *   `maxChildProcesses` or more descendant processes, or `maxOpenFds` or more
 *   open file descriptors (where the platform reports them).
 *
 * Pure: no timers, no I/O, no SQLite writes.
 */
export type CodexAppServerRecycleSettings = {
  enabled: boolean;
  idleMs: number;
  maxUptimeMs: number;
  maxChildProcesses: number;
  maxOpenFds: number;
  minUptimeMs: number;
};

export const DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS: CodexAppServerRecycleSettings = {
  enabled: true,
  idleMs: 20 * 60_000,
  maxUptimeMs: 8 * 60 * 60_000,
  maxChildProcesses: 64,
  maxOpenFds: 1_024,
  minUptimeMs: 30 * 60_000,
};

/** One reading of the running app server. Counts are absent where unknown. */
export type CodexAppServerProcessSample = {
  pid: number;
  startedAt: number;
  sampledAt: number;
  uptimeMs: number;
  /** Every descendant, not only direct children. */
  childProcessCount?: number;
  openFdCount?: number;
};

export type CodexAppServerRecycleReason = "uptime" | "child-processes" | "open-fds";

export function decideCodexAppServerRecycle(
  settings: CodexAppServerRecycleSettings,
  sample: CodexAppServerProcessSample,
): CodexAppServerRecycleReason[] {
  if (!settings.enabled || sample.uptimeMs < settings.minUptimeMs) return [];
  const reasons: CodexAppServerRecycleReason[] = [];
  if (sample.uptimeMs >= settings.maxUptimeMs) reasons.push("uptime");
  if (sample.childProcessCount !== undefined
    && sample.childProcessCount >= settings.maxChildProcesses) {
    reasons.push("child-processes");
  }
  if (sample.openFdCount !== undefined && sample.openFdCount >= settings.maxOpenFds) {
    reasons.push("open-fds");
  }
  return reasons;
}

/** How often to look again. Shorter idle windows are checked more often. */
export function codexAppServerRecycleCheckIntervalMs(
  settings: CodexAppServerRecycleSettings,
): number {
  return Math.min(5 * 60_000, Math.max(30_000, Math.round(settings.idleMs / 4)));
}

export type CodexAppServerRecycleRecord = {
  at: number;
  reasons: CodexAppServerRecycleReason[];
  pid: number;
  uptimeMs: number;
  idleMs: number;
  childProcessCount?: number;
  openFdCount?: number;
  /** Descendants still alive after the process group stopped, then killed. */
  orphansReaped?: number;
};

export type CodexAppServerRecycleOutcome =
  | { kind: "recycled"; record: CodexAppServerRecycleRecord }
  | { kind: "not-running" }
  | { kind: "busy"; blocker: string }
  | { kind: "not-idle"; idleMs: number }
  | { kind: "healthy"; sample: CodexAppServerProcessSample };

export type CodexAppServerRecycleStatus = {
  recycleCount: number;
  lastRecycle?: CodexAppServerRecycleRecord;
  lastCheck?: { at: number; outcome: CodexAppServerRecycleOutcome["kind"]; blocker?: string };
};
