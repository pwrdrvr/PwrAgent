import { buildThreadIdentityKey, type AgentEvent, type AppServerBackendKind, type ThreadExecutionMode } from "@pwragent/shared";

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

  async submitCodex<Recovered>(host: CodexTurnSubmissionHost<Recovered>): Promise<
    { kind: "started"; turn: StartedTurn } | { kind: "recovered"; response: Recovered }
  > {
    let turn: StartedTurn;
    try {
      turn = await host.submit();
    } catch (error) {
      try {
        try {
          await host.fail(error);
        } finally {
          // Notification consumers can reject after observing a terminal.
          // Neither that rejection nor recovery may retain synthetic ownership.
          host.retireFailed();
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
        host.discardRetry();
      }
    }
    if (host.identity.backend === "codex" && turn.turnId === host.pendingTurnId) {
      // The provider's start event may bind the real id before an incomplete
      // response arrives. Only that backend and response thread are authority.
      for (const active of host.activeTurns()) {
        if (active.backend === "codex" && active.threadId === turn.threadId
          && !active.turnId.startsWith("pending:")) {
          turn = { threadId: turn.threadId, turnId: active.turnId };
          break;
        }
      }
    }
    return { kind: "started", turn };
  }

  handoffCodex(host: CodexTurnStartHandoffHost): void {
    host.bindReview();
    if (host.identity.backend === "codex" && !host.terminalObserved) host.activateCollaboration();
    if (host.turn.turnId !== host.pendingTurnId || host.terminalObserved) host.retirePending();
    if (host.identity.backend === "codex" && host.executionMode && !host.terminalObserved) {
      host.activateExecutionMode(host.executionMode);
    }
    if (host.reserved) host.release();
  }
}
