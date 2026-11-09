import { isAcpBackendId, type AppServerBackendKind } from "@pwragent/shared";

export type ThreadInterruptionTarget = {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
};

export interface ThreadInterruptionLifecycleHost {
  cancelTools(target: ThreadInterruptionTarget): void;
  findReview(target: ThreadInterruptionTarget): ThreadInterruptionTarget | undefined;
  readCodexInterruptTurnId(target: ThreadInterruptionTarget): string | undefined;
  interruptClaude(target: ThreadInterruptionTarget): Promise<{ threadId: string; turnId: string }>;
  interruptAcp(target: ThreadInterruptionTarget, serializePrompt: boolean): Promise<ThreadInterruptionTarget>;
  interruptCodex(target: ThreadInterruptionTarget, routing: {
    review: boolean;
    requestedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  retireCodexTurn(requested: ThreadInterruptionTarget, result: { threadId: string; turnId: string }): void;
  reviewInterrupted(parent: ThreadInterruptionTarget, review: ThreadInterruptionTarget): void;
}

export type ThreadInterruptionLifecyclePorts = Partial<ThreadInterruptionLifecycleHost>;

/** Routes an owner's visible turn to its provider. Active identities stay host-owned. */
export class ThreadInterruptionLifecycle {
  constructor(private readonly host: ThreadInterruptionLifecyclePorts) {}

  async interruptTurn(request: ThreadInterruptionTarget): Promise<ThreadInterruptionTarget> {
    this.host.cancelTools?.(request);
    // A review owns the parent's visible turn, including a Claude parent whose
    // reviewer runs on another provider. Resolve that ownership before dispatch.
    const review = this.host.findReview?.(request);
    const target = review ?? request;
    let result: { threadId: string; turnId: string };
    if (isAcpBackendId(target.backend)) {
      if (!this.host.interruptAcp) throw new Error("This host cannot interrupt ACP");
      result = await this.host.interruptAcp(target, review !== undefined);
    } else if (target.backend === "claude") {
      if (!this.host.interruptClaude) throw new Error("This host cannot interrupt Claude");
      result = await this.host.interruptClaude(target);
    } else {
      if (!this.host.interruptCodex) throw new Error("This host cannot interrupt Codex");
      const turnId = this.host.readCodexInterruptTurnId?.(target) ?? target.turnId;
      result = await this.host.interruptCodex({ ...target, turnId }, {
        review: review !== undefined,
        requestedTurnId: target.turnId,
      });
      // Reviews retain their visible identity until the provider's terminal
      // event. Ordinary interrupts keep the host's existing retirement site.
      if (!review) this.host.retireCodexTurn?.(request, result);
    }
    if (review) {
      this.host.reviewInterrupted?.(request, review);
      return request;
    }
    return { backend: request.backend, ...result };
  }
}
