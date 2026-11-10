import {
  isAcpBackendId,
  type AcpBackendId,
  type AppServerThreadMessageOrigin,
  type AppServerTurnInputItem,
  type SteerTurnRequest,
} from "@pwragent/shared";
import type { ThreadSteeringSubmission } from "./thread-steering-lifecycle";

type ProviderSteerResult = { threadId: string; turnId: string };

export type PreparedAcpSteer = {
  submit(): Promise<{ delivery: "currentTurn" | "nextTurn" }>;
  bindCurrentTurn(): void;
  forget(): void;
};

export type PreparedCodexSteer = {
  submit(): Promise<ProviderSteerResult>;
  retain(result: ProviderSteerResult): Promise<void>;
  forget(): void;
};

export type PreparedCodexSteerPorts = Pick<PreparedCodexSteer, "submit">
  & Partial<Pick<PreparedCodexSteer, "retain" | "forget">>;

export interface ThreadSteerSubmissionHost {
  assertUnlocked(request: SteerTurnRequest): Promise<void>;
  isRestartGateClosed(): boolean;
  queue(request: SteerTurnRequest, origin: AppServerThreadMessageOrigin, queueOrigin: "messaging" | "manual"):
    Promise<{ id: string; createdAt: number }>;
  reviewMode(request: SteerTurnRequest): "native" | "managed" | undefined;
  prepareInput(request: SteerTurnRequest): Promise<AppServerTurnInputItem[]>;
  steerClaude(request: SteerTurnRequest, input: AppServerTurnInputItem[], origin?: AppServerThreadMessageOrigin):
    Promise<ProviderSteerResult & { messageId: string }>;
  retainClaude(request: SteerTurnRequest, messageId: string, origin?: AppServerThreadMessageOrigin): Promise<void>;
  prepareAcp(request: SteerTurnRequest & { backend: AcpBackendId }, input: AppServerTurnInputItem[], origin?: AppServerThreadMessageOrigin):
    Promise<PreparedAcpSteer>;
  prepareCodex(request: SteerTurnRequest, input: AppServerTurnInputItem[], origin?: AppServerThreadMessageOrigin):
    Promise<PreparedCodexSteer>;
}

export type ThreadSteerSubmissionPorts = Pick<ThreadSteerSubmissionHost, "assertUnlocked" | "prepareInput">
  & Partial<Omit<ThreadSteerSubmissionHost, "assertUnlocked" | "prepareInput" | "prepareCodex">>
  & { prepareCodex?(request: SteerTurnRequest, input: AppServerTurnInputItem[], origin?: AppServerThreadMessageOrigin):
    Promise<PreparedCodexSteerPorts> };

/** Submission rules; the steering lifecycle remains the sole request authority. */
export class ThreadSteerSubmissionLifecycle {
  constructor(private readonly host: ThreadSteerSubmissionPorts) {}

  async submit(request: SteerTurnRequest, origin?: AppServerThreadMessageOrigin): Promise<ThreadSteeringSubmission> {
    // Refuse before any attachment is copied into private storage.
    if (request.delivery === "now" && request.backend !== "claude") {
      throw new Error("This backend cannot interrupt a running response. Steer or queue the message instead.");
    }
    await this.host.assertUnlocked(request);
    // Automatic messages wait behind a quiet restart. Its own steer and the
    // operator's steer pass through the gate.
    if (this.host.isRestartGateClosed?.() && origin && origin.systemReason !== "app-restart") {
      if (!this.host.queue) throw new Error("This host cannot queue steering behind a restart");
      const entry = await this.host.queue(request, origin, origin.kind === "messaging" ? "messaging" : "manual");
      return { response: { backend: request.backend, threadId: request.threadId, turnId: request.expectedTurnId,
        disposition: "queued", queueEntryId: entry.id, queueEntryCreatedAt: entry.createdAt } };
    }
    if (this.host.reviewMode?.(request) === "native") {
      throw new Error("Native review steering is unsupported; queue a follow-up instead.");
    }
    const input = await this.host.prepareInput(request);
    if (request.backend === "claude") {
      if (!this.host.steerClaude || !this.host.retainClaude) throw new Error("This host cannot steer Claude");
      const result = await this.host.steerClaude(request, input, origin);
      return {
        response: { backend: "claude", threadId: result.threadId, turnId: result.turnId, disposition: "steered" },
        complete: () => this.host.retainClaude!(request, result.messageId, origin),
      };
    }
    if (isAcpBackendId(request.backend)) {
      if (!this.host.prepareAcp) throw new Error("This host cannot steer ACP");
      const prepared = await this.host.prepareAcp({ ...request, backend: request.backend }, input, origin);
      let result: Awaited<ReturnType<PreparedAcpSteer["submit"]>>;
      try {
        result = await prepared.submit();
      } catch (error) {
        prepared.forget();
        throw error;
      }
      // A next-turn steer has no turn id yet. Its unbound context is claimed
      // by the next turn/started or matching user item, never the finished turn.
      return {
        response: { backend: request.backend, threadId: request.threadId, turnId: request.expectedTurnId,
          disposition: result.delivery === "nextTurn" ? "queued" : "steered" },
        ...(result.delivery === "currentTurn" ? { complete: async () => { prepared.bindCurrentTurn(); } } : {}),
      };
    }
    if (!this.host.prepareCodex) throw new Error("This host cannot steer Codex");
    const prepared = await this.host.prepareCodex(request, input, origin);
    let result: ProviderSteerResult;
    try {
      result = await prepared.submit();
    } catch (error) {
      prepared.forget?.();
      throw error;
    }
    return { response: { backend: request.backend, ...result, disposition: "steered" },
      ...(prepared.retain ? { complete: () => prepared.retain!(result) } : {}) };
  }
}
