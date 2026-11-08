import { expect, it } from "vitest";
import fc from "fast-check";
import { buildThreadIdentityKey, resolveThreadParentKey, type AppServerBackendKind, type NavigationThreadSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { canNestThread } from "../../renderer/src/features/navigation/thread-nest-drop";
import { createSubthreadTrays } from "../../renderer/src/features/navigation/subthread-trays";
import { threadSummaryIdentityKey } from "../../renderer/src/lib/federated-thread-events";

type Ref = { backend: AppServerBackendKind; threadId: string };
type Model = { parents: number[] };
type Real = { refs: Ref[]; store: SqliteOverlayStore };
const key = (ref: Ref) => buildThreadIdentityKey(ref.backend, ref.threadId);

async function snapshot(real: Real) {
  return Promise.all(real.refs.map((ref) => real.store.getThreadOverlayState(ref)));
}

async function summaries(real: Real): Promise<NavigationThreadSummary[]> {
  const states = await snapshot(real);
  return real.refs.map((ref, index) => ({
    id: ref.threadId, source: ref.backend, title: key(ref), titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    subthreadsCollapsed: index % 2 === 0, ...states[index],
  }));
}

function assertVisible(rows: NavigationThreadSummary[]) {
  const byKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), row]));
  const children = new Map<string, NavigationThreadSummary[]>();
  for (const row of rows) {
    const parent = resolveThreadParentKey(row, byKey);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), row]);
    const ancestors = new Set<string>([threadSummaryIdentityKey(row)]);
    let cursor = parent;
    while (cursor) {
      expect(ancestors.has(cursor)).toBe(false);
      ancestors.add(cursor);
      cursor = resolveThreadParentKey(byKey.get(cursor)!, byKey);
    }
  }
  // A lens can promote a child to a root. Every presentation must remain a
  // partition of the forest, even with collapsed intermediate descendants.
  for (let lens = 0; lens < 5; lens++) {
    const roots = rows.filter((row, index) => !resolveThreadParentKey(row, byKey) || index % 5 === lens);
    if (lens % 2) roots.reverse();
    const rootKeys = new Set(roots.map(threadSummaryIdentityKey));
    const trays = createSubthreadTrays(children, roots);
    const rendered = roots.flatMap((root) => [root, ...trays.subtree(threadSummaryIdentityKey(root))]);
    expect(rendered.map(threadSummaryIdentityKey).sort()).toEqual([...byKey.keys()].sort());
    for (const root of roots) {
      const rootKey = threadSummaryIdentityKey(root);
      for (const child of trays.subtree(rootKey)) {
        let parent = resolveThreadParentKey(child, byKey)!;
        let depth = 1;
        while (!rootKeys.has(parent)) {
          parent = resolveThreadParentKey(byKey.get(parent)!, byKey)!;
          depth += 1;
        }
        expect(parent).toBe(rootKey);
        expect(trays.depth(threadSummaryIdentityKey(child))).toBe(depth);
      }
    }
  }
}

async function assertModel(model: Model, real: Real) {
  const rows = await summaries(real);
  const byKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), row]));
  expect(rows.map((row) => resolveThreadParentKey(row, byKey)))
    .toEqual(model.parents.map((parent) => parent < 0 ? undefined : key(real.refs[parent]!)));
  assertVisible(rows);
}

class ParentCommand implements fc.AsyncCommand<Model, Real> {
  constructor(readonly childIndex: number, readonly parentIndex: number | undefined) {}
  check() { return true; }
  async run(model: Model, real: Real) {
    const child = this.childIndex % real.refs.length;
    const parent = this.parentIndex === undefined ? -1 : this.parentIndex % real.refs.length;
    const rows = await summaries(real);
    const byKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), row]));
    const before = structuredClone(await snapshot(real));
    let loop = false;
    for (let cursor = parent; cursor >= 0; cursor = model.parents[cursor]!) {
      if (cursor === child) { loop = true; break; }
    }
    if (parent >= 0) {
      expect(canNestThread(rows[child]!, rows[parent]!, byKey)).toBe(!loop && model.parents[child] !== parent);
    }
    const accepted = await real.store.setThreadParent({ ...real.refs[child]!,
      parentThreadId: parent < 0 ? null : real.refs[parent]!.threadId,
      parentThreadBackend: parent < 0 ? null : real.refs[parent]!.backend,
    }).then(() => true, () => false);
    expect(accepted).toBe(!loop);
    if (loop) expect(await snapshot(real)).toEqual(before);
    else {
      model.parents[child] = parent;
      if (parent >= 0) expect((await snapshot(real))[child]?.pinnedRank).toBeUndefined();
    }
    await assertModel(model, real);
  }
  toString() { return `parent(${this.childIndex}, ${this.parentIndex ?? "detach"})`; }
}

