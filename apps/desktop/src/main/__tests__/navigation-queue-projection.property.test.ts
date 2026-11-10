import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import fc from "fast-check";
import type { ComposerThreadOwner, ScheduledThreadAction } from "@pwragent/shared";
import { ThreadTurnQueue, type ThreadTurnQueueEntry } from "@pwragent/owner-core/thread-turn-queue";
import {
  buildThreadComposerScopeKey, getNextReleasableQueuedTurn, useComposerDraftStore,
  type ComposerDraftStore, type ComposerQueuedTurnSnapshot,
} from "../../renderer/src/features/composer/useComposerDraftStore";
import { readCompleteNavigationQueue, reconcileCompleteNavigationQueue } from "../../renderer/src/lib/navigation-queue-projection";
import { applyScheduledActionProjection, syncScheduledActionProjections } from "../../renderer/src/lib/useScheduledThreadActionProjection";

const thread = { backend: "codex" as const, threadId: "queue-oracle" };
const owner: ComposerThreadOwner = { ...thread, target: { scope: "local" } };
const scope = buildThreadComposerScopeKey(thread.backend, thread.threadId);
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));

function createStore(): ComposerDraftStore {
  let store!: ComposerDraftStore;
  // This hook owns Maps and refs; a server render initializes the real store
  // without a DOM, mocked hooks, or a replacement implementation of the store.
  function Store() { store = useComposerDraftStore(); return null; }
  renderToStaticMarkup(createElement(Store));
  store.retainScopeOwner!(scope, owner);
  return store;
}

function input(id: string, createdAt = 1): ThreadTurnQueueEntry {
  return { ...thread, id, createdAt, origin: "manual", input: [{ type: "text", text: id }] };
}

function action(entry: ThreadTurnQueueEntry): ScheduledThreadAction {
  return { ...thread, id: `action:${entry.id}`, queueEntryId: entry.id, kind: "turn", origin: "desktop",
    status: entry.manualReleaseRequired ? "held" : "queued", scheduledFor: entry.createdAt,
    createdAt: entry.createdAt, updatedAt: 100, displayText: entry.id, turn: { input: entry.input },
    manualReleaseRequired: entry.manualReleaseRequired, errorMessage: entry.holdReason };
}

const operations = fc.array(fc.record({
  kind: fc.constantFrom("submit", "held", "cancel", "move", "pause", "edit", "release", "refresh"),
  index: fc.nat({ max: 20 }), anchor: fc.option(fc.nat({ max: 20 }), { nil: undefined }),
  scheduled: fc.boolean(), paused: fc.boolean(), createdAt: fc.integer({ min: 0, max: 3 }),
}), { maxLength: 30 });
type Operation = { kind: string; index: number; anchor?: number; scheduled: boolean; paused: boolean; createdAt: number };

async function compareQueue(steps: Operation[], pageSize: number) {
  const store = createStore();
  const scheduled = new Set<string>();
  let serial = 0;
  const queue = new ThreadTurnQueue({ now: () => 100, isThreadActive: () => true,
    startTurn: async () => { throw new Error("The occupied thread must not start another turn"); } });
  try {
    for (const step of steps) {
      const before = queue.getQueuedEntries(thread);
      const selected = before[step.index % before.length];
      if (step.kind === "submit" || step.kind === "held") {
        const entry = input(`entry-${serial++}`, step.createdAt);
        if (step.kind === "held") await queue.submitHeld(entry, "locked");
        else await queue.submit(entry);
        if (step.scheduled) {
          scheduled.add(entry.id);
          applyScheduledActionProjection(store, action(queue.getQueuedEntries(thread).find((row) => row.id === entry.id)!));
        }
      } else if (step.kind === "cancel" && selected) {
        queue.cancelEntry(selected.id);
        scheduled.delete(selected.id);
      } else if (step.kind === "move" && selected) {
        await queue.moveEntry(selected.id, step.anchor === undefined ? undefined : before[step.anchor % before.length]!.id);
      } else if (step.kind === "pause" && selected) {
        await queue.setEntryPaused(selected.id, step.paused);
      } else if (step.kind === "edit" && selected) {
        queue.updateQueuedEntryInput(selected.id, [{ type: "text", text: `edited:${selected.id}` }]);
      } else if (step.kind === "release") {
        await queue.releaseHold(thread, () => true);
      }
      const authoritative = queue.getQueuedEntries(thread);
      // Only the transport envelope is built here. Membership and order come
      // directly from the real FIFO, including tied/nonmonotonic timestamps.
      const projection = await readCompleteNavigationQueue({ owner, isCancelled: () => false, read: async (request) => {
        const offset = Number(request.cursor ?? 0);
        const end = Math.min(offset + pageSize, authoritative.length);
        return { protocol: 2, ref: thread, readiness: "ready", revision: String(serial), complete: end === authoritative.length,
          ...(end < authoritative.length ? { nextCursor: String(end) } : {}),
          entries: authoritative.slice(offset, end).map((entry, index) => ({
            queueEntryId: entry.id, origin: entry.origin, createdAt: entry.createdAt, displayText: entry.id,
            position: offset + index, manualReleaseRequired: entry.manualReleaseRequired, holdReason: entry.holdReason,
            paused: entry.paused, pauseRevision: entry.pauseRevision,
          })),
        };
      } });
      const current = store.getQueuedTurns(scope);
      store.setQueuedTurns(scope, reconcileCompleteNavigationQueue({ owner, projection, atReadStart: current, current }));
      syncScheduledActionProjections(store, authoritative.filter((entry) => scheduled.has(entry.id)).map(action), new Set([scope]));
      expect(store.getQueuedTurns(scope).map((entry) => entry.queueEntryId)).toEqual(authoritative.map((entry) => entry.id));
    }
  } finally { queue.close(); }
}

