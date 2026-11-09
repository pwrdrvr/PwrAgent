import { buildThreadIdentityKey, isAcpBackendId, type AgentEvent, type AppServerBackendKind, type SetThreadModelSettingsRequest, type ThreadExecutionMode } from "@pwragent/shared";

export type TurnStartIdentity = { backend: AppServerBackendKind; threadId: string };

export function buildTurnStartEvent(identity: TurnStartIdentity, turnId: string, now = Date.now()): AgentEvent {
  return { backend: identity.backend, notification: {
    method: "turn/started",
    params: { threadId: identity.threadId, turnId, turn: { id: turnId, status: "in_progress", startedAt: now } },
  } };
}

export function buildTurnStartFailureEvent(identity: TurnStartIdentity, turnId: string, error: unknown, now = Date.now()): AgentEvent {
  return { backend: identity.backend, notification: {
    method: "turn/failed",
    params: { threadId: identity.threadId, turnId, turn: {
      id: turnId, status: "failed", completedAt: now,
      error: { message: error instanceof Error ? error.message : String(error) },
    } },
  } };
}

export interface ThreadTurnStartHost {
  assertAvailable(identity: TurnStartIdentity): void;
  withMutation<T>(identity: TurnStartIdentity, work: () => Promise<T>): Promise<T>;
  assertUnlocked(identity: TurnStartIdentity): Promise<void>;
  wake(identity: TurnStartIdentity): Promise<void>;
}

export interface CodexTurnStartPreparationHost<Context> {
  threadId: string;
  reserve(pendingTurnId: string): void;
  prepare(): Promise<void>;
  announce(pendingTurnId: string): Promise<void>;
  rememberInput(): void;
  registerContext(): Promise<Context>;
  forgetContext(context: Context): void;
  fail(pendingTurnId: string, error: unknown, announced: boolean): Promise<void>;
  retire(pendingTurnId: string): void;
}

export type StartedTurn = { threadId: string; turnId: string };

export type ClaudeTurnStartStage = "origin" | "persist-origin" | "dispose-origin" | "revoke-connections";

export interface ClaudeTurnStartHost<Origin, Turn extends StartedTurn> {
  prepare(): Promise<void>;
  beginOrigin(): Origin;
  /** Always consumes release, including a refusal while a session is live. */
  submit(release: () => void): Promise<Turn>;
  bindOrigin(origin: Origin | undefined, turn: Turn): void;
  persistOrigin(origin: Origin | undefined): Promise<void>;
  disposeOrigin(origin: Origin | undefined): void;
  revokeConnections(): void;
  failed(stage: ClaudeTurnStartStage, error: unknown, turn: Turn | undefined): void;
}

export type AcpTurnStartFinalizationStage = "origin" | "review-contexts" | "pdf" | "title" | "context"
  | "persist-origin" | "attachments" | "forget-context" | "dispose-origin" | "release";

export interface AcpTurnStartHost<Context, Origin, Turn extends StartedTurn> {
  reserve(): void;
  prepare(): Promise<void>;
  registerContext(): Promise<Context>;
  beginOrigin(): Origin;
  submit(): Promise<Turn>;
  bindOrigin(origin: Origin | undefined, turn: Turn): void;
  consumeReviewContexts(): Promise<unknown>;
  bindPdf(turn: Turn): void;
  scheduleTitle(turn: Turn): void;
  bindContext(context: Context | undefined, turn: Turn): void;
  persistOrigin(origin: Origin | undefined): Promise<void>;
  retainAttachments(turn: Turn): Promise<void>;
  forgetContext(context: Context | undefined): void;
  disposeOrigin(origin: Origin | undefined): void;
  release(): void;
  failed(stage: AcpTurnStartFinalizationStage, error: unknown, turn: Turn | undefined): void;
}