const command = fc.tuple(fc.nat(20), fc.option(fc.nat(20), { nil: undefined }))
  .map(([child, parent]) => new ParentCommand(child, parent));

async function runModel(count: number, commands: Iterable<fc.AsyncCommand<Model, Real>>) {
  const db = openInMemoryStateDb();
  const real: Real = { store: new SqliteOverlayStore(db), refs: Array.from({ length: count }, (_, index) => ({
    backend: index % 2 ? "acp:gemini" : "codex", threadId: `thread-${Math.floor(index / 2)}`,
  })) };
  try {
    for (const ref of real.refs) await real.store.setThreadPin({ ...ref, pinned: true });
    const model = { parents: Array.from({ length: count }, () => -1) };
    await fc.asyncModelRun(() => ({ model, real }), commands);
    await assertModel(model, real);
  } finally { db.close(); }
}

it("keeps the owner graph a forest and offers exactly the nontrivial links the owner accepts", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.commands([command], { maxCommands: 20 }), runModel), { numRuns: 25 });
});

async function withChain(depth: number, run: (db: ReturnType<typeof openInMemoryStateDb>, refs: Ref[]) => Promise<void>) {
  const db = openInMemoryStateDb();
  const real: Real = { store: new SqliteOverlayStore(db), refs: Array.from({ length: depth + 2 }, (_, index) => ({
    backend: "codex", threadId: `thread-${index}`,
  })) };
  try {
    // Build upward from the leaf: every accepted link is still between two
    // roots, avoiding quadratic setup walks while producing the same chain.
    for (let index = depth; index >= 1; index--) await real.store.setThreadParent({
      ...real.refs[index]!, parentThreadId: real.refs[index - 1]!.threadId,
    });
    await run(db, real.refs);
  } finally { db.close(); }
}

async function rejectDeepCycle(real: Real, depth: number) {
  const before = structuredClone(await snapshot(real));
  const rows = await summaries(real);
  const byKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), row]));
  const offered = canNestThread(rows[0]!, rows[depth]!, byKey);
  const accepted = await real.store.setThreadParent({ ...real.refs[0]!, parentThreadId: real.refs[depth]!.threadId })
    .then(() => true, () => false);
  expect({ offered, accepted }).toEqual({ offered: false, accepted: false });
  expect(await snapshot(real)).toEqual(before);
  // An unrelated root may still nest below this deep chain. Refusing all
  // deep links would hide the cycle instead of validating its ancestry.
  expect(canNestThread(rows.at(-1)!, rows[depth]!, byKey)).toBe(true);
  await expect(real.store.setThreadParent({ ...real.refs.at(-1)!, parentThreadId: real.refs[depth]!.threadId }))
    .resolves.toMatchObject({ parentThreadId: real.refs[depth]!.threadId });
}

it("refuses a cycle through descendants at any generated depth without changing the owner", async () => {
  await withChain(80, async (db, refs) => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 80 }), async (depth) => {
      // Reuse only the setup. Each attempt gets a fresh store/cache and rolls
      // back its real writes, including a failing attempt during shrinking.
      db.raw.exec("SAVEPOINT deep_cycle_case");
      try { await rejectDeepCycle({ store: new SqliteOverlayStore(db), refs }, depth); }
      finally {
        db.raw.exec("ROLLBACK TO deep_cycle_case");
        db.raw.exec("RELEASE deep_cycle_case");
      }
    }), { numRuns: 25 });
  });
});

it("never offers or persists a cycle through 64 descendants (shrunk deep-cycle regression)", async () => {
  await withChain(64, (db, refs) => rejectDeepCycle({ store: new SqliteOverlayStore(db), refs }, 64));
});

it("refuses a two-provider parent cycle without losing pins or rows (shrunk #3094 regression)", async () => {
  await runModel(2, [new ParentCommand(0, 3), new ParentCommand(3, 0)]);
});
