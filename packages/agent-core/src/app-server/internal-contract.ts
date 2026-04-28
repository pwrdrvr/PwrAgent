import type {
  AppServerCommandAction,
  AppServerImageInputItem,
  AppServerLocalImageInputItem,
  AppServerSource,
  AppServerTextInputItem,
  AppServerTurnInputItem,
} from "@pwragnt/shared";

export type {
  AppServerCommandAction,
  AppServerImageInputItem,
  AppServerLocalImageInputItem,
  AppServerSource,
  AppServerTextInputItem,
  AppServerTurnInputItem,
};

export const APP_SERVER_PROTOCOL_VERSION = "1.0" as const;

export type AppServerRole = "user" | "assistant";

export type AppServerTurnInput = {
  threadId: string;
  input: AppServerTurnInputItem[];
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
};

export type ThreadTitleSource = "explicit" | "derived" | "fallback";

export type ThreadState = {
  threadId: string;
  threadName?: string;
  firstUserMessage?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  archived?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type ThreadSummary = {
  threadId: string;
  title: string;
  titleSource: ThreadTitleSource;
  summary?: string;
  projectKey?: string;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type ThreadReplay = {
  threadId: string;
  thread: ThreadState;
  messages: Array<{
    role: AppServerRole;
    text: string;
    parts?: AppServerTurnInputItem[];
  }>;
  items: ThreadReplayItem[];
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

export type AppServerItemStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type ThreadReplayItem = {
  id: string;
  type: string;
  status?: AppServerItemStatus;
  role?: AppServerRole;
  text?: string;
  parts?: AppServerTurnInputItem[];
  review?: string;
  command?: string;
  commandAction?: AppServerCommandAction;
  toolName?: string;
  success?: boolean;
  arguments?: Record<string, unknown>;
  data?: Record<string, unknown>;
  sources?: AppServerSource[];
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
  shortDescription?: string;
  path?: string;
  enabled?: boolean;
  scope?: string;
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
  turnId: string;
};

export type AppServerNotification =
  | {
      method: "turn/started";
      params: {
        threadId: string;
        turnId?: string;
        turn: {
          id: string;
          status?: string;
        };
      };
    }
  | {
      method: "turn/completed";
      params: {
        threadId: string;
        turnId: string;
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
        turnId: string;
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
        turnId: string;
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
        turnId?: string;
        item: {
          id: string;
          type: string;
          text?: string;
          review?: string;
          command?: string;
          commandAction?: AppServerCommandAction;
          toolName?: string;
          success?: boolean;
          arguments?: Record<string, unknown>;
          data?: Record<string, unknown>;
          sources?: AppServerSource[];
        };
      };
    }
  | {
      method: "item/commandExecution/outputDelta";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        delta: string;
        stream?: "stdout" | "stderr";
        bytes?: number;
      };
    }
  | {
      method: "item/fileChange/outputDelta";
      params: {
        threadId: string;
        turnId?: string;
        itemId: string;
        delta: string;
      };
    }
  | {
      method: "thread/archived";
      params: {
        threadId: string;
      };
    }
  | {
      method: "thread/unarchived";
      params: {
        threadId: string;
      };
    }
  | {
      method: "item/plan/delta";
      params: {
        threadId: string;
        turnId?: string;
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
        turnId: string;
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
      method: "turn/diff/updated";
      params: {
        threadId: string;
        turnId?: string;
        diff: string;
      };
    }
  | {
      method: "serverRequest/resolved";
      params: {
        threadId: string;
        turnId?: string;
        requestId: string;
      };
    }
  | {
      method: "thread/name/updated";
      params: {
        threadId: string;
        threadName?: string;
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