export interface CodexTurnSubmissionHost<Recovered> {
  identity: TurnStartIdentity;
  pendingTurnId: string;
  submit(): Promise<StartedTurn>;
  activeTurns(): Iterable<TurnStartIdentity & { turnId: string }>;
  fail(error: unknown): Promise<void>;
  retireFailed(): void;
  discardRetry(): void;
  recovery?: {
    accepts(error: unknown): boolean;
    run(failureMessage: string): Promise<Recovered>;
    failed(details: { failureMessage: string; recoveryError: string; status: "failed"; threadId: string; turnId: string }): Promise<void>;
  };
}

export interface CodexTurnStartHandoffHost {
  identity: TurnStartIdentity;
  pendingTurnId: string;
  turn: StartedTurn;
  terminalObserved: boolean;
  executionMode?: ThreadExecutionMode;
  reserved: boolean;
  bindReview(): void;
  activateCollaboration(): void;
  retirePending(): void;
  activateExecutionMode(mode: ThreadExecutionMode): void;
  release(): void;
}

export type CodexTurnHandoffStage = "review" | "collaboration" | "retire-pending" | "execution-ownership" | "release";
export type CodexTurnFinalizationStage = CodexTurnHandoffStage
  | "origin" | "retry" | "pdf" | "context" | "persist-origin" | "dispose-origin"
  | "model" | "execution" | "attachments" | "replay" | "forget-title-input" | "title";

export interface CodexTurnFinalizationHost {
  identity: TurnStartIdentity;
  turn: StartedTurn;
  settings: Pick<SetThreadModelSettingsRequest, "model" | "reasoningEffort" | "serviceTier" | "fastMode">;
  executionMode?: ThreadExecutionMode;
  bindOrigin(): void;
  bindRetry(): void;
  bindPdf(): void;
  bindContext(): void;
  persistOrigin(): Promise<void>;
  disposeOrigin(): void;
  handoff: CodexTurnStartHandoffHost;
  persistModel(): Promise<unknown>;
  persistExecutionMode(): Promise<unknown>;
  retainAttachments(): Promise<void>;
  scheduleReplay(): void;
  forgetTitleInput(): void;
  scheduleTitle(): void;
  failed(stage: CodexTurnFinalizationStage, error: unknown): void;
}

/** Hosts without optimistic starts, attachments or desktop contexts omit those effects. */
export type CodexTurnSubmissionPorts<Recovered> = Pick<CodexTurnSubmissionHost<Recovered>, "identity" | "pendingTurnId" | "submit">
  & Partial<Omit<CodexTurnSubmissionHost<Recovered>, "identity" | "pendingTurnId" | "submit">>;
export type CodexTurnFinalizationPorts = Pick<CodexTurnFinalizationHost, "identity" | "turn">
  & Partial<Omit<CodexTurnFinalizationHost, "identity" | "turn">>;

/** Owns start admission, not provider active-turn identity. */
export class ThreadTurnStartLifecycle {
  private readonly pending = new Map<string, number>();

  constructor(private readonly host: ThreadTurnStartHost) {}

  hasPending(identity: TurnStartIdentity): boolean {
    return this.pending.has(buildThreadIdentityKey(identity.backend, identity.threadId));
  }

  async run<T>(identity: TurnStartIdentity, start: () => Promise<T>): Promise<T> {
    this.host.assertAvailable(identity);
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    // Intent must be visible before mutation admission yields to an archive
    // or workspace move. Concurrent and nested starts each own their count.
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    try {
      return await this.host.withMutation(identity, async () => {
        // A lock can land while admission waits. Read it at the mutation site.
        await this.host.assertUnlocked(identity);
        await this.host.wake(identity);
        return await start();
      });
    } finally {
      const remaining = (this.pending.get(key) ?? 1) - 1;
      if (remaining) this.pending.set(key, remaining);
      else this.pending.delete(key);
    }
  }

