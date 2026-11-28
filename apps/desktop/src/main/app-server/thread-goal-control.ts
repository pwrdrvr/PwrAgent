import { randomUUID } from "node:crypto";
import {
  validateThreadGoalObjective,
  type ThreadGoalRequest,
  type ThreadGoalState,
  type ThreadGoalView,
} from "@pwragent/shared/contracts/thread-goal";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import { ThreadTurnQueueDispatchCancelled, type ThreadTurnQueueReleaseResult } from "@pwragent/owner-core/thread-turn-queue";

export type ThreadGoalGate = "message" | "lock" | "stop" | "hibernate" | "drift" | "turn-control";

const ACTIVATION_PREFIX = "codex-goal:";

export function isGoalActivationEntry(entryId?: string): boolean {
  return entryId?.startsWith(ACTIVATION_PREFIX) === true;
}

type GoalControl = {
  goal?: ThreadGoalView | null;
  pausedForMessage?: boolean;
  activation?: { entryId: string; queued: boolean; clearOnCancel: boolean; holdReason?: string };
  holdingReplacement?: boolean;
  arming?: boolean;
};

type GoalPorts = {
  read: (threadId: string) => Promise<ThreadGoalView | null | undefined>;
  set: (threadId: string, status: "paused" | "active", objective?: string) => Promise<ThreadGoalView>;
  clear: (threadId: string) => Promise<boolean>;
  submit: (threadId: string, entryId: string, text: string) => Promise<boolean>;
  cancel: (entryId: string) => void;
  retry: (entryId: string) => Promise<ThreadTurnQueueReleaseResult>;
  hasWaitingMessages: (threadId: string) => boolean;
  assertCanActivate: (threadId: string) => Promise<void>;
  isAdmissionRefusal: (error: unknown) => boolean;
  publish: (threadId: string, state: ThreadGoalState) => Promise<void>;
  warn: (threadId: string, message: string, operation?: "pause") => void;
};

export class ThreadGoalControl {
  private readonly controls = new Map<string, GoalControl>();
  private readonly locks = new PerKeyAsyncLock();

  constructor(private readonly ports: GoalPorts) {}

  private state(control?: GoalControl): ThreadGoalState {
    return {
      supported: control?.goal !== undefined,
      goal: control?.goal ?? null,
      ...(control?.activation?.queued ? { activationQueued: true } : {}),
      ...(control?.activation?.holdReason ? { activationHoldReason: control.activation.holdReason } : {}),
      ...(control?.pausedForMessage ? { pausedForMessage: true } : {}),
    };
  }

  private async publish(threadId: string, control: GoalControl): Promise<ThreadGoalState> {
    const state = this.state(control);
    await this.ports.publish(threadId, state);
    return state;
  }

  private get(threadId: string): GoalControl {
    let control = this.controls.get(threadId);
    if (!control) {
      control = {};
      this.controls.set(threadId, control);
    }
    return control;
  }

  private async refresh(threadId: string, control: GoalControl): Promise<void> {
    const previous = control.goal;
    const read = await this.ports.read(threadId);
    if (read === undefined || control.goal === previous) control.goal = read;
  }

  async hasActiveGoalOnLockedThread(threadId: string): Promise<boolean> {
    return await this.locks.run(threadId, async () => {
      const control = this.get(threadId);
      if (control.goal?.status !== "active") await this.refresh(threadId, control);
      return control.goal?.status === "active";
    });
  }

  assertActivationPending(threadId: string, entryId: string | undefined): void {
    if (isGoalActivationEntry(entryId) && this.controls.get(threadId)?.activation?.entryId !== entryId) {
      throw new ThreadTurnQueueDispatchCancelled("Goal activation was cancelled.");
    }
  }

  async messageAbandoned(threadId: string): Promise<void> {
    const control = this.controls.get(threadId);
    if (!control?.pausedForMessage) return;
    await this.locks.run(threadId, async () => {
      if (!control.pausedForMessage || this.ports.hasWaitingMessages(threadId)) return;
      control.pausedForMessage = false;
      await this.publish(threadId, control);
    });
  }

