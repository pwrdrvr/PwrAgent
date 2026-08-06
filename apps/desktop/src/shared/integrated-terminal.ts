import type {
  CelestialIconId,
  FederationRemoteTarget,
} from "@pwragent/shared";

export type IntegratedTerminalCreateRequest = {
  threadKey: string;
  cwd?: string;
  cols: number;
  rows: number;
  /**
   * Owning instance for a remote thread's terminal opened from the MAIN
   * window. The shell runs on that instance (it resolves shell + cwd from
   * its own thread state); without this the request spawns locally. In a
   * federation window the window's own target stays authoritative and this
   * field is ignored.
   */
  federationTarget?: FederationRemoteTarget;
};

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
  sessionId: string;
  threadKey: string;
  cwd: string;
  shell: string;
  pid?: number;
  panelHidden: boolean;
  createdAt: number;
  /** Present when the shell runs on another instance over federation. */
  remote?: IntegratedTerminalRemoteInfo;
};

export type IntegratedTerminalSessionsEvent = {
  sessions: IntegratedTerminalSessionSummary[];
};

export type IntegratedTerminalSetPanelHiddenRequest = {
  threadKey: string;
  hidden: boolean;
};

/** Main → renderer: force a thread's terminal panel open (quit-dialog link). */
export type IntegratedTerminalRevealEvent = {
  threadKey: string;
};

export type IntegratedTerminalCreateResponse = {
  sessionId: string;
  threadKey: string;
  cwd: string;
  shell: string;
  pid?: number;
  buffer?: string;
};

export type IntegratedTerminalWriteRequest = {
  sessionId: string;
  data: string;
};

export type IntegratedTerminalResizeRequest = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type IntegratedTerminalCloseRequest = {
  sessionId?: string;
  threadKey?: string;
};

export type IntegratedTerminalOutputEvent = {
  sessionId: string;
  data: string;
};

export type IntegratedTerminalExitEvent = {
  sessionId: string;
  exitCode: number | null;
  signal: number | string | null;
};

export type IntegratedTerminalErrorEvent = {
  sessionId?: string;
  message: string;
};
