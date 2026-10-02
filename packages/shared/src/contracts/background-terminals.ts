import type { AppServerBackendKind } from "./normalized-app-server";
import type { FederationTarget } from "./federation";

/** A live command owned by Codex, not a PwrAgent environment action. */
export type CodexBackgroundTerminal = {
  itemId: string;
  /** Opaque Codex session handle; never use it as an OS PID. */
  processId: string;
  command: string;
  cwd: string;
  osPid?: number;
  cpuPercent?: number;
  memoryKb?: number;
};

export type ListBackgroundTerminalsRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  federationTarget?: FederationTarget;
};

export type ListBackgroundTerminalsResponse = {
  supported: boolean;
  terminals: CodexBackgroundTerminal[];
};

export type TerminateBackgroundTerminalRequest = ListBackgroundTerminalsRequest & {
  processId: string;
};

export type TerminateBackgroundTerminalResponse = {
  terminated: boolean;
};