  async activationRefused(threadId: string, entryId: string, reason: string): Promise<void> {
    const control = this.controls.get(threadId);
    if (control?.activation?.entryId !== entryId || !control.activation.queued) return;
    await this.locks.run(threadId, async () => {
      if (control.activation?.entryId !== entryId) return;
      control.activation = undefined;
      control.holdingReplacement = false;
      this.ports.warn(threadId, reason);
      await this.publish(threadId, control);
    });
  }

  activationWaiting(threadId: string, entryId: string, holdReason?: string): void {
    const control = this.controls.get(threadId);
    const activation = control?.activation;
    if (!control || activation?.entryId !== entryId) return;
    if (activation.queued && activation.holdReason === holdReason) return;
    activation.queued = true;
    activation.holdReason = holdReason;
    control.holdingReplacement = false;
    void this.publish(threadId, control).catch(() => undefined);
  }

  hasActiveWork(threadId: string): boolean {
    const control = this.controls.get(threadId);
    return !!control && (control.goal?.status === "active" || !!control.pausedForMessage || !!control.activation || !!control.arming);
  }

  *activeThreads(): IterableIterator<string> {
    for (const threadId of this.controls.keys()) {
      if (this.hasActiveWork(threadId)) yield threadId;
    }
  }

  observe(threadId: string, goal: ThreadGoalView | null): void {
    const control = this.get(threadId);
    if (control.holdingReplacement || (goal && control.goal && goal.updatedAt < control.goal.updatedAt)) return;
    control.goal = goal;
    if (goal?.status !== "paused") control.pausedForMessage = false;
    void this.publish(threadId, control).catch(() => undefined);
  }

