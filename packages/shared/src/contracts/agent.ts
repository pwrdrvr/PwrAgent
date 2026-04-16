import type {
  AppServerBackendKind,
  AppServerNotification,
  AppServerTurnInputItem,
  ThreadIdentifier,
} from "./app-server";

export type StartThreadRequest = {
  backend: AppServerBackendKind;
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
};

export type StartThreadResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type StartTurnRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  input: AppServerTurnInputItem[];
  model?: string;
};

export type StartTurnResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  runId: string;
};

export type InterruptTurnRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  runId: string;
};

export type InterruptTurnResponse = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  runId: string;
};

export type AgentEvent = {
  backend: AppServerBackendKind;
  notification: AppServerNotification;
};
