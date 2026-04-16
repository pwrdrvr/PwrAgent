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
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
};

export type ThreadReplay = {
  threadId: string;
  messages: Array<{
    role: AppServerRole;
    text: string;
  }>;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
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
    };

export class AppServerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerProtocolError";
  }
}
