import {
  type AgentEvent,
  type PwrAgentThreadInspectionResponse,
  type ScheduleFollowUpToolArgs,
  type ScheduleFollowUpToolResult,
  type ScheduledThreadAction,
} from "@pwragent/shared";
import { MemoryScheduledThreadActionPayloadStore } from "@pwragent/sqlite-storage/scheduled-thread-action-payload-store";
import type { DesktopBackendRegistry } from "../../app-server/backend-registry";
import { buildAgentFollowUpToolHandler } from "../../scheduled-actions/agent-follow-up-tool";
import { ScheduledThreadActionService } from "../../scheduled-actions/scheduled-thread-action-service";
import type { StateDb } from "../../state/state-db";
import { ScheduledThreadActionStore } from "../../storage/scheduled-thread-action-store";

export const FOLLOW_UP_THREAD = { backend: "codex" as const, threadId: "thread-follow-up" };
const LOCK_REFUSAL = "This thread is locked. Unlock it to send.";
const LEASE_MS = 30_000;

/**
 * Where the owning process dies during one dispatch:
 * - `before_admit`: the claim is committed, the provider never saw the turn.
 * - `after_admit`: the provider accepted the turn, and the confirmation was
 *   never written.
 * - `after_queue_start`: the turn waited in the in-memory queue, the queue
 *   started it, and the start event was never handled.
 */
export type CrashPoint = "before_admit" | "after_admit" | "after_queue_start";

type QueueEntry = { id: string; actionId: string; held: boolean };

/**
 * The real scheduled-action service and store over a real database, with a
 * stand-in for the provider and the thread's in-memory queue. `admissions` is
 * the provider's own record of the turns it accepted, which survives every
 * crash, so it is the oracle for "how many turns did this follow-up start".
 */
export class AgentFollowUpWorld {
  /** Wall clock the service reads. A rollback moves it back. */
  clock = 1_800_000_000_000;
  /** Elapsed real time. Never moves back. */
  trueTime = 0;
  locked = false;
  busy = false;
  gateClosed = false;
  alive = false;
  armedCrash: CrashPoint | undefined;
  /**
   * The scheduler's ten-second lease heartbeat, run on every tick. A write
   * budget turns it off: the heartbeat predates follow-ups, and its renewal
   * statement would be counted against them.
   */
  heartbeatOnTick = true;
  readonly admissions: Array<{ actionId: string; trueTime: number }> = [];
  service!: ScheduledThreadActionService;
  store!: ScheduledThreadActionStore;
  private queue: QueueEntry[] = [];
  private listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private gateListeners = new Set<(closed: boolean) => void>();
  private heartbeat: (() => void) | undefined;
  private generation = 0;
  private readonly payloads = new MemoryScheduledThreadActionPayloadStore();
  private tool!: ReturnType<typeof buildAgentFollowUpToolHandler>;
  /** Runs when the provider accepts a follow-up's turn: the woken agent. */
  onWake: ((actionId: string) => Promise<void>) | undefined;
  private wakes: string[] = [];

  constructor(private readonly db: StateDb) {}

  admittedCount(actionId: string): number {
    return this.admissions.filter((admission) => admission.actionId === actionId).length;
  }

  /** A new process on the same profile. Clears nothing durable. */
  async start(): Promise<void> {
    const generation = ++this.generation;
    const ownerId = `scheduler:test:${generation}`;
    this.queue = [];
    this.listeners = new Set();
    this.gateListeners = new Set();
    this.store = new ScheduledThreadActionStore(this.db, this.payloads);
    this.service = new ScheduledThreadActionService({
      registry: this.registry(generation),
      store: this.store,
      now: () => this.clock,
      ownerId,
      isOwnerAlive: (candidate) => candidate === ownerId && this.generation === generation,
      setTimer: () => ({}) as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      setLeaseTimer: (callback) => {
        this.heartbeat = callback;
        return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
      },
      clearLeaseTimer: () => undefined,
    });
    this.tool = buildAgentFollowUpToolHandler(this.service, () => this.clock);
    this.alive = true;
    this.service.start();
    await this.settle();
  }

  /** The process dies where it stands: no shutdown code runs. */
  crash(): void {
    this.generation += 1;
    this.alive = false;
    this.armedCrash = undefined;
    this.queue = [];
    this.listeners = new Set();
    this.heartbeat = undefined;
  }

  /** The next launch, after the dead owner's lease has run out. */
  async restart(): Promise<void> {
    if (this.alive) this.crash();
    this.advanceClock(LEASE_MS + 1);
    await this.start();
  }

  advanceClock(ms: number): void {
    this.clock += ms;
    this.trueTime += ms;
  }

  /** Time passes, then the service's own timer and heartbeat run. */
  async tick(ms: number): Promise<void> {
    this.advanceClock(ms);
    if (!this.alive) return;
    if (this.heartbeatOnTick) this.heartbeat?.();
    void this.service.evaluateDueActions();
    await this.settle();
  }

  async callTool(args: ScheduleFollowUpToolArgs): Promise<PwrAgentThreadInspectionResponse> {
    return await this.tool(args, FOLLOW_UP_THREAD, {});
  }

  /** The agent's create. Returns the new id, or the refusal's message. */
  async create(delayMinutes: number, prompt = "Check the deploy and report."): Promise<{ id: string } | { refused: string }> {
    const response = await this.callTool({ action: "create", delayMinutes, prompt });
    if (!response.ok) return { refused: response.error.message };
    return { id: (response.data as { followUps: ScheduleFollowUpToolResult }).followUps.followUp!.followUpId };
  }

