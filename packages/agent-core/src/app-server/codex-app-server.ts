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
import type { AppServerProvider } from "../providers/provider-contract.js";

type NotificationHandler = (
  notification: AppServerNotification,
) => void | Promise<void>;

type ServerOptions = {
  provider: AppServerProvider;
  threadIdGenerator?: () => string;
  runIdGenerator?: () => string;
};

const SUPPORTED_METHODS = [
  "initialize",
  "thread/start",
  "thread/new",
  "thread/resume",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export class CodexAppServer {
  private readonly provider: AppServerProvider;
  private readonly state = new AppServerSessionState();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly createThreadId: () => string;
  private readonly createRunId: () => string;

  constructor(options: ServerOptions) {
    this.provider = options.provider;
    this.createThreadId = options.threadIdGenerator ?? (() => createId("thread"));
    this.createRunId = options.runIdGenerator ?? (() => createId("turn"));
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async notify(method: string, _params?: unknown): Promise<void> {
    if (method === "initialized") {
      return;
    }
    throw new AppServerProtocolError(`Unsupported notification: ${method}`);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize();
      case "thread/start":
      case "thread/new":
        return this.startThread((params ?? {}) as Record<string, unknown>);
      case "thread/resume":
        return this.resumeThread((params ?? {}) as Record<string, unknown>);
      case "thread/read":
        return this.readThread((params ?? {}) as Record<string, unknown>);
      case "turn/start":
        return this.startTurn((params ?? {}) as AppServerTurnInput);
      case "turn/steer":
        return this.steerTurn((params ?? {}) as Record<string, unknown>);
      case "turn/interrupt":
        return this.interruptTurn((params ?? {}) as Record<string, unknown>);
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
    });
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
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

  private async startTurn(params: AppServerTurnInput): Promise<AppServerTurnResult> {
    const threadId = asRequiredString(params.threadId, "turn/start requires threadId");
    const thread = this.state.getThread(threadId);
    if (!thread) {
      throw new AppServerProtocolError(`Unknown thread: ${threadId}`);
    }
    const normalizedInput = normalizeTurnInput(params.input);
    const handle = await this.provider.startTurn({
      thread,
      input: normalizedInput,
      previousResponseId: this.state.getPreviousResponseId(threadId),
    });
    const runId = this.createRunId();
    this.state.appendInput(threadId, normalizedInput);
    this.state.createRun({ runId, threadId, handle });
    void this.completeTurn({ thread, runId, handle });
    return { threadId, runId };
  }

  private async completeTurn(params: {
    thread: ThreadState;
    runId: string;
    handle: Awaited<ReturnType<AppServerProvider["startTurn"]>>;
  }): Promise<void> {
    try {
      const result = await params.handle.result;
      const run = this.state.getRun(params.runId);
      if (!run || run.status !== "active") {
        return;
      }
      this.state.completeRun(params.runId);
      this.state.appendAssistant(params.thread.threadId, result.assistantText ?? "");
      this.state.setPreviousResponseId(params.thread.threadId, result.providerResponseId);
      await this.emit({
        method: "turn/completed",
        params: {
          threadId: params.thread.threadId,
          runId: params.runId,
          turn: {
            id: params.runId,
            status: "completed",
            output: [
              {
                type: "text",
                text: result.assistantText ?? "",
              },
            ],
          },
        },
      });
    } catch (error) {
      const run = this.state.getRun(params.runId);
      if (!run || run.status !== "active") {
        return;
      }
      this.state.failRun(params.runId);
      await this.emit({
        method: "turn/failed",
        params: {
          threadId: params.thread.threadId,
          runId: params.runId,
          turn: {
            id: params.runId,
            status: "failed",
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
        },
      });
    }
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
