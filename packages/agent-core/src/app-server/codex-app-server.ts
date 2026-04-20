import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerProtocolError,
  type AppServerInitializeResult,
  type AppServerNotification,
  type AppServerTurnInput,
  type AppServerTurnInputItem,
  type AppServerTurnResult,
  type ThreadReplay,
  type ThreadState,
} from "./protocol.js";
import { AppServerSessionState } from "./session-state.js";
import { AppServerMetadataService } from "./metadata-service.js";
import { TurnRunner } from "./turn-runner.js";
import { CompactionRunner } from "./compaction-runner.js";
import { ReviewRunner } from "./review-runner.js";
import type { AppServerProvider } from "../providers/provider-contract.js";
import { createDefaultToolRegistry } from "../tools/tool-registry.js";
import { LocalToolExecutor } from "../tools/tool-execution.js";

type NotificationHandler = (
  notification: AppServerNotification,
) => void | Promise<void>;

type RequestHandler = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown> | unknown;

type ServerOptions = {
  provider: AppServerProvider;
  threadIdGenerator?: () => string;
  runIdGenerator?: () => string;
  sessionState?: AppServerSessionState;
};

const SUPPORTED_METHODS = [
  "initialize",
  "thread/list",
  "thread/loaded/list",
  "thread/start",
  "thread/new",
  "thread/resume",
  "thread/name/set",
  "thread/read",
  "thread/compact/start",
  "model/list",
  "skills/list",
  "experimentalFeature/list",
  "mcpServerStatus/list",
  "account/rateLimits/read",
  "account/read",
  "review/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export class CodexAppServer {
  private readonly provider: AppServerProvider;
  private readonly state: AppServerSessionState;
  private readonly metadata = new AppServerMetadataService();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly requestHandlers = new Set<RequestHandler>();
  private readonly turnRunner: TurnRunner;
  private readonly compactionRunner: CompactionRunner;
  private readonly reviewRunner: ReviewRunner;
  private readonly toolExecutor: LocalToolExecutor;
  private readonly createThreadId: () => string;
  private readonly createRunId: () => string;

  constructor(options: ServerOptions) {
    this.provider = options.provider;
    this.state = options.sessionState ?? new AppServerSessionState();
    this.toolExecutor = new LocalToolExecutor(createDefaultToolRegistry());
    this.createThreadId = options.threadIdGenerator ?? (() => createId("thread"));
    this.createRunId = options.runIdGenerator ?? (() => createId("turn"));
    this.turnRunner = new TurnRunner({
      state: this.state,
      emit: async (notification) => {
        await this.emit(notification);
      },
      requestClient: async (method, params) => await this.sendRequest(method, params),
    });
    this.compactionRunner = new CompactionRunner({
      provider: this.provider,
      state: this.state,
      emit: async (notification) => {
        await this.emit(notification);
      },
      turnRunner: this.turnRunner,
      tools: this.toolExecutor,
    });
    this.reviewRunner = new ReviewRunner({
      provider: this.provider,
      state: this.state,
      emit: async (notification) => {
        await this.emit(notification);
      },
      turnRunner: this.turnRunner,
      tools: this.toolExecutor,
    });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onRequest(handler: RequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => {
      this.requestHandlers.delete(handler);
    };
  }

  async notify(method: string, _params?: unknown): Promise<void> {
    if (method === "initialized") {
      return;
    }
    throw new AppServerProtocolError(`Unsupported notification: ${method}`);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const record = asOptionalRecord(params);
    switch (method) {
      case "initialize":
        return this.initialize();
      case "thread/list":
      case "thread/loaded/list":
        return this.listThreads();
      case "thread/start":
      case "thread/new":
        return this.startThread(record);
      case "thread/resume":
        return this.resumeThread(record);
      case "thread/name/set":
        return this.setThreadName(record);
      case "thread/read":
        return this.readThread(record);
      case "thread/compact/start":
        return this.startCompaction(record);
      case "model/list":
        return this.metadata.listModels();
      case "skills/list":
        return this.metadata.listSkills({
          cwd: asOptionalString(record.cwd),
          cwds: asOptionalStringArray(record.cwds),
        });
      case "experimentalFeature/list":
        return this.metadata.listExperimentalFeatures();
      case "mcpServerStatus/list":
        return this.metadata.listMcpServerStatus();
      case "account/rateLimits/read":
        return this.metadata.readRateLimits();
      case "account/read":
        return this.metadata.readAccount();
      case "review/start":
        return this.startReview(record);
      case "turn/start":
        return this.startTurn((params ?? {}) as AppServerTurnInput);
      case "turn/steer":
        return this.steerTurn(record);
      case "turn/interrupt":
        return this.interruptTurn(record);
      default:
        throw new AppServerProtocolError(`Unsupported method: ${method}`);
    }
  }

  private initialize(): AppServerInitializeResult {
    return {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      serverInfo: {
        name: "@pwragnt/grok-app-server",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
      methods: [...SUPPORTED_METHODS],
    };
  }

  private listThreads(): { threads: ReturnType<AppServerSessionState["listThreads"]> } {
    return {
      threads: this.state.listThreads(),
    };
  }

  private startThread(params: Record<string, unknown>): ThreadState {
    const threadId = this.createThreadId();
    return this.state.createThread({
      threadId,
      cwd: asOptionalString(params.cwd),
      model: asOptionalString(params.model),
      approvalPolicy: asOptionalString(params.approvalPolicy),
      sandbox: asOptionalString(params.sandbox),
      serviceTier: asOptionalString(params.serviceTier),
      reasoningEffort: asOptionalString(params.reasoningEffort),
      fastMode: asOptionalBoolean(params.fastMode),
      modelProvider: "xai",
    });
  }

  private resumeThread(params: Record<string, unknown>): ThreadState {
    const threadId = asRequiredString(params.threadId, "thread/resume requires threadId");
    const thread = this.state.updateThread(threadId, {
      cwd: asOptionalString(params.cwd),
      model: asOptionalString(params.model),
      approvalPolicy: asOptionalString(params.approvalPolicy),
      sandbox: asOptionalString(params.sandbox),
      serviceTier: asOptionalString(params.serviceTier),
      reasoningEffort: asOptionalString(params.reasoningEffort),
      fastMode: asOptionalBoolean(params.fastMode),
    });
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    return thread;
  }

  private async setThreadName(params: Record<string, unknown>): Promise<ThreadState> {
    const threadId = asRequiredString(params.threadId, "thread/name/set requires threadId");
    const name = asRequiredString(params.name, "thread/name/set requires name");
    const thread = this.state.setThreadName(threadId, name);
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    await this.emit({
      method: "thread/name/updated",
      params: {
        threadId,
        threadName: thread.threadName,
      },
    });
    return thread;
  }

  private readThread(params: Record<string, unknown>): ThreadReplay {
    const threadId = asRequiredString(params.threadId, "thread/read requires threadId");
    const thread = this.state.getThread(threadId);
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    return this.state.readThread(threadId);
  }

  private async startCompaction(
    params: Record<string, unknown>,
  ): Promise<{ threadId: string; runId: string; itemId: string }> {
    const threadId = asRequiredString(
      params.threadId,
      "thread/compact/start requires threadId",
    );
    const thread = this.state.getThread(threadId);
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    const runId = this.createRunId();
    const itemId = `${runId}-item`;
    return await this.compactionRunner.start({
      thread,
      runId,
      itemId,
    });
  }

  private async startReview(
    params: Record<string, unknown>,
  ): Promise<{ reviewThreadId: string; runId: string }> {
    const threadId = asRequiredString(params.threadId, "review/start requires threadId");
    const thread = this.state.getThread(threadId);
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    const runId = this.createRunId();
    const itemId = `${runId}-item`;
    return await this.reviewRunner.start({
      thread,
      runId,
      itemId,
      target: params.target,
    });
  }

  private async startTurn(params: AppServerTurnInput): Promise<AppServerTurnResult> {
    const threadId = asRequiredString(params.threadId, "turn/start requires threadId");
    const thread = this.state.getThread(threadId);
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    const effectiveThread =
      params.model !== undefined ||
      params.serviceTier !== undefined ||
      params.reasoningEffort !== undefined ||
      params.fastMode !== undefined
        ? this.state.updateThread(threadId, {
            model: asOptionalString(params.model),
            serviceTier: asOptionalString(params.serviceTier),
            reasoningEffort: asOptionalString(params.reasoningEffort),
            fastMode: asOptionalBoolean(params.fastMode),
          }) ?? thread
        : thread;
    const normalizedInput = normalizeTurnInput(params.input);
    const runId = this.createRunId();
    const handle = await this.provider.startTurn({
      thread: effectiveThread,
      input: normalizedInput,
      previousResponseId: this.state.getPreviousResponseId(threadId),
      tools: this.toolExecutor,
    });
    this.state.appendInput(threadId, normalizedInput);
    this.state.createRun({ runId, threadId, handle });
    await this.emit({
      method: "turn/started",
      params: {
        threadId,
        runId,
        turn: {
          id: runId,
          status: "in_progress",
        },
      },
    });
    this.turnRunner.attach({ threadId, runId, handle });
    return { threadId, runId };
  }

  private async steerTurn(params: Record<string, unknown>): Promise<AppServerTurnResult> {
    const threadId = asRequiredString(params.threadId, "turn/steer requires threadId");
    const runId = asRequiredString(
      params.expectedTurnId ?? params.turnId,
      "turn/steer requires expectedTurnId",
    );
    const run = this.state.getRun(runId);
    if (!run || run.threadId !== threadId || run.status !== "active") {
      throw new AppServerProtocolError(`Cannot steer inactive turn: ${runId}`);
    }
    if (!run.handle.steer) {
      throw new AppServerProtocolError(`Turn does not support steering: ${runId}`);
    }
    const thread = this.state.getThread(threadId);
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    const input = normalizeTurnInput(params.input);
    this.state.appendInput(threadId, input);
    await run.handle.steer({ thread, runId, input });
    return { threadId, runId };
  }

  private async interruptTurn(params: Record<string, unknown>): Promise<AppServerTurnResult> {
    const threadId = asRequiredString(params.threadId, "turn/interrupt requires threadId");
    const runId = asRequiredString(
      params.turnId ?? params.expectedTurnId,
      "turn/interrupt requires turnId",
    );
    const run = this.state.getRun(runId);
    if (!run || run.threadId !== threadId || run.status !== "active") {
      throw new AppServerProtocolError(`Cannot interrupt inactive turn: ${runId}`);
    }
    await run.handle.interrupt?.();
    await this.turnRunner.cancel(runId);
    this.state.cancelRun(runId);
    await this.emit({
      method: "turn/cancelled",
      params: {
        threadId,
        runId,
        turn: {
          id: runId,
          status: "cancelled",
        },
      },
    });
    return { threadId, runId };
  }

  private async emit(notification: AppServerNotification): Promise<void> {
    for (const handler of this.notificationHandlers) {
      await handler(notification);
    }
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const handlers = [...this.requestHandlers];
    if (handlers.length === 0) {
      return { decision: "cancel" };
    }
    return await handlers[0](method, params);
  }
}

function asRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppServerProtocolError(message);
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeTurnInput(value: unknown): AppServerTurnInputItem[] {
  if (!Array.isArray(value)) {
    throw new AppServerProtocolError("turn input must be an array");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new AppServerProtocolError("turn input items must be objects");
    }
    const record = item as Record<string, unknown>;
    const type = asRequiredString(record.type, "turn input items require type");
    if (type === "text") {
      return {
        type: "text",
        text: asRequiredString(record.text, "text input requires text"),
      };
    }
    if (type === "image") {
      return {
        type: "image",
        url: asRequiredString(record.url, "image input requires url"),
      };
    }
    if (type === "localImage") {
      return {
        type: "localImage",
        path: asRequiredString(record.path, "localImage input requires path"),
      };
    }
    throw new AppServerProtocolError(`Unsupported input type: ${type}`);
  });
}