  async setLocked(locked: boolean): Promise<void> {
    this.locked = locked;
    if (!locked) await this.drain();
  }

  async setBusy(busy: boolean): Promise<void> {
    this.busy = busy;
    if (!busy) await this.drain();
  }

  async setGateClosed(closed: boolean): Promise<void> {
    this.gateClosed = closed;
    for (const listener of this.gateListeners) listener(closed);
    await this.settle();
  }

  actions(): ScheduledThreadAction[] {
    return this.store.list({ ...FOLLOW_UP_THREAD, includeTerminal: true });
  }

  /** Lets every promise the fakes resolved run, and any woken agent act. */
  async settle(): Promise<void> {
    for (let round = 0; round < 50; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const actionId = this.wakes.shift();
      if (actionId === undefined) return;
      await this.onWake?.(actionId);
      if (this.alive) void this.service.evaluateDueActions();
    }
    throw new Error("The follow-up world did not settle.");
  }

  private admit(actionId: string): void {
    this.admissions.push({ actionId, trueTime: this.trueTime });
    this.wakes.push(actionId);
  }

  /** The queue starts what it can once the thread is free and unlocked. */
  private async drain(): Promise<void> {
    while (this.alive && !this.busy && !this.locked && this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.held) {
        // The real queue announces a released hold as queued, while the entry
        // is still in it, before it starts it.
        head.held = false;
        await this.emit(head.id, "queued");
        if (!this.alive) return;
        continue;
      }
      const entry = this.queue.shift()!;
      this.admit(entry.actionId);
      if (this.armedCrash === "after_queue_start") {
        this.crash();
        return;
      }
      await this.emit(entry.id, "started");
    }
    await this.settle();
  }

  private async emit(queueEntryId: string, status: "queued" | "started"): Promise<void> {
    const event = {
      backend: FOLLOW_UP_THREAD.backend,
      notification: {
        method: "thread/turnQueue/updated",
        params: { queueEntryId, status, threadId: FOLLOW_UP_THREAD.threadId, turnId: `turn:${queueEntryId}` },
      },
    } as unknown as AgentEvent;
    for (const listener of this.listeners) await listener(event);
  }

  private registry(generation: number): DesktopBackendRegistry {
    const dead = (): boolean => this.generation !== generation;
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
    const actionIdOf = (queueEntryId: string): string => queueEntryId.replace(/^scheduled-turn:/, "");
    const entryFor = (queueEntryId: string, holdReason?: string) => ({
      id: queueEntryId,
      ...FOLLOW_UP_THREAD,
      origin: "scheduled" as const,
      input: [],
      createdAt: this.clock,
      ...(holdReason ? { holdReason, manualReleaseRequired: true } : {}),
    });
    return {
      onEvent: (listener: (event: AgentEvent) => void | Promise<void>) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      onRestartGateChanged: (listener: (closed: boolean) => void) => {
        this.gateListeners.add(listener);
        return () => this.gateListeners.delete(listener);
      },
      isRestartGateClosed: () => this.gateClosed,
      publishLocalEvent: async () => undefined,
      markScheduledThreadBorn: async () => undefined,
      markScheduledThreadStartTerminal: async () => undefined,
      cancelQueuedTurn: (queueEntryId: string) => {
        const index = this.queue.findIndex((entry) => entry.id === queueEntryId);
        if (dead() || index < 0) return false;
        this.queue.splice(index, 1);
        return true;
      },
      submitTurn: async (turn: { queueEntryId: string }) => {
        if (dead()) return await never();
        if (this.locked) throw new Error(LOCK_REFUSAL);
        const actionId = actionIdOf(turn.queueEntryId);
        if (this.armedCrash === "before_admit") {
          this.crash();
          return await never();
        }
        if (this.busy) {
          this.queue.push({ id: turn.queueEntryId, actionId, held: false });
          return { status: "queued", entry: entryFor(turn.queueEntryId), position: this.queue.length };
        }
        this.admit(actionId);
        if (this.armedCrash === "after_admit") {
          this.crash();
          return await never();
        }
        return { status: "started", entry: entryFor(turn.queueEntryId), turnId: `turn:${turn.queueEntryId}` };
      },
      submitHeldTurn: async (turn: { queueEntryId: string; holdReason: string }) => {
        if (dead()) return await never();
        // A lock's hold starts when the thread is unlocked; the queue keeps it.
        this.queue.push({ id: turn.queueEntryId, actionId: actionIdOf(turn.queueEntryId), held: true });
        return { status: "queued", entry: entryFor(turn.queueEntryId, turn.holdReason), position: this.queue.length };
      },
      releaseQueuedTurnWithDisposition: async (queueEntryId: string) => {
        if (dead()) return await never();
        const index = this.queue.findIndex((entry) => entry.id === queueEntryId);
        if (index < 0) return { queueEntryId, disposition: "not_found" };
        if (this.locked) return { queueEntryId, disposition: "blocked", errorMessage: LOCK_REFUSAL };
        if (this.busy) return { queueEntryId, disposition: "busy" };
        const [entry] = this.queue.splice(index, 1);
        this.admit(entry!.actionId);
        return { queueEntryId, disposition: "started", turnId: `turn:${queueEntryId}` };
      },
    } as unknown as DesktopBackendRegistry;
  }
}