  async prepareCodex<Context>(host: CodexTurnStartPreparationHost<Context>): Promise<{
    pendingTurnId: string;
    context: Context;
  }> {
    const pendingTurnId = `pending:${host.threadId}`;
    host.reserve(pendingTurnId);
    let announced = false;
    let registered: { context: Context } | undefined;
    try {
      await host.prepare();
      // Context staging is preparation too. A rejection must not announce a
      // turn that never reached its provider (or persist a synthetic failure).
      const context = await host.registerContext();
      registered = { context };
      // An event consumer may reject after observing the optimistic start.
      // From this point a failed preparation needs a matching terminal event.
      announced = true;
      await host.announce(pendingTurnId);
      host.rememberInput();
      return { pendingTurnId, context };
    } catch (error) {
      try {
        if (registered) host.forgetContext(registered.context);
        await host.fail(pendingTurnId, error, announced);
      } finally {
        // Even a failed terminal notification cannot retain start admission.
        host.retire(pendingTurnId);
      }
      throw error;
    }
  }

  async submitCodex<Recovered>(host: CodexTurnSubmissionPorts<Recovered>): Promise<
    { kind: "started"; turn: StartedTurn } | { kind: "recovered"; response: Recovered }
  > {
    let turn: StartedTurn;
    try {
      turn = await host.submit();
    } catch (error) {
      try {
        try {
          await host.fail?.(error);
        } finally {
          // Notification consumers can reject after observing a terminal.
          // Neither that rejection nor recovery may retain synthetic ownership.
          host.retireFailed?.();
        }
        if (host.recovery?.accepts(error)) {
          const failureMessage = error instanceof Error ? error.message : String(error);
          try {
            return { kind: "recovered", response: await host.recovery.run(failureMessage) };
          } catch (recoveryError) {
            await host.recovery.failed({
              failureMessage,
              recoveryError: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
              status: "failed",
              threadId: host.identity.threadId,
              turnId: host.pendingTurnId,
            });
          }
        }
        throw error;
      } finally {
        host.discardRetry?.();
      }
    }
    if (host.identity.backend === "codex" && turn.turnId === host.pendingTurnId) {
      // The provider's start event may bind the real id before an incomplete
      // response arrives. Only that backend and response thread are authority.
      for (const active of host.activeTurns?.() ?? []) {
        if (active.backend === "codex" && active.threadId === turn.threadId
          && !active.turnId.startsWith("pending:")) {
          turn = { threadId: turn.threadId, turnId: active.turnId };
          break;
        }
      }
    }
    return { kind: "started", turn };
  }

  async startClaude<Origin, Turn extends StartedTurn>(host: ClaudeTurnStartHost<Origin, Turn>): Promise<Turn> {
    let origin: Origin | undefined;
    let turn: Turn | undefined;
    let handedOver = false;
    let revoked = false;
    const report = (stage: ClaudeTurnStartStage, error: unknown) => {
      try { host.failed(stage, error, turn); } catch { /* Reporting must preserve the provider outcome. */ }
    };
    const effect = (stage: ClaudeTurnStartStage, work: () => void) => {
      try { work(); } catch (error) { report(stage, error); }
    };
    const release = () => {
      if (revoked) return;
      revoked = true;
      effect("revoke-connections", () => host.revokeConnections());
    };
    try {
      await host.prepare();
      origin = host.beginOrigin();
      // Claude's submission contract consumes release even on refusal: a live
      // session shares the thread's grants and alone decides when to revoke.
      handedOver = true;
      const accepted = await host.submit(release);
      turn = accepted;
      effect("origin", () => host.bindOrigin(origin, accepted));
      try { await host.persistOrigin(origin); } catch (error) { report("persist-origin", error); }
      return accepted;
    } finally {
      // Before invocation the caller owns grants; afterward only the session
      // callback does. Neither cleanup nor reporting can replace the outcome.
      if (!handedOver) release();
      effect("dispose-origin", () => host.disposeOrigin(origin));
    }
  }

