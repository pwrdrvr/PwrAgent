import fc from "fast-check";
import { expect } from "vitest";
import {
  RESEARCH_FINDING_KINDS, RESEARCH_WORK_TRANSITIONS, type ResearchActor, type ResearchCommand, type ResearchEvent, type ResearchRun, type ResearchThread, type ResearchWorkCommand, type StartResearchRequest,
} from "@pwragent/shared/research";
import { ResearchAdmissionRefused, ResearchService, type ResearchExecutionContext, type ResearchPorts } from "../../research-service";
import type { ResearchStorage } from "../../research-storage";
import { ReplayMemoryStorage, ReplayResearchService } from "./research-service-replay-reference";

/**
 * A differential test of the research service against the service it
 * replaced. `ReplayResearchService` validates every command and observation
 * by replaying the run's journal; `ResearchService` validates against stored
 * projections. One generated sequence runs through both. After every step
 * they must have accepted or refused alike, with the same message, made the
 * same port calls, and hold the same journals.
 *
 * Both services draw IDs from `randomUUID`. The test file mocks `node:crypto`
 * to call `uuid.next`, which this harness points at the world taking its
 * turn, so each world numbers its own IDs and equal histories give equal IDs.
 */
export type UuidSource = { next: () => string };

type Faults = {
  spawn: "ok" | "refused" | "error" | "no_turn";
  stop: "ok" | "error";
  notify: "plain" | "queued" | "turn" | "error";
  cancel: "plain" | "turn" | "error";
};

/**
 * Weighted so a run lives long enough to collect findings, candidates, reviews, revisions and focused children:
 * the steps that end every run (a restart, disabling research, a stop) are rare.
 */
const STEP_WEIGHTS = {
  start: 5, finding: 14, submit: 8, review: 10, direction: 3, abandon: 2, stop: 1, finish: 2, work: 10, assign: 8,
  observe_start: 4, observe_end: 9, observe_queue: 8, advance: 3, toggle: 1, stop_owned: 1, restart: 1, repeat: 3, resend: 4, reuse: 2, read: 3, bounds: 4,
} as const;
type StepKind = keyof typeof STEP_WEIGHTS;
const stepKinds = (weights: Partial<Record<StepKind, number>>) => (Object.entries(weights) as [StepKind, number][]).flatMap(([kind, weight]) => Array.from({ length: weight }, () => kind));
/**
 * Weighted toward what a per-worker time limit and total worker time need to be reached: runs that set them,
 * turns that start and run on, the operator changing them, restarts, and time passing for their timers to fire.
 */
const BOUNDS_STEP_WEIGHTS: Partial<Record<StepKind, number>> = {
  start: 5, finding: 3, submit: 3, review: 2, work: 2, assign: 3, observe_start: 6, observe_end: 4, advance: 12, bounds: 8, restart: 2, stop: 1, repeat: 2, resend: 2, read: 1,
};

