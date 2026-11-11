import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadIdentityKey,
  DEFAULT_THREAD_ARCHIVE_POLICY,
  type AppServerThreadSummary,
  type ThreadOverlayState,
  type WorktreeSnapshotSummary,
} from "@pwragent/shared";
import {
  archivedThreadFamilies,
  archiveRetentionFamilyEligible,
  sweepThreadArchiveRetention,
  type ThreadArchiveRetentionDeps,
} from "../app-server/thread-archive-retention";

/**
 * Oracle tests. `familyByScan` and `sweepByFullReads` are the retention
 * sweep before its indexes: it scanned the whole thread list for each family
 * member's children, and re-read every archive state after each family it
 * deleted. The indexed sweep must make the same calls, in the same order,
 * with the same arguments, for any inventory and any change made while a
 * family is being deleted.
 */
function familyByScan(root: AppServerThreadSummary, threads: AppServerThreadSummary[]): AppServerThreadSummary[] {
  const family: AppServerThreadSummary[] = [];
  const seen = new Set<string>();
  const visit = (thread: AppServerThreadSummary) => {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    if (seen.has(key)) return;
    seen.add(key);
    family.push(thread);
    for (const child of threads) {
      if (child.source === thread.source && child.codexNativeSubAgent?.parentThreadId === thread.id) visit(child);
    }
  };
  visit(root);
  return family;
}

