import type {
  AppServerCollaborationModeRequest,
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
} from "@pwragnt/shared";
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

  async listThreads(_params?: { filter?: string }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();
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

  async startTurn(_params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; runId: string }> {
    await this.ensureInitialized();
    return this.controller.consumeResponse("turn/start").result as {
      threadId: string;
      runId: string;
    };
  }

  async interruptTurn(_params?: {
    threadId: string;
    runId: string;
  }): Promise<{ threadId: string; runId: string }> {
    await this.ensureInitialized();
    return this.controller.consumeResponse("turn/interrupt").result as {
      threadId: string;
      runId: string;
    };
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
