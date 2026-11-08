import { buildThreadIdentityKey, type AgentEvent, type AppServerBackendKind } from "@pwragent/shared";

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
}
