import type {
  CelestialIconId,
  FederationRemoteTarget,
} from "@pwragent/shared";

export type IntegratedTerminalCreateRequest = {
  /**
   * The terminal to attach to. A pane that already has one passes it back so
   * a remount reattaches to its own shell rather than to whichever of the
   * thread's terminals happens to be oldest. When it names no live terminal
   * the shell is spawned UNDER this id, so a caller minting one gets a
   * terminal it can address from the first instant.
   *
   * Absent means "this thread's terminal": attach to the oldest live one,
   * spawn when the thread has none. That is what keeps the Star Map window
   * and the thread view — separate renderers, each mounting its own pane —
   * looking at one shell instead of two.
   */
  sessionId?: string;
  /** Grouping attribute, not identity: a thread can own several terminals. */
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
  /** Identity. Every operation on a live terminal is addressed by this. */
  sessionId: string;
  /** Which thread the terminal belongs to. Several may share one. */
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
  sessionId: string;
  hidden: boolean;
};

/**
 * Main → renderer: force one terminal's panel open (quit-dialog link).
 *
 * Addressed by terminal, not by thread: the row the operator clicked names a
 * specific shell, and a thread can own several. `threadKey` rides along so a
 * renderer can tell which thread's chrome to bring forward without another
 * lookup.
 */
export type IntegratedTerminalRevealEvent = {
  sessionId: string;
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

/**
 * `sessionId` closes exactly that terminal. `threadKey` closes every terminal
 * the thread owns — the only address a pane has before its create resolves,
 * and the one the thread view's close button uses.
 */
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