  async startAcp<Context, Origin, Turn extends StartedTurn>(host: AcpTurnStartHost<Context, Origin, Turn>): Promise<Turn> {
    // Reservation belongs to this call only after admission succeeds. Provider
    // active-turn ownership remains with the host and its event stream.
    host.reserve();
    let context: Context | undefined;
    let origin: Origin | undefined;
    let turn: Turn | undefined;
    const report = (stage: AcpTurnStartFinalizationStage, error: unknown) => {
      try { host.failed(stage, error, turn); } catch { /* Reporting must preserve the provider outcome. */ }
    };
    const effect = (stage: AcpTurnStartFinalizationStage, work: () => void) => {
      try { work(); } catch (error) { report(stage, error); }
    };
    const persist = async (stage: AcpTurnStartFinalizationStage, work: () => Promise<unknown>) => {
      try { await work(); } catch (error) { report(stage, error); }
    };
    try {
      await host.prepare();
      context = await host.registerContext();
      origin = host.beginOrigin();
      const accepted = await host.submit();
      turn = accepted;
      // This is provider acceptance. Later host metadata effects are independent
      // attempts in their established order, never another provider submission.
      effect("origin", () => host.bindOrigin(origin, accepted));
      await persist("review-contexts", () => host.consumeReviewContexts());
      effect("pdf", () => host.bindPdf(accepted));
      effect("title", () => host.scheduleTitle(accepted));
      effect("context", () => host.bindContext(context, accepted));
      await persist("persist-origin", () => host.persistOrigin(origin));
      await persist("attachments", () => host.retainAttachments(accepted));
      return accepted;
    } finally {
      // A failing disposer cannot strand the other resources or replace either
      // provider acceptance or a preparation/submission rejection.
      effect("forget-context", () => host.forgetContext(context));
      effect("dispose-origin", () => host.disposeOrigin(origin));
      effect("release", () => host.release());
    }
  }

  async finalizeCodex(host: CodexTurnFinalizationPorts): Promise<TurnStartIdentity & { turnId: string }> {
    // Submission has already succeeded. No host metadata failure can turn
    // that acceptance into a retryable provider rejection. Attempt independent
    // effects in the established order, without adding request/retry state.
    const report = (stage: CodexTurnFinalizationStage, error: unknown) => {
      try { host.failed?.(stage, error); } catch { /* Reporting cannot reject an accepted turn either. */ }
    };
    const effect = (stage: CodexTurnFinalizationStage, work: () => void) => {
      try { work(); } catch (error) { report(stage, error); }
    };
    const persist = async (stage: CodexTurnFinalizationStage, work: () => unknown | Promise<unknown>) => {
      try { await work(); } catch (error) { report(stage, error); }
    };
    effect("origin", () => host.bindOrigin?.());
    effect("retry", () => host.bindRetry?.());
    effect("pdf", () => host.bindPdf?.());
    effect("context", () => host.bindContext?.());
    await persist("persist-origin", () => host.persistOrigin?.());
    effect("dispose-origin", () => host.disposeOrigin?.());
    // Read terminal ownership after persistence yields, never at acceptance.
    if (host.handoff) this.handoffCodex(host.handoff, effect);
    const settings = host.settings ?? {};
    if (settings.model !== undefined || settings.reasoningEffort !== undefined
      || settings.serviceTier !== undefined || settings.fastMode !== undefined) {
      await persist("model", () => host.persistModel?.());
    }
    if (host.identity.backend === "codex" && host.executionMode) {
      await persist("execution", () => host.persistExecutionMode?.());
    }
    await persist("attachments", () => host.retainAttachments?.());
    effect("replay", () => host.scheduleReplay?.());
    if (!isAcpBackendId(host.identity.backend)) {
      effect("forget-title-input", () => host.forgetTitleInput?.());
      effect("title", () => host.scheduleTitle?.());
    }
    return { backend: host.identity.backend, threadId: host.turn.threadId, turnId: host.turn.turnId };
  }

  handoffCodex(host: CodexTurnStartHandoffHost,
    effect: (stage: CodexTurnHandoffStage, work: () => void) => void = (_stage, work) => work(),
  ): void {
    effect("review", () => host.bindReview());
    if (host.identity.backend === "codex" && !host.terminalObserved) effect("collaboration", () => host.activateCollaboration());
    if (host.turn.turnId !== host.pendingTurnId || host.terminalObserved) effect("retire-pending", () => host.retirePending());
    if (host.identity.backend === "codex" && host.executionMode && !host.terminalObserved) {
      effect("execution-ownership", () => host.activateExecutionMode(host.executionMode!));
    }
    if (host.reserved) effect("release", () => host.release());
  }
}
