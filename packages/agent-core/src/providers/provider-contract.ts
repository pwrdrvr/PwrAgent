import type {
  AppServerCommandAction,
  AppServerTurnInputItem,
  AppServerRole,
  ThreadState,
} from "../app-server/protocol.js";
import type { ToolExecutor } from "../tools/tool-contract.js";

export type ProviderSource = {
  id?: string;
  sourceType?: string;
  url?: string;
  title?: string;
  providerMetadata?: Record<string, unknown>;
};

export type ProviderTurnParams = {
  thread: ThreadState;
  input: AppServerTurnInputItem[];
  history?: Array<{
    role: AppServerRole;
    text: string;
  }>;
  previousResponseId?: string;
  tools?: ToolExecutor;
};

export type ProviderSteerParams = {
  thread: ThreadState;
  runId: string;
  input: AppServerTurnInputItem[];
};

export type ProviderTurnResult = {
  assistantText?: string;
  providerResponseId?: string;
  sources?: ProviderSource[];
  providerMetadata?: Record<string, unknown>;
};

export type ProviderPlanStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

export type ProviderTurnEvent =
  | {
      type: "item_started" | "item_completed";
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
        sources?: ProviderSource[];
      };
    }
  | {
      type: "item_command_output_delta";
      itemId: string;
      delta: string;
      stream?: "stdout" | "stderr";
      bytes?: number;
    }
  | {
      type: "item_plan_delta";
      itemId: string;
      delta: string;
    }
  | {
      type: "turn_plan_updated";
      explanation?: string;
      steps: ProviderPlanStep[];
    }
  | {
      type: "request_input";
      requestId: string;
      method: string;
      params?: Record<string, unknown>;
      respond: (response: unknown) => void | Promise<void>;
    };

export type ProviderTurnEventListener = (
  event: ProviderTurnEvent,
) => void | Promise<void>;

export type ProviderActiveTurn = {
  result: Promise<ProviderTurnResult>;
  subscribe?: (listener: ProviderTurnEventListener) => () => void;
  steer?: (params: ProviderSteerParams) => Promise<void>;
  interrupt?: () => Promise<void>;
};

export interface AppServerProvider {
  startTurn(params: ProviderTurnParams): Promise<ProviderActiveTurn> | ProviderActiveTurn;
}