  async change(request: ThreadGoalRequest): Promise<ThreadGoalState> {
    const { threadId, action } = request;
    const objective = request.objective?.trim() ?? "";
    if (action === "set") {
      const error = validateThreadGoalObjective(objective);
      if (error) throw new Error(error);
    }

    let activation: GoalControl["activation"];
    let retryEntryId: string | undefined;
    const state = await this.locks.run(threadId, async () => {
      const control = this.get(threadId);
      await this.refresh(threadId, control);
      if (control.goal === undefined || action === "read") return this.state(control);
      if (action !== "set" && !control.goal) throw new Error("No goal on this thread.");
      if (action === "cancel" && !control.activation) return this.state(control);
      if (control.goal && control.goal.status !== "complete" && request.confirmedObjective !== control.goal.objective
        && (action === "clear" || (action === "set" && objective !== control.goal.objective))) {
        return { ...this.state(control), confirmationRequired: true };
      }
      const pending = control.activation;
      if (action === "resume" && pending?.holdReason) {
        retryEntryId = pending.entryId;
        return this.state(control);
      }
      if (pending) {
        this.ports.cancel(pending.entryId);
        control.activation = undefined;
        control.holdingReplacement = false;
      }
      control.pausedForMessage = false;
      if (action === "clear" || action === "cancel") {
        if (action === "clear" || pending?.clearOnCancel) {
          await this.ports.clear(threadId);
          control.goal = null;
        }
      } else if (action === "pause") {
        control.goal = await this.ports.set(threadId, "paused");
      } else {
        if (action === "resume" && control.goal?.status === "complete") {
          throw new Error("The goal is complete.");
        }
        control.holdingReplacement = true;
        try {
          const clearOnCancel = action === "set" && control.goal?.objective !== objective;
          if (action === "set" && control.goal && control.goal.objective !== objective) {
            await this.ports.clear(threadId);
            control.goal = null;
          }
          control.goal = await this.ports.set(threadId, "paused", action === "set" ? objective : undefined);
          activation = { entryId: `${ACTIVATION_PREFIX}${randomUUID()}`, queued: false, clearOnCancel };
          control.activation = activation;
          return this.state(control);
        } catch (error) {
          control.holdingReplacement = false;
          await this.publish(threadId, control);
          throw error;
        }
      }
      return this.publish(threadId, control);
    });
    if (retryEntryId) {
      const result = await this.ports.retry(retryEntryId);
      const next = this.state(this.get(threadId));
      if (result.disposition === "not_head") return { ...next, refusal: "Retry the earlier queued message first." };
      if (result.disposition === "busy" && next.activationHoldReason) {
        return { ...next, refusal: "The thread is busy. Retry the goal when it is idle." };
      }
      return next;
    }
    if (!activation) return state;

    const { entryId } = activation;
    try {
      const queued = await this.ports.submit(threadId, entryId, action === "set"
        ? `This thread's goal is already set. Do not call create_goal. Start working on it now: ${objective}`
        : "Continue working on this thread's goal.");
      if (queued) {
        await this.locks.run(threadId, async () => {
          const control = this.get(threadId);
          if (control.activation?.entryId !== entryId || control.activation.queued) return;
          control.activation.queued = true;
          control.holdingReplacement = false;
          await this.publish(threadId, control);
        });
      }
    } catch (error) {
      const next = await this.locks.run(threadId, async () => {
        const control = this.get(threadId);
        if (control.activation?.entryId === entryId) {
          control.activation = undefined;
          control.holdingReplacement = false;
          await this.publish(threadId, control);
        }
        return this.state(control);
      });
      if (error instanceof ThreadTurnQueueDispatchCancelled || this.ports.isAdmissionRefusal(error)) {
        return { ...next, refusal: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    }
    return this.state(this.get(threadId));
  }

  /** Keep the confirmed pause and the gate's commit in the same owner critical section. */
  async withGate<T>(threadId: string, gate: ThreadGoalGate, commit: () => Promise<T>): Promise<T> {
    const current = this.controls.get(threadId);
    // A message can claim a FIFO slot before a provider acknowledges a start.
    // It cannot let active continuation jump that slot, so wait only when a
    // pause is needed or an activation RPC already crossed the wire.
    if (gate === "message" && current?.goal?.status !== "active" && !current?.arming) return await commit();
    return await this.locks.run(threadId, async () => {
      const control = gate === "lock" ? this.get(threadId) : this.controls.get(threadId);
      if (gate === "lock" && control && control.goal === undefined) await this.refresh(threadId, control);
      if (control?.goal?.status === "active") {
        try {
          control.goal = await this.ports.set(threadId, "paused");
        } catch (error) {
          if (gate !== "stop") throw error;
          this.ports.warn(threadId, error instanceof Error ? error.message : String(error), "pause");
          return await commit();
        }
        control.pausedForMessage = gate === "message";
        await this.publish(threadId, control);
      } else if (control && gate !== "message" && (control.activation || control.pausedForMessage)) {
        if (control.activation) {
          this.ports.cancel(control.activation.entryId);
          control.activation = undefined;
          control.holdingReplacement = false;
        }
        control.pausedForMessage = false;
        await this.publish(threadId, control);
      }
      return await commit();
    });
  }

  async startAdmitted<T>(threadId: string, entryId: string | undefined, submit: () => Promise<T>): Promise<T> {
    if (!isGoalActivationEntry(entryId)) {
      const result = await submit();
      await this.messageAccepted(threadId);
      return result;
    }
    return await this.locks.run(threadId, async () => {
      const control = this.controls.get(threadId);
      this.assertActivationPending(threadId, entryId);
      try {
        await this.ports.assertCanActivate(threadId);
      } catch (error) {
        throw new ThreadTurnQueueDispatchCancelled(error instanceof Error ? error.message : String(error), { cause: error });
      }
      const result = await submit();
      if (control) {
        control.activation = undefined;
        if (this.ports.hasWaitingMessages(threadId)) {
          control.holdingReplacement = false;
          control.pausedForMessage = true;
          await this.publish(threadId, control);
        } else {
          await this.activate(threadId, control);
        }
      }
      return result;
    });
  }

  async messageAccepted(threadId: string): Promise<void> {
    if (!this.controls.get(threadId)?.pausedForMessage) return;
    await this.locks.run(threadId, async () => {
      const control = this.controls.get(threadId);
      if (control?.pausedForMessage && !this.ports.hasWaitingMessages(threadId)) {
        await this.activate(threadId, control);
      }
    });
  }

  private async activate(threadId: string, control: GoalControl): Promise<void> {
    control.arming = true;
    control.pausedForMessage = false;
    try {
      await this.ports.assertCanActivate(threadId);
      control.goal = await this.ports.set(threadId, "active");
    } catch (error) {
      // The turn was accepted. A failed goal mutation must not retry its send.
      this.ports.warn(threadId, error instanceof Error ? error.message : String(error));
    } finally {
      control.arming = false;
      control.holdingReplacement = false;
    }
    await this.publish(threadId, control);
  }
}
