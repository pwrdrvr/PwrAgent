import type {
  AppServerCollaborationModeRequest,
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
} from "@pwragent/shared";
import { ReplayController } from "./replay-controller";
import {
  asInitializeResult,
  asSkillList,
  asThreadList,
  asThreadReplay,
  type ReplayFixture,
  type ReplayStepOverride,
} from "./replay-fixture";

type InitializeResult = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
};

export class ReplayClient {
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private readonly requestListeners = new Set<
    (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  >();
  private initializeResult?: InitializeResult;
  private initializePromise?: Promise<InitializeResult>;
  private lastStartTurnParams?: {
    threadId: string;
    input: AppServerTurnInputItem[];
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  };
  private lastStartReviewParams?: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: AppServerReviewDelivery;
  };
  private lastRenameThreadParams?: {
    threadId: string;
    name: string;
  };
  private readonly interruptTurnCalls: Array<{
    threadId: string;
    turnId: string;
  }> = [];

  constructor(private readonly controller: ReplayController) {}

  static fromFixture(fixture: ReplayFixture): ReplayClient {
    return new ReplayClient(new ReplayController(fixture));
  }

  async close(): Promise<void> {
    return;
  }

  async getInitializeResult(): Promise<InitializeResult> {
    return await this.ensureInitialized();
  }

  async listThreads(_params?: {
    archived?: boolean;
    filter?: string;
  }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();
    if (_params?.archived) {
      return [];
    }
    return asThreadList(this.controller.consumeResponse("thread/list").result);
  }

  async listSkills(_params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<AppServerListSkillsResponse["data"]> {
    await this.ensureInitialized();
    return asSkillList(this.controller.consumeResponse("skills/list").result);
  }

  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onRequest(
    listener: (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  ): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  async readThread(_params?: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerReadThreadResponse["replay"]> {
    await this.ensureInitialized();
    return asThreadReplay(this.controller.consumeResponse("thread/read").result);
  }

  async archiveThread(params: {
    threadId: string;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();
    return this.controller.consumeResponse("thread/archive").result as {
      threadId: string;
    };
  }

  async startThread(_params?: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();
    return this.controller.consumeResponse("thread/start").result as {
      threadId: string;
    };
  }

  async startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.ensureInitialized();
    this.lastStartTurnParams = params;
    return this.controller.consumeResponse("turn/start").result as {
      threadId: string;
      turnId: string;
    };
  }

  async startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: AppServerReviewDelivery;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    await this.ensureInitialized();
    this.lastStartReviewParams = params;
    return this.controller.consumeResponse("review/start").result as {
      threadId: string;
      reviewThreadId: string;
      turnId: string;
    };
  }

  async interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.ensureInitialized();
    this.interruptTurnCalls.push({
      threadId: params.threadId,
      turnId: params.turnId,
    });
    return this.controller.consumeResponse("turn/interrupt").result as {
      threadId: string;
      turnId: string;
    };
  }

  async setThreadPermissions(params: {
    threadId: string;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();
    return { threadId: params.threadId };
  }

  async renameThread(params: {
    threadId: string;
    name: string;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();
    this.lastRenameThreadParams = params;
    return { threadId: params.threadId };
  }

  async advance(params: {
    stepId?: string;
    override?: ReplayStepOverride;
  } = {}): Promise<void> {
    const step = this.controller.advance(params);
    if (step.kind === "notification") {
      for (const listener of this.notificationListeners) {
        await listener(step.notification);
      }
      return;
    }

    const pendingListeners = [...this.requestListeners];
    for (const listener of pendingListeners) {
      void Promise.resolve(listener(step.request)).then(async () => {
        this.controller.resolvePendingRequest(step.request.params.requestId);
      });
    }
  }

  getPendingRequest(): AppServerPendingRequestNotification | undefined {
    return this.controller.getPendingRequest()?.request;
  }

  getLastStartTurnParams():
    | {
        threadId: string;
        input: AppServerTurnInputItem[];
        cwd?: string;
        model?: string;
        approvalPolicy?: string;
        sandbox?: string;
        collaborationMode?: AppServerCollaborationModeRequest;
        serviceTier?: string;
        reasoningEffort?: string;
        fastMode?: boolean;
      }
    | undefined {
    return this.lastStartTurnParams;
  }

  getLastStartReviewParams():
    | {
        threadId: string;
        target: AppServerReviewTarget;
        delivery?: AppServerReviewDelivery;
      }
    | undefined {
    return this.lastStartReviewParams;
  }

  getLastRenameThreadParams():
    | {
        threadId: string;
        name: string;
      }
    | undefined {
    return this.lastRenameThreadParams;
  }

  getInterruptTurnCalls(): Array<{
    threadId: string;
    turnId: string;
  }> {
    return [...this.interruptTurnCalls];
  }

  async respondToPendingRequest(requestId: string): Promise<void> {
    this.controller.resolvePendingRequest(requestId);
  }

  private async ensureInitialized(): Promise<InitializeResult> {
    if (this.initializeResult) {
      return this.initializeResult;
    }

    if (!this.initializePromise) {
      this.initializePromise = Promise.resolve(
        asInitializeResult(this.controller.consumeResponse("initialize").result)
      ).then((result) => {
        this.initializeResult = result;
        return result;
      });
    }

    return await this.initializePromise;
  }
}
