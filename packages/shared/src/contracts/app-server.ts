export type AppServerBackendKind = "codex" | "grok";

export type ThreadIdentifier = string;

export type LinkedDirectorySummary = {
  id: string;
  label: string;
  path: string;
  kind: "local" | "worktree";
};

export type AppServerThreadSummary = {
  id: ThreadIdentifier;
  title: string;
  summary?: string;
  createdAt?: number;
  updatedAt?: number;
  linkedDirectories: LinkedDirectorySummary[];
  gitBranch?: string;
  source: AppServerBackendKind;
};

export type AppServerThreadReplay = {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

export type AppServerListThreadsRequest = {
  backend?: AppServerBackendKind;
  filter?: string;
};

export type AppServerListThreadsResponse = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  threads: AppServerThreadSummary[];
};

export type AppServerReadThreadRequest = {
  backend?: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

export type AppServerReadThreadResponse = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  threadId: ThreadIdentifier;
  replay: AppServerThreadReplay;
};
