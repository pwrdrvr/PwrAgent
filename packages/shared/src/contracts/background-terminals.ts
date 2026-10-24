import type { AppServerBackendKind, AppServerBackgroundTask } from "./normalized-app-server";
import type { FederationTarget } from "./federation";

/** The original name, from when only Codex reported background commands. */
export type CodexBackgroundTerminal = AppServerBackgroundTask;

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
