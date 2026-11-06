import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ArchiveWorktreeReferences } from "../app-server/archive-worktree-references";
import type { ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
import { LegacyArchiveWorktreeReferences } from "./fixtures/legacy-archive-worktree-references";

/**
 * Differential test. The indexed references must answer every question exactly
 * as the implementation they replaced, which rebuilt its indexes after every
 * write. Shared checkouts, symlink aliases, a dangling alias, stale and
 * concurrent observations, scheduling and fulfilment are all generated.
 */

const fsModel = vi.hoisted(() => ({ removed: new Set<string>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(async (value: string) => {
      if (!value.startsWith("/model")) return await actual.realpath(value);
      const resolved = value.startsWith("/model/alias") ? "/model/c0" + value.slice("/model/alias".length) : value;
      if (fsModel.removed.has(resolved) || value.includes("missing")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return resolved;
    }),
  };
});

const OWNERS = ["codex:a", "codex:b", "claude:c", "codex:d"];
const CHECKOUTS = ["/model/c0", "/model/alias", "/model/c1", "/model/c2", "/model/missing"];
const BLOCKERS = ["codex:x", "codex:y", "claude:z"];
const OBSERVED = ["/model/c0", "/model/c0/child", "/model/c1", "/model/elsewhere", "/model/alias/child"];

const intent = (key: string): ArchiveCleanupIntent => {
  const [backend, threadId] = key.split(":") as ["codex", string];
  return { backend, threadId, archivedAt: 1, codexRolloutMissing: false, messagingCleanup: {} };
};

type Pair = { next: ArchiveWorktreeReferences; legacy: LegacyArchiveWorktreeReferences; generations: Map<string, [number, number]> };

const step = fc.oneof(
  fc.record({ kind: fc.constant("retain" as const), owner: fc.constantFrom(...OWNERS), checkout: fc.constantFrom(...CHECKOUTS),
    blockers: fc.subarray(BLOCKERS), snapshot: fc.boolean() }),
  fc.record({ kind: fc.constant("fulfil" as const), checkout: fc.constantFrom(...CHECKOUTS), remove: fc.boolean() }),
  fc.record({ kind: fc.constant("forget" as const), owner: fc.constantFrom(...OWNERS) }),
  fc.record({ kind: fc.constant("begin" as const), blocker: fc.constantFrom(...BLOCKERS) }),
  fc.record({ kind: fc.constant("observe" as const), blocker: fc.constantFrom(...BLOCKERS), paths: fc.subarray(OBSERVED, { maxLength: 2 }), stale: fc.boolean() }),
  fc.record({ kind: fc.constant("schedule" as const), index: fc.nat(3) }),
);

async function both<T>(pair: Pair, work: (refs: ArchiveWorktreeReferences | LegacyArchiveWorktreeReferences) => Promise<T> | T) {
  const settle = async (refs: ArchiveWorktreeReferences | LegacyArchiveWorktreeReferences) => {
    try { return { value: await work(refs) }; } catch (error) { return { error: String(error) }; }
  };
  return [await settle(pair.next), await settle(pair.legacy)] as const;
}

describe("archive worktree references", () => {
  it("answers exactly as the rebuild-every-write implementation", async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
      fsModel.removed.clear();
      const pair: Pair = { next: new ArchiveWorktreeReferences(), legacy: new LegacyArchiveWorktreeReferences(), generations: new Map() };
      for (const op of steps) {
        let result: readonly [unknown, unknown];
        if (op.kind === "retain") {
          result = await both(pair, async (refs) => await refs.retain(intent(op.owner), {
            worktreePath: op.checkout, blockers: op.blockers,
            ...(op.snapshot ? { snapshot: { id: op.checkout, backend: intent(op.owner).backend, threadId: intent(op.owner).threadId,
              worktreePath: op.checkout, repositoryPath: "/model/repo", snapshotRef: "refs/x", snapshotCommit: "c", state: "archived" } as never } : {}),
          }));
        } else if (op.kind === "fulfil") {
          // A removal can leave an alias dangling before fulfilment is recorded.
          if (op.remove) fsModel.removed.add(op.checkout === "/model/alias" ? "/model/c0" : op.checkout);
          result = await both(pair, async (refs) => await refs.fulfilled(op.checkout));
        } else if (op.kind === "forget") {
          result = await both(pair, (refs) => refs.forgetOwner(op.owner));
        } else if (op.kind === "begin") {
          pair.generations.set(op.blocker, [pair.next.beginObservation(op.blocker), pair.legacy.beginObservation(op.blocker)]);
          result = [pair.generations.get(op.blocker)![0], pair.generations.get(op.blocker)![1]];
        } else if (op.kind === "observe") {
          let generations = pair.generations.get(op.blocker);
          if (!generations || !op.stale) {
            generations = [pair.next.beginObservation(op.blocker), pair.legacy.beginObservation(op.blocker)];
            pair.generations.set(op.blocker, generations);
          }
          const [next, legacy] = generations;
          result = [
            await pair.next.observe(op.blocker, next, op.paths).catch((error: unknown) => String(error)),
            await pair.legacy.observe(op.blocker, legacy, op.paths).catch((error: unknown) => String(error)),
          ];
        } else {
          const ready = pair.legacy.readyIntents();
          const chosen = ready[op.index % Math.max(1, ready.length)];
          result = chosen ? await both(pair, (refs) => refs.scheduled(chosen)) : [undefined, undefined];
        }
        expect(result[0]).toEqual(result[1]);
        expect(pair.next.intents()).toEqual(pair.legacy.intents());
        expect(pair.next.readyIntents()).toEqual(pair.legacy.readyIntents());
        expect(pair.next.recoveryIntents()).toEqual(pair.legacy.recoveryIntents());
        for (const owner of OWNERS) {
          expect(pair.next.readyIntents(owner)).toEqual(pair.legacy.readyIntents(owner));
          const probe = { ...intent(owner), deferredWorktrees: CHECKOUTS.map((worktreePath) => ({ worktreePath, blockers: [] })) };
          expect(pair.next.pending(probe)).toEqual(pair.legacy.pending(probe));
        }
        for (const blocker of BLOCKERS) expect(pair.next.hasReference(blocker)).toBe(pair.legacy.hasReference(blocker));
      }
    }), { numRuns: 200 });
  });
});
