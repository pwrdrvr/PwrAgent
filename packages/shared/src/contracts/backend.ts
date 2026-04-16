import type { AppServerBackendKind } from "./app-server";

export type BackendCapabilities = {
  listThreads: boolean;
  createThread: boolean;
  resumeThread: boolean;
  readThread: boolean;
  startTurn: boolean;
  interruptTurn: boolean;
  steerTurn: boolean;
  transcriptPagination: boolean;
  toolUse: boolean;
  approvalRequests: boolean;
  multiDirectoryThreads: boolean;
};

export type BackendSummary = {
  kind: AppServerBackendKind;
  label: string;
  available: boolean;
  serverName?: string;
  serverVersion?: string;
  methods: string[];
  capabilities: BackendCapabilities;
  unavailableReason?: string;
};

export type ListBackendsRequest = {
  includeUnavailable?: boolean;
};

export type ListBackendsResponse = {
  fetchedAt: number;
  backends: BackendSummary[];
};
