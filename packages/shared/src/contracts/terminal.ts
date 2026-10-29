import type { CelestialIconId } from "./celestial";

/** Identity of the instance a remote terminal session runs on. */
export type IntegratedTerminalRemoteInfo = {
  instanceId: string;
  instanceLabel: string;
  celestialIcon?: CelestialIconId;
};

/**
 * Main-process view of one live PTY. The main process is the sole owner of
 * terminal lifetime; the renderer mirrors this list rather than tracking
 * terminals in component state, so a `ThreadView` unmount (search view, a
 * refresh that transiently drops the selected thread) can no longer orphan a
 * running shell.
 *
 * `panelHidden` lives here for the same reason: "the user deliberately
 * collapsed this terminal" has to outlive the component that rendered it, or
 * every remount would either lose the preference or pop the panel back open.
 */
export type IntegratedTerminalSessionSummary = {
  /** Identity. Every operation on a live terminal is addressed by this. */
  sessionId: string;
  /** Which thread the terminal belongs to. Several may share one. */
  threadKey: string;
  cwd: string;
  shell: string;
  pid?: number;
  panelHidden: boolean;
  createdAt: number;
  name?: string;
  status?: "running" | "exited" | "restored";
  exitCode?: number | null;
  /** Present when the shell runs on another instance over federation. */
  remote?: IntegratedTerminalRemoteInfo;
};


export type TerminalSnapshot = {
  data: string;
  /** Live attach only; excluded from persisted history. */
  pendingEscape?: string;
  seq: number;
  timestamp: number;
  cols: number;
  rows: number;
  truncated: boolean;
};

