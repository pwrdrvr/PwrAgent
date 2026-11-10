import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  BackendModelOption,
} from "@pwragent/shared";
import type { ReplayStepOverride } from "./replay-fixture";
export type ReplayRuntimeClient = {
  advance?(params?: {
    stepId?: string;
    override?: ReplayStepOverride;
  }): Promise<void>;
  close(): Promise<void>;
  getPendingRequest?(): AppServerPendingRequestNotification | undefined;
  getLastStartTurnParams?():
    | {
        threadId: string;
        input: AppServerTurnInputItem[];
        model?: string;
        collaborationMode?: AppServerCollaborationModeRequest;
        serviceTier?: string;
        reasoningEffort?: string;
        fastMode?: boolean;
      }
    | undefined;
  getLastStartReviewParams?():
    | {
        threadId: string;
        target: AppServerReviewTarget;
        delivery?: AppServerReviewDelivery;
      }
    | undefined;
  getLastRenameThreadParams?():
    | {
        threadId: string;
        name: string;
      }
    | undefined;
  getInterruptTurnCalls?(): Array<{
    threadId: string;
    turnId: string;
  }>;
  getInitializeResult(): Promise<{
    serverInfo?: {
      name?: string;
      version?: string;
    };
    methods?: string[];
  }>;
  listThreads(params?: {
    archived?: boolean;
    filter?: string;
  }): Promise<AppServerThreadSummary[]>;
  listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<AppServerListSkillsResponse["data"]>;
  listModels?(): Promise<BackendModelOption[]>;
  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void;
  onRequest(
    listener: (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  ): () => void;
  readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerReadThreadResponse["replay"]>;
  archiveThread?(params: {
    threadId: string;
  }): Promise<{ threadId: string }>;
  startThread(params: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }>;
  startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string }>;
  startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: AppServerReviewDelivery;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }>;
  interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  renameThread?(params: {
    threadId: string;
    name: string;
  }): Promise<{ threadId: string }>;
  updateThreadWorkspace?(params: {
    threadId: string;
    cwd: string;
  }): Promise<{ threadId: string }>;
  respondToPendingRequest?(requestId: string): Promise<void>;
};
export type OwnerReplayClients = { codexClient: ReplayRuntimeClient; defaultBackend: AppServerBackendKind };