const stepArb = (weights: Partial<Record<StepKind, number>>) => fc.record({
  kind: fc.constantFrom(...stepKinds(weights)),
  run: fc.nat(), actor: fc.nat(), approach: fc.nat(), item: fc.nat(), other: fc.nat(), variant: fc.nat(), flag: fc.boolean(),
  faults: fc.record<Faults>({
    spawn: fc.constantFrom("ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "refused", "error", "no_turn"),
    stop: fc.constantFrom("ok", "ok", "ok", "ok", "ok", "error"),
    notify: fc.constantFrom("plain", "queued", "queued", "turn", "error"),
    cancel: fc.constantFrom("plain", "plain", "turn", "error"),
  }),
});
export const researchDifferentialStepArb = stepArb(STEP_WEIGHTS);
export const researchDifferentialBoundsStepArb = stepArb(BOUNDS_STEP_WEIGHTS);
export type ResearchDifferentialStep = typeof researchDifferentialStepArb extends fc.Arbitrary<infer T> ? T : never;

/** What the generated sequences reached, so a test can show its generator crosses the rules it claims to compare. */
export type ResearchDifferentialCoverage = { accepted: Record<string, number>; refused: Record<string, number>; events: Record<string, number>; refusals: Record<string, number> };
export function emptyResearchDifferentialCoverage(): ResearchDifferentialCoverage { return { accepted: {}, refused: {}, events: {}, refusals: {} }; }

const COORDINATOR: ResearchThread = { backend: "codex", threadId: "coordinator" };
const STRANGER: ResearchThread = { backend: "codex", threadId: "stranger" };

/** The methods both services share. Results are compared after `summary`. */
type Service = Pick<ResearchService, "initialize" | "close" | "work" | "assign" | "observeQueue" | "observeStart" | "observeEnd" | "stopOwnedRuns" | "isWorker" | "readItem" | "search" | "withdraw"> & {
  start: (...args: Parameters<ResearchService["start"]>) => Promise<{ id: string; revision: number; status: string }>;
  update: (...args: Parameters<ResearchService["update"]>) => Promise<{ id: string; revision: number; status: string }>;
  summaries: (thread: ResearchThread) => { id: string; revision: number; status: string; activeWorkers: number }[];
};

type World = {
  name: string;
  service: Service;
  /** A new service on the same storage, as after a restart. */
  renew: () => void;
  journal: (id: string) => ResearchEvent[] | undefined;
  ports: ResearchPorts;
  calls: string[];
  uuids: number;
  spawned: number;
  queued: number;
  now: number;
  enabled: boolean;
  ownerId: string;
  timers: { at: number; run: () => void; cancelled: boolean }[];
  faults: Faults;
};

function createWorld(name: string, create: (ports: ResearchPorts) => Service, journal: World["journal"]): World {
  const world: World = { name, journal, calls: [], uuids: 0, spawned: 0, queued: 0, now: 1000, enabled: true, ownerId: "owner-1", timers: [],
    faults: { spawn: "ok", stop: "ok", notify: "plain", cancel: "plain" }, service: undefined as unknown as Service, ports: undefined as unknown as ResearchPorts,
    renew: () => { world.ports = ports(); world.service = create(world.ports); } };
  const ports = (): ResearchPorts => ({
    ownerId: world.ownerId, ownerPid: 123, ownerStartedAt: 500, isOwnerAlive: () => false, now: () => world.now, enabled: () => world.enabled,
    schedule: (run, delay) => {
      const timer = { at: world.now + delay, run, cancelled: false };
      world.timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    // The two services notify at different grain by design; what they notify about is the journal, which is compared.
    changed: () => {},
    onError: (error) => { world.calls.push(`onError ${error instanceof Error ? error.message : String(error)}`); },
    spawn: async (context, task, title, mode, created) => {
      world.calls.push(`spawn ${context.threadId} ${title} ${mode} ${task}`);
      if (world.faults.spawn === "refused") throw new ResearchAdmissionRefused("Admission refused");
      const worker = { backend: "codex" as const, threadId: `worker-${++world.spawned}` };
      created(worker);
      if (world.faults.spawn === "error") throw new Error("Lost start response");
      return world.faults.spawn === "no_turn" ? worker : { ...worker, turnId: `turn-${world.spawned}` };
    },
    stop: async (worker) => {
      world.calls.push(`stop ${worker.threadId} ${worker.turnId}`);
      if (world.faults.stop === "error") throw new Error("Lost cancellation response");
    },
    notify: async (context, target, text) => {
      world.calls.push(`notify ${context.kind}:${context.threadId} ${target.threadId} ${text}`);
      if (world.faults.notify === "error") throw new Error("Lost delivery response");
      return world.faults.notify === "queued" ? { queueEntryId: `queue-${++world.queued}` } : world.faults.notify === "turn" ? { turnId: `revision-turn-${++world.queued}` } : {};
    },
    cancelQueued: async (queueEntryId) => {
      world.calls.push(`cancelQueued ${queueEntryId}`);
      if (world.faults.cancel === "error") throw new Error("Lost queue cancellation response");
      return world.faults.cancel === "turn" ? { turnId: `admitted-${queueEntryId}` } : {};
    },
  });
  world.renew();
  return world;
}

/** What the step does, resolved once against the reference world's runs so both worlds get the same call. */
type Action = (world: World) => unknown;

function summary(result: unknown): unknown {
  if (Array.isArray(result)) return result.map(summary);
  if (result && typeof result === "object" && "objective" in result && "status" in result) {
    const run = result as unknown as { id: string; revision: number; status: string; activeWorkers: number } & Partial<Record<"workerLimit" | "deadlineAt" | "turnMinutes" | "totalWorkerMinutes", number>>;
    // The bounds as a header reads them, which the stored projection must answer as replay does.
    return { id: run.id, revision: run.revision, status: run.status, activeWorkers: run.activeWorkers,
      bounds: [run.workerLimit, run.deadlineAt, run.turnMinutes, run.totalWorkerMinutes] };
  }
  return result;
}

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/**
 * Run `steps` through the replay-based reference and through a projection-based
 * service on `storage`, and expect them to agree after every step. `journal`
 * reads a run's events without going through the storage the service holds:
 * that storage's `get` throws, because no command or observer may replay.
 */
export async function expectResearchServicesAgree(uuid: UuidSource, steps: ResearchDifferentialStep[], storage: ResearchStorage, journal: (id: string) => ResearchEvent[] | undefined,
  coverage: ResearchDifferentialCoverage = emptyResearchDifferentialCoverage()): Promise<void> {
  const reference = new ReplayMemoryStorage();
  // The service sees every method but `get`. A storage's own methods still reach its `get`, as the in-memory oracle's do.
  const guarded = new Proxy(storage, { get: (target, property) => {
    if (property === "get") return () => { throw new Error("A command or observer replayed the journal"); };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) as unknown : value;
  } });
  const worlds = [
    createWorld("replay", (ports) => new ReplayResearchService(reference, ports) as unknown as Service, (id) => reference.records.get(id)),
    createWorld("projection", (ports) => new ResearchService(guarded, ports) as unknown as Service, journal),
  ];
  const previous: { action?: Action; resend?: (sender: ResearchActor) => Action; requestId?: string; runId?: string; actor?: ResearchActor } = {};
  let requests = 0;
  let calls = 0;
  const compared = new Map<string, number>();

  for (const [index, step] of steps.entries()) {
    const runs = [...reference.records.keys()].map((id) => reference.get(id)!);
    // Little can be compared without a run that accepts work, so half the steps that find none start one.
    const action = resolve(runs.some((run) => run.status === "running") || runs.length >= 4 || (runs.length && step.run % 2) ? step : { ...step, kind: "start", variant: step.variant % 3, actor: 0 }, runs, index);
    const outcomes: unknown[] = [];
    for (const world of worlds) {
      uuid.next = () => `00000000-0000-4000-8000-${String(++world.uuids).padStart(12, "0")}`;
      world.faults = step.faults;
      world.calls = [];
      let outcome: unknown;
      try { outcome = { ok: summary(await action(world)) }; }
      catch (error) { outcome = { refused: error instanceof Error ? error.message : String(error) }; }
      outcomes.push({ outcome, calls: world.calls });
    }
    const context = `step ${index} ${step.kind}`;
    expect(outcomes[1], context).toEqual(outcomes[0]);
    const outcome = (outcomes[0] as { outcome: { ok: unknown } | { refused: string } }).outcome;
    const tally = "ok" in outcome ? coverage.accepted : coverage.refused;
    tally[step.kind] = (tally[step.kind] ?? 0) + 1;
    if ("refused" in outcome) coverage.refusals[outcome.refused] = (coverage.refusals[outcome.refused] ?? 0) + 1;
    // An append-only journal that did not grow did not change; one that grew is compared whole.
    for (const [id, events] of reference.records) {
      const stored = worlds[1]!.journal(id);
      expect(stored?.length, `${context}: revision of ${id}`).toBe(events.length);
      if (compared.get(id) === events.length) continue;
      expect(stored, `${context}: journal of ${id}`).toEqual(events);
      compared.set(id, events.length);
    }
    const spawned = worlds[0]!.spawned;
    const sampled = spawned ? [...new Set([step.actor, step.other, spawned - 1].map((n) => 1 + n % spawned))].map((n) => ({ backend: "codex" as const, threadId: `worker-${n}` })) : [];
    for (const thread of [COORDINATOR, STRANGER, ...sampled]) {
      expect(worlds[1]!.service.isWorker(thread), `${context}: isWorker ${thread.threadId}`).toBe(worlds[0]!.service.isWorker(thread));
      expect(summary(worlds[1]!.service.summaries(thread)), `${context}: summaries ${thread.threadId}`).toEqual(summary(worlds[0]!.service.summaries(thread)));
    }
  }
  for (const events of reference.records.values()) for (const event of events) {
    // The bounds' own outcomes, which only their timers produce, are tallied apart so a test can require them.
    const key = event.data.type === "worker" && event.data.note?.startsWith("Stopped at the per-worker time limit") ? "worker:turn-limit"
      : event.data.type === "status" && event.data.reason.endsWith("Total worker time reached") ? "status:worker-time" : event.data.type;
    coverage.events[key] = (coverage.events[key] ?? 0) + 1;
  }
  for (const world of worlds) world.service.close();

  function resolve(step: ResearchDifferentialStep, runs: ResearchRun[], position: number): Action {
    // Mostly a run that still accepts work, so the sequence builds on it; sometimes a finished one, which must refuse.
    const live = runs.filter((entry) => entry.status === "running");
    const pool = live.length && step.run % 6 !== 5 ? live : runs;
    const run = pool.length ? pool[step.run % pool.length] : undefined;
    const runId = run?.id ?? "missing";
    const approaches = run?.approaches ?? [];
    const items = run?.items ?? [];
    const item = items.length ? items[step.item % items.length] : undefined;
    const itemId = step.item % 13 === 12 ? "missing" : item?.id ?? "missing";
    const workerApproach = approaches.length ? approaches[step.actor % approaches.length] : undefined;
    const worker = workerApproach?.worker;
    const call = `call-${++calls}`;
    const coordinator: ResearchExecutionContext = { ...COORDINATOR, kind: "agent", turnId: "parent-turn", callId: call };
    // Reviews, assignments and stops are the coordinator's to make, so it makes most of them.
    const lead = ["review", "assign", "stop", "finish"].includes(step.kind) && step.actor % 4 !== 3;
    const role = lead ? step.actor % 4 : step.actor % 8;
    const actor: ResearchActor = [0, 1, 2].includes(role) ? coordinator : role === 3 ? { ...COORDINATOR, kind: "operator" }
      : role === 7 || (!worker && role === 6) ? { ...STRANGER, kind: "agent", turnId: "stranger-turn", callId: call }
        : !worker ? coordinator : { backend: worker.backend, threadId: worker.threadId, kind: "agent", turnId: worker.turnId ?? "worker-turn", callId: call };
    // A worker mostly posts under its own approach, and sometimes under another's, which is refused.
    const own = actor.threadId === worker?.threadId && step.approach % 4 !== 3 ? workerApproach : undefined;
    const approach = own ?? (approaches.length ? approaches[step.approach % approaches.length] : undefined);
    const approachId = step.approach % 11 === 10 ? "a9" : approach?.id ?? "a1";
    const text = `${["Queue reversal", "OWNER lifetime", "100%_literal", "ÉTUDE α"][step.variant % 4]} ${position}`;
    const update = (command: ResearchCommand): Action => {
      const requestId = `request-${++requests}`;
      const resend = (sender: ResearchActor): Action => async (world) => await world.service.update(runId, requestId, structuredClone(command), sender);
      const action = resend(actor);
      Object.assign(previous, { action, resend, requestId, runId, actor });
      return action;
    };
    switch (step.kind) {
      case "start": {
        const count = step.variant % 9 === 8 ? 0 : 1 + step.variant % 3;
        // Sometimes with a per-worker time limit or total worker time, which arm timers the advance steps fire.
        const request: StartResearchRequest = { objective: `Objective ${text}`, minutes: 1 + step.other % 20, workspaceMode: step.flag ? "none" : "new_worktree",
          ...(step.variant % 4 === 1 ? { turnMinutes: 1 + step.item % 15 } : {}), ...(step.variant % 5 === 2 ? { totalWorkerMinutes: 1 + step.approach % 30 } : {}),
          approaches: Array.from({ length: count }, (_, n) => ({ title: step.variant % 7 === 6 ? "Same title" : `Approach ${n + 1}`, task: `Task ${n + 1}` })) };
        // Mostly a new call; sometimes an earlier call ID, which repeats that start or reuses its key with other arguments.
        const context: ResearchExecutionContext = { ...(step.actor % 8 >= 4 && actor.kind === "agent" ? actor as ResearchExecutionContext : coordinator), callId: step.other % 4 === 3 ? `start-${step.item % 2}` : `start-${call}` };
        return async (world) => {
          // Research that a toggle step disabled is enabled again by a later start.
          if (step.item % 2) world.enabled = true;
          return await world.service.start(structuredClone(request), context);
        };
      }
      case "finding": {
        const findings = items.filter((entry) => entry.type === "finding");
        const related = step.variant % 3 === 0 ? { relatesTo: step.other % 6 === 5 ? itemId : findings[step.other % Math.max(1, findings.length)]?.id ?? "missing", relation: "supports" as const } : {};
        return update({ action: "finding", approachId, kind: step.variant % 17 === 16 ? "invalid" as never : RESEARCH_FINDING_KINDS[step.variant % RESEARCH_FINDING_KINDS.length]!, text,
          paths: step.other % 9 === 8 ? ["/absolute"] : step.flag ? ["evidence/result.txt"] : [], ...related });
      }
      case "submit": return update({ action: "submit", approachId, text: step.variant % 19 === 18 ? " " : text, paths: [] });
      case "review": {
        const submissions = run?.submissions ?? [];
        // With nothing to review yet, mostly submit a candidate instead.
        if (!submissions.length && step.other % 4) return update({ action: "submit", approachId, text, paths: [] });
        const submissionId = step.other % 7 === 6 ? itemId : submissions[step.other % Math.max(1, submissions.length)]?.id ?? "missing";
        return update({ action: "review", submissionId, decision: (["accepted", "revision_requested", "revision_requested", "rejected"] as const)[step.variant % 4]!, reason: text });
      }
      case "direction": return update({ action: "direction", approachId, title: `Retitled ${position}`, task: text, reason: "Narrowed",
        ...(step.flag && approaches.length ? { overlapsApproachId: approaches[step.other % approaches.length]!.id } : {}) });
      case "abandon": return update({ action: "abandon", approachId, reason: text });
      case "stop": return update({ action: "stop", reason: text });
      case "finish": return update({ action: "finish", reason: text });
      case "work": {
        const states = ["open", "claimed", "in_progress", "blocked", "completed", "cancelled", "cancelled"] as const;
        // Mostly a transition the item's state allows; sometimes any state, which the transition table may refuse.
        const allowed = item ? RESEARCH_WORK_TRANSITIONS[item.work.state].filter((state) => (states as readonly string[]).includes(state)) as typeof states[number][] : [];
        const state = allowed.length && step.variant % 5 !== 4 ? allowed[step.variant % allowed.length]! : states[step.variant % states.length]!;
        const command: ResearchWorkCommand = { action: "work", itemId, expectedVersion: (item?.version ?? 1) - (step.other % 6 === 5 ? 1 : 0), state, reason: text };
        const requestId = `request-${++requests}`;
        // Through `update` or directly, as the tool and the panel reach it.
        const resend = (sender: ResearchActor): Action => step.flag ? async (world) => await world.service.update(runId, requestId, { ...command }, sender)
          : async (world) => await world.service.work(runId, requestId, { ...command }, sender);
        const action = resend(actor);
        Object.assign(previous, { action, resend, requestId, runId, actor });
        return action;
      }
      case "assign": {
        const request = { runId, itemId, expectedVersion: (item?.version ?? 1) - (step.other % 6 === 5 ? 1 : 0), task: text };
        const context: ResearchExecutionContext = { ...(actor.kind === "agent" ? actor as ResearchExecutionContext : coordinator), callId: step.other % 5 === 4 ? "assign-shared" : call };
        return async (world) => await world.service.assign({ ...request }, context);
      }
      case "observe_start": {
        const thread = worker ?? STRANGER;
        return async (world) => await world.service.observeStart({ backend: thread.backend, threadId: thread.threadId }, step.flag ? `reopened-${step.other % 3}` : worker?.turnId ?? "unknown-turn");
      }
      case "observe_end": {
        const thread = worker ?? STRANGER;
        const turnId = step.other % 4 === 3 ? "unrelated-turn" : step.other % 4 === 2 ? `reopened-${step.variant % 3}` : worker?.turnId ?? "unknown-turn";
        return (world) => world.service.observeEnd({ backend: thread.backend, threadId: thread.threadId }, turnId, step.flag ? { failed: true, note: "Provider error" } : {});
      }
      case "observe_queue": {
        const deliveries = run?.deliveries ?? [];
        const delivery = deliveries.length ? deliveries[step.other % deliveries.length] : undefined;
        const thread = delivery?.target ?? worker ?? STRANGER;
        const queueEntryId = step.variant % 6 === 5 ? "queue-unknown" : delivery?.queueEntryId ?? `queue-${1 + step.other % 3}`;
        const status = (["started", "terminal", "terminal", "cancelled", "queued"] as const)[step.variant % 5]!;
        return async (world) => await world.service.observeQueue({ backend: thread.backend, threadId: thread.threadId }, queueEntryId, status, step.flag ? `revision-turn-${step.other % 3}` : undefined);
      }
      case "advance": return async (world) => {
        // Mostly a short wait; sometimes long enough to pass a deadline.
        world.now += step.other % 8 === 7 ? (1 + step.variant % 25) * 60_000 : 30_000;
        const due = world.timers.filter((timer) => !timer.cancelled && timer.at <= world.now);
        world.timers = world.timers.filter((timer) => !due.includes(timer));
        for (const timer of due) timer.run();
        // Deadline callbacks start asynchronous stops without returning their promises.
        if (due.length) await flush();
      };
      case "toggle": return async (world) => {
        world.enabled = false;
        await world.service.stopOwnedRuns("Research disabled");
      };
      case "stop_owned": return async (world) => await world.service.stopOwnedRuns(text);
      case "restart": return (world) => {
        world.service.close();
        world.timers = [];
        if (step.flag) world.ownerId = `owner-${2 + step.other % 2}`;
        world.renew();
        world.service.initialize();
      };
      // The operator's change to a run's bounds: mostly a valid one, sometimes out of range, already passed or empty, and sometimes sent by an agent.
      case "bounds": {
        const choose = (n: number) => n % 4 === 0 ? undefined : n % 4 === 1 ? null : 1 + n % 25;
        const fields = { workers: step.variant % 3 ? step.variant % 7 : undefined, minutes: choose(step.other), turnMinutes: choose(step.item), totalWorkerMinutes: choose(step.approach) };
        const command = { action: "bounds", ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) } as ResearchCommand;
        const requestId = `request-${++requests}`;
        const sender: ResearchActor = step.flag || step.actor % 5 ? { ...COORDINATOR, kind: "operator" } : actor;
        const resend = (from: ResearchActor): Action => async (world) => await world.service.update(runId, requestId, structuredClone(command), from);
        const action = resend(sender);
        Object.assign(previous, { action, resend, requestId, runId, actor: sender });
        return action;
      }
      // The last command again, exactly: a redelivery, which must not append twice.
      case "repeat": return previous.action ?? (() => undefined);
      // The last command again, key and content, from another sender: the same thread acting as operator instead of agent, or another thread.
      case "resend": {
        const sender = previous.actor;
        if (!previous.resend || !sender) return () => undefined;
        return previous.resend(step.flag ? { backend: sender.backend, threadId: sender.threadId, kind: sender.kind === "agent" ? "operator" : "agent" } : actor);
      }
      // The last command's key with another command: refused, whoever sends it.
      case "reuse": {
        const { requestId, runId: target, actor: sender } = previous;
        if (!requestId || !target || !sender) return () => undefined;
        return async (world) => await world.service.update(target, requestId, { action: "abandon", approachId, reason: text }, step.flag ? sender : actor);
      }
      default: return (world) => ({
        item: attempt(() => world.service.readItem(runId, itemId, actor)),
        search: attempt(() => world.service.search(runId, { query: step.flag ? "queue" : undefined, limit: 5 }, actor)),
      });
    }
  }
}

function attempt<T>(read: () => T): { ok: T } | { refused: string } {
  try { return { ok: read() }; } catch (error) { return { refused: error instanceof Error ? error.message : String(error) }; }
}
