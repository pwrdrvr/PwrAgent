import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The one foreground-command core: "is a command running in this terminal, or
 * is it sitting at an idle prompt?"
 *
 * Both signals it can use — node-pty's foreground process name on macOS, and
 * `tpgid` from `/proc` on Linux — exist only on the machine the shell runs on.
 * So the local integrated-terminal service asks this directly at quit time,
 * and the federation PTY service asks it on the OWNER and reports the answer
 * to the viewer. A viewer with no answer keeps the conservative one, which is
 * why an unreported remote shell still blocks a quit.
 *
 * Every failure path returns `true`. Warning about a shell that turns out to
 * be idle costs a dialog; skipping one that is mid-build costs the build.
 */
export type TerminalForegroundProbe = {
  /** node-pty's `IPty.process`. Read lazily: it is a live getter. */
  processName: () => string;
  pid?: number;
  shell: string;
};

export type TerminalForegroundOptions = {
  platform: NodeJS.Platform;
  /** Injected by tests; both services otherwise share the default below. */
  readLinuxProcessStat?: (pid: number) => string;
  onError?: (error: unknown) => void;
};

export function readLinuxProcessStat(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

export function terminalHasForegroundCommand(
  probe: TerminalForegroundProbe,
  options: TerminalForegroundOptions,
): boolean {
  if (options.platform === "linux") {
    return hasLinuxForegroundCommand(probe, options);
  }

  // node-pty exposes the terminal's foreground process on macOS. Other
  // platforms return only the originally spawned process name, which cannot
  // distinguish an idle prompt from a running command. Keep the existing
  // conservative warning where the signal is unavailable.
  if (options.platform !== "darwin") {
    return true;
  }

  try {
    const activeProcess = normalizeTerminalProcessName(probe.processName());
    const shellProcess = normalizeTerminalProcessName(probe.shell);
    return !activeProcess || !shellProcess || activeProcess !== shellProcess;
  } catch (error) {
    options.onError?.(error);
    return true;
  }
}

function hasLinuxForegroundCommand(
  probe: TerminalForegroundProbe,
  options: TerminalForegroundOptions,
): boolean {
  try {
    if (probe.pid === undefined) {
      throw new Error("Linux process stat is unavailable");
    }
    const stat = (options.readLinuxProcessStat ?? readLinuxProcessStat)(
      probe.pid,
    );
    const closingParen = stat.lastIndexOf(")");
    const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
    // After pid and the parenthesized command name, Linux stat fields begin
    // at state (field 3); pgrp and tpgid are offsets 2 and 5 from there.
    const processGroupId = Number(fields[2]);
    const foregroundProcessGroupId = Number(fields[5]);
    if (
      closingParen < 0
      || !Number.isInteger(processGroupId)
      || processGroupId <= 0
      || !Number.isInteger(foregroundProcessGroupId)
      || foregroundProcessGroupId <= 0
    ) {
      throw new Error("Malformed Linux process stat");
    }
    return processGroupId !== foregroundProcessGroupId;
  } catch (error) {
    options.onError?.(error);
    return true;
  }
}

function normalizeTerminalProcessName(value: string): string {
  return path.basename(value.trim().replace(/^-+/, ""));
}
