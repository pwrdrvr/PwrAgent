export const APP_SERVER_PROTOCOL_VERSION = "1.0" as const;

export type AppServerRole = "user" | "assistant";

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

export type AppServerTurnInput = {
  threadId: string;
  input: AppServerTurnInputItem[];
  model?: string;
};

export type ThreadState = {
  threadId: string;
  threadName?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type ThreadSummary = {
  threadId: string;
  title?: string;
  summary?: string;
  projectKey?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type ThreadReplay = {
  threadId: string;
  thread: ThreadState;
  messages: Array<{
    role: AppServerRole;
    text: string;
  }>;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

export type ModelSummary = {
  id: string;
  label?: string;
  description?: string;
  current?: boolean;
  supportsReasoning?: boolean;
  supportsFast?: boolean;
  provider?: string;
};

export type SkillSummary = {
  cwd?: string;
  name: string;
  description?: string;
  enabled?: boolean;
};

export type ExperimentalFeatureSummary = {
  name: string;
  stage?: string;
  displayName?: string;
  description?: string;
  enabled?: boolean;
  defaultEnabled?: boolean;
};

export type McpServerSummary = {
  name: string;
  authStatus?: string;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
};

export type RateLimitSummary = {
  name: string;
  limitId?: string;
  remaining?: number;
  limit?: number;
  used?: number;
  usedPercent?: number;
  resetAt?: number;
  windowSeconds?: number;
  windowMinutes?: number;
};

export type AccountSummary = {
  account: {
    type?: "apiKey" | "chatgpt";
    email?: string;
    planType?: string;
  };
  requiresOpenaiAuth?: boolean;
};

export type AppServerInitializeResult = {
  protocolVersion: typeof APP_SERVER_PROTOCOL_VERSION;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
  };
  methods: string[];
};

export type AppServerTurnResult = {
  threadId: string;
  runId: string;
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

export class AppServerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerProtocolError";
  }
}