async function sweepByFullReads(deps: ThreadArchiveRetentionDeps): Promise<number> {
  const policy = deps.getPolicy();
  let deleted = 0;
  if (deps.shouldStop?.()) return deleted;
  const threads = await deps.listThreads();
  const archived = threads.filter((thread) => thread.archivedAt !== undefined);
  await deps.observeArchives(archived, Date.now());
  let states = await deps.listStates();
  if (policy.retentionDays === 0) return deleted;
  const byKey = new Map(states.map((state) => [buildThreadIdentityKey(state.backend, state.threadId), state]));
  const providerKeys = new Set(threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
  const removed = new Set<string>();
  const cleanup = async (victims: ThreadOverlayState[]) => {
    const keys = new Set(victims.map((state) => buildThreadIdentityKey(state.backend, state.threadId)));
    states = await deps.listStates();
    if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return;
    for (const victim of victims) {
      const current = states.find((state) => state.backend === victim.backend && state.threadId === victim.threadId);
      if (current && (current.archiveRetentionStartedAt !== victim.archiveRetentionStartedAt
        || current.pinnedRank !== undefined || current.agent)) return;
    }
    const otherRefs = new Set(states.filter((state) => !keys.has(buildThreadIdentityKey(state.backend, state.threadId)))
      .flatMap((state) => (state.worktreeSnapshots ?? []).map((snapshot) => `${snapshot.repositoryPath}:${snapshot.snapshotRef}`)));
    const snapshots = new Map(victims.flatMap((state) => state.worktreeSnapshots ?? [])
      .map((snapshot) => [`${snapshot.repositoryPath}:${snapshot.snapshotRef}`, snapshot]));
    for (const [key, snapshot] of snapshots) {
      if (deps.shouldStop?.()) return;
      if (!otherRefs.has(key)) await deps.deleteSnapshot(snapshot);
    }
    if (deps.shouldStop?.()) return;
    await deps.forgetStates(victims);
    for (const key of keys) removed.add(key);
  };
  for (const root of archived) {
    if (deps.shouldStop?.()) return deleted;
    const rootKey = buildThreadIdentityKey(root.source, root.id);
    const parent = root.codexNativeSubAgent?.parentThreadId;
    if (removed.has(rootKey) || (parent && providerKeys.has(buildThreadIdentityKey(root.source, parent)))) continue;
    const family = familyByScan(root, threads).map((thread) => ({
      thread, overlay: byKey.get(buildThreadIdentityKey(thread.source, thread.id)),
    }));
    if (!archiveRetentionFamilyEligible(family, policy, deps.isBusy, Date.now())) continue;
    try {
      if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return deleted;
      await deps.deleteFamily(family, policy);
      deleted += 1;
      await cleanup(family.map((candidate) => candidate.overlay!));
    } catch (error) { deps.onError(error, root.id); }
  }
  for (const state of states) {
    if (deps.shouldStop?.()) return deleted;
    const key = buildThreadIdentityKey(state.backend, state.threadId);
    const startedAt = state.archiveRetentionStartedAt;
    if (providerKeys.has(key) || removed.has(key) || startedAt === undefined
      || !Number.isFinite(startedAt) || startedAt <= 0
      || Date.now() < startedAt + policy.retentionDays * 86_400_000
      || state.pinnedRank !== undefined || state.agent) continue;
    try {
      if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return deleted;
      if (await deps.confirmAbsent(state)) await cleanup([state]);
    } catch (error) { deps.onError(error, state.threadId); }
  }
  return deleted;
}

const DAY = 86_400_000;
const NOW = 100 * DAY;
const SOURCES = ["codex", "claude"] as const;
const IDS = ["a", "b", "c", "d", "e", "f"];
const REPOS = ["/r1", "/r2"];
// Refs a store must search for literally: SQL wildcards and JSON escapes.
const REFS = ["refs/s/1", "refs/s/2", "refs/s/%_", "refs/s/\"q\""];

afterEach(() => { vi.useRealTimers(); });

const threadArb = fc.record({
  source: fc.constantFrom(...SOURCES),
  id: fc.constantFrom(...IDS),
  // A parent can be any id, the thread's own included, so cycles occur.
  parent: fc.option(fc.constantFrom(...IDS), { nil: undefined }),
  archived: fc.boolean(),
});
const snapshotArb = fc.record({ repo: fc.constantFrom(...REPOS), ref: fc.constantFrom(...REFS) });
const stateArb = fc.record({
  source: fc.constantFrom(...SOURCES),
  id: fc.constantFrom(...IDS, "gone1", "gone2"),
  // Mostly expired, so families and orphans reach cleanup.
  expired: fc.constantFrom(true, true, false, undefined),
  pinned: fc.boolean(),
  agent: fc.boolean(),
  snapshots: fc.array(snapshotArb, { maxLength: 2 }),
});
// Something another actor does while a family is being deleted.
const interferenceArb = fc.oneof(
  fc.constant({ kind: "none" as const }),
  fc.record({ kind: fc.constant("restore" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("pin" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("share" as const), at: fc.nat(), snapshot: snapshotArb }),
  fc.record({ kind: fc.constant("newState" as const), id: fc.constantFrom("new1", "new2"), snapshot: snapshotArb }),
);
const worldArb = fc.record({
  threads: fc.array(threadArb, { maxLength: 10 }),
  states: fc.array(stateArb, { maxLength: 10 }),
  busy: fc.array(fc.constantFrom(...IDS), { maxLength: 2 }),
  failing: fc.array(fc.constantFrom(...IDS), { maxLength: 2 }),
  present: fc.array(fc.constantFrom(...IDS, "gone1", "gone2"), { maxLength: 2 }),
  interference: fc.array(interferenceArb, { maxLength: 4 }),
  extras: fc.boolean(),
});
type World = typeof worldArb extends fc.Arbitrary<infer T> ? T : never;

function snapshotOf(input: { repo: string; ref: string }, threadId: string): WorktreeSnapshotSummary {
  return { id: `${input.repo}:${input.ref}:${threadId}`, backend: "codex", threadId, worktreePath: `${input.repo}/wt`,
    repositoryPath: input.repo, snapshotRef: input.ref, snapshotCommit: "abc", createdAt: DAY, state: "archived",
    ignoredFilesExcluded: true };
}

/** Runs one sweep against a fresh copy of the world and logs every call. */
async function run(world: World, sweep: (deps: ThreadArchiveRetentionDeps) => Promise<number>, narrowed: boolean) {
  const seenThreads = new Set<string>();
  let threads: AppServerThreadSummary[] = world.threads.flatMap((input) => {
    const key = buildThreadIdentityKey(input.source, input.id);
    if (seenThreads.has(key)) return [];
    seenThreads.add(key);
    return [{ id: input.id, title: input.id, titleSource: "explicit" as const, source: input.source, threadStatus: "notLoaded" as const,
      linkedDirectories: [], updatedAt: DAY,
      ...(input.archived ? { archivedAt: 5 * DAY } : {}),
      ...(input.parent ? { codexNativeSubAgent: { parentThreadId: input.parent } } : {}) } as AppServerThreadSummary];
  });
  const seenStates = new Set<string>();
  let states: ThreadOverlayState[] = world.states.flatMap((input) => {
    const key = buildThreadIdentityKey(input.source, input.id);
    if (seenStates.has(key)) return [];
    seenStates.add(key);
    return [{ backend: input.source, threadId: input.id, executionMode: "default" as const, extraLinkedDirectories: [],
      ...(input.expired !== undefined ? { archiveRetentionStartedAt: input.expired ? 10 * DAY : 90 * DAY } : {}),
      ...(input.pinned ? { pinnedRank: "a" } : {}),
      ...(input.agent ? { agent: { kind: "codex" } } : {}),
      ...(input.snapshots.length ? { worktreeSnapshots: input.snapshots.map((snapshot) => snapshotOf(snapshot, input.id)) } : {}),
    } as ThreadOverlayState];
  });
  const copy = (list: ThreadOverlayState[]) => list.map((state) => structuredClone(state));
  const log: unknown[] = [];
  let rows = 0;
  let deletions = 0;
  const interfere = () => {
    const change = world.interference[deletions++ % Math.max(1, world.interference.length)];
    if (!change || change.kind === "none" || (change.kind !== "newState" && !states.length)) return;
    if (change.kind === "newState") {
      if (!states.some((state) => state.threadId === change.id)) {
        states = [...states, { backend: "codex", threadId: change.id, executionMode: "default", extraLinkedDirectories: [],
          worktreeSnapshots: [snapshotOf(change.snapshot, change.id)] }];
      }
      return;
    }
    const at = change.at % states.length;
    const target = { ...states[at]! };
    if (change.kind === "restore") target.archiveRetentionStartedAt = 95 * DAY;
    if (change.kind === "pin") target.pinnedRank = "b";
    if (change.kind === "share") target.worktreeSnapshots = [...target.worktreeSnapshots ?? [], snapshotOf(change.snapshot, target.threadId)];
    states = states.map((state, index) => index === at ? target : state);
  };
  const deps: ThreadArchiveRetentionDeps = {
    getPolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 30 }),
    listThreads: async () => threads,
    listStates: async () => { rows += states.length; return copy(states); },
    ...(narrowed ? {
      listStatesFor: async (victims: ThreadOverlayState[], refs: string[]) => {
        const keys = new Set(victims.map((state) => buildThreadIdentityKey(state.backend, state.threadId)));
        // A superset is allowed: optionally return every state.
        const found = states.filter((state) => world.extras || keys.has(buildThreadIdentityKey(state.backend, state.threadId))
          || (state.worktreeSnapshots ?? []).some((snapshot) => refs.includes(snapshot.snapshotRef)));
        rows += found.length;
        return copy(found);
      },
    } : {}),
    observeArchives: async () => {},
    confirmAbsent: async (state) => {
      log.push(["confirmAbsent", state.backend, state.threadId]);
      return !world.present.includes(state.threadId);
    },
    deleteFamily: async (family) => {
      log.push(["deleteFamily", family.map(({ thread }) => buildThreadIdentityKey(thread.source, thread.id))]);
      if (world.failing.includes(family[0]!.thread.id)) throw new Error("provider unavailable");
      interfere();
      const gone = new Set(family.map(({ thread }) => buildThreadIdentityKey(thread.source, thread.id)));
      threads = threads.filter((thread) => !gone.has(buildThreadIdentityKey(thread.source, thread.id)));
    },
    deleteSnapshot: async (snapshot) => { log.push(["deleteSnapshot", snapshot.repositoryPath, snapshot.snapshotRef]); },
    forgetStates: async (victims) => {
      const gone = new Set(victims.map((state) => buildThreadIdentityKey(state.backend, state.threadId)));
      log.push(["forgetStates", [...gone]]);
      states = states.filter((state) => !gone.has(buildThreadIdentityKey(state.backend, state.threadId)));
    },
    isBusy: (candidate) => world.busy.includes(candidate.thread.id),
    onError: (_error, threadId) => { log.push(["onError", threadId]); },
  };
  const deleted = await sweep(deps);
  return { deleted, log, states, rows };
}

describe("archived thread retention, against the full-read sweep", () => {
  it("finds the same family for every root as scanning the list per member", () => {
    fc.assert(fc.property(fc.array(threadArb, { maxLength: 14 }), (inputs) => {
      const threads = inputs.map((input) => ({ id: input.id, title: input.id, titleSource: "explicit" as const,
        source: input.source, linkedDirectories: [],
        ...(input.parent ? { codexNativeSubAgent: { parentThreadId: input.parent } } : {}) }) as AppServerThreadSummary);
      const familyOf = archivedThreadFamilies(threads);
      for (const root of threads) {
        const expected = familyByScan(root, threads);
        const actual = familyOf(root);
        expect(actual).toHaveLength(expected.length);
        actual.forEach((thread, index) => expect(thread).toBe(expected[index]));
      }
    }), { numRuns: 2000 });
  });

  it("makes the same deletions, cleanup and errors, with and without a narrowed re-read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await fc.assert(fc.asyncProperty(worldArb, async (world) => {
      const expected = await run(world, sweepByFullReads, false);
      for (const narrowed of [false, true]) {
        const actual = await run(world, sweepThreadArchiveRetention, narrowed);
        expect(actual.deleted).toBe(expected.deleted);
        expect(actual.log).toEqual(expected.log);
        expect(actual.states).toEqual(expected.states);
      }
    }), {
      numRuns: 1500,
      examples: [[{
        // A restore during a family deletion reaches an orphan the sweep read
        // before the deletion: the orphan pass must see the restore.
        threads: [{ source: "codex", id: "a", parent: undefined, archived: true }],
        states: [
          { source: "codex", id: "gone2", expired: true, pinned: false, agent: false, snapshots: [] },
          { source: "codex", id: "a", expired: true, pinned: false, agent: false, snapshots: [] },
        ],
        busy: [], failing: [], present: [], interference: [{ kind: "restore", at: 0 }], extras: false,
      }]],
    });
  });
});
