export type AppServerBackendKind = "codex" | "grok";

export type ThreadIdentifier = string;

export type AppServerTextInputItem = {
  type: "text";
  text: string;
};

export type AppServerImageInputItem = {
  type: "image";
  url: string;
};

export type AppServerLocalImageInputItem = {
  type: "localImage";
  path: string;
};

export type AppServerTurnInputItem =
  | AppServerTextInputItem
  | AppServerImageInputItem
  | AppServerLocalImageInputItem;

export type LinkedDirectorySummary = {
  id: string;
  label: string;
  path: string;
  worktreePath?: string;
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

export type AppServerThreadMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: number;
};

export type AppServerThreadReplayPagination = {
  supportsPagination: boolean;
  hasPreviousPage: boolean;
  previousCursor?: string;
};

export type AppServerThreadReplay = {
  messages: AppServerThreadMessage[];
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pagination: AppServerThreadReplayPagination;
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
  before?: string;
  limit?: number;
};

export type AppServerReadThreadResponse = {
  backend: AppServerBackendKind;
  fetchedAt: number;
  threadId: ThreadIdentifier;
  replay: AppServerThreadReplay;
};

export type AppServerNotification =
  | {
      method: "turn/completed";
      params: {
        threadId: string;
        runId: string;
        turn: {
          id: string;
          status: "completed";
          output: Array<{
            type: "text";
            text: string;
          }>;
        };
      };
    }
  | {
      method: "turn/failed";
      params: {
        threadId: string;
        runId: string;
        turn: {
          id: string;
          status: "failed";
          error: {
            message: string;
          };
        };
      };
    }
  | {
      method: "turn/cancelled";
      params: {
        threadId: string;
        runId: string;
        turn: {
          id: string;
          status: "cancelled";
        };
      };
    }
  | {
      method: "item/started" | "item/completed";
      params: {
        threadId: string;
        runId?: string;
        item: {
          id: string;
          type: string;
          text?: string;
          review?: string;
        };
      };
    }
  | {
      method: "item/plan/delta";
      params: {
        threadId: string;
        runId?: string;
        item: {
          id: string;
          type: "plan";
        };
        delta: string;
      };
    }
  | {
      method: "turn/plan/updated";
      params: {
        threadId: string;
        runId: string;
        plan: {
          explanation?: string;
          steps: Array<{
            step: string;
            status: "pending" | "in_progress" | "completed";
          }>;
        };
      };
    }
  | {
      method: "serverRequest/resolved";
      params: {
        threadId: string;
        runId?: string;
        requestId: string;
      };
    }
  | {
      method: "thread/compacted";
      params: {
        threadId: string;
        itemId?: string;
      };
    };