it("projects every acknowledged FIFO operation in the owner's order across paged and scheduled refreshes", async () => {
  // In-flight optimistic moves intentionally lead the owner; compare after
  // its acknowledgement, once the complete FIFO is authoritative again.
  await fc.assert(fc.asyncProperty(operations, fc.integer({ min: 1, max: 7 }), compareQueue), { numRuns: 50 });
});

type Waiting = { kind: "ordinary" | "held" | "failed"; paused: boolean };
const waiting = fc.array(fc.oneof(
  fc.record({ kind: fc.constant("ordinary" as const), paused: fc.boolean() }),
  fc.record({ kind: fc.constantFrom("held" as const, "failed" as const), paused: fc.constant(false) }),
), { maxLength: 20 });

async function compareRelease(rows: Waiting[]) {
  let active: string | undefined;
  const started: string[] = [];
  const queue = new ThreadTurnQueue({ now: () => 1, isThreadActive: () => active !== undefined,
    startTurn: async (entry) => { active = entry.id; started.push(entry.id); return { ...thread, turnId: entry.id }; } });
  let projected: ComposerQueuedTurnSnapshot[] = rows.map((row, index) => ({
    id: `entry-${index}`, text: `entry-${index}`, imageAttachments: [], fileAttachments: [],
    paused: row.paused, ...(row.kind === "held" ? { manualReleaseRequired: true } : {}),
    ...(row.kind === "failed" ? { failedScheduledActionId: `failed-${index}` } : {}),
  }));
  queue.restoreQueued(rows.map((row, index) => ({ ...input(`entry-${index}`), paused: row.paused,
    ...(row.kind !== "ordinary" ? { manualReleaseRequired: true, holdReason: "operator review required" } : {}),
  })));
  try {
    queue.drainAll();
    for (let step = 0; step <= rows.length; step++) {
      const expected = getNextReleasableQueuedTurn(projected, 1)?.id;
      await checkpoint();
      expect(active).toBe(expected);
      if (!active) break;
      const finished = active;
      projected = projected.filter((entry) => entry.id !== finished);
      active = undefined;
      await queue.releaseThread({ ...thread, turnId: finished, status: "turn/completed" });
    }
    expect(started).toHaveLength(rows.length - projected.length);
  } finally { queue.close(); }
}

it("releases the same successive heads as the owner's FIFO, including paused entries and failure barriers", async () => {
  // The local releaser's held/failed rows must obey the owner's barrier
  // semantics even before those composer-local turns have backend IDs.
  await fc.assert(fc.asyncProperty(waiting, compareRelease), { numRuns: 50 });
});

it("keeps the admitted scheduled turn ahead of a later manual turn (shrunk #2333 regression)", async () => {
  const submit = { kind: "submit", index: 0, anchor: undefined, paused: false, createdAt: 0 };
  await compareQueue([{ ...submit, scheduled: true }, { ...submit, scheduled: false }], 1);
});

it("holds an ordinary turn behind a failed row (shrunk #3338 regression)", async () => {
  await compareRelease([{ kind: "failed", paused: false }, { kind: "ordinary", paused: false }]);
});
