import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary, DesktopCheckoutHibernationPolicy } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CheckoutPathOwners } from "../app-server/checkout-path-owners";
import { ThreadArchiveSweeper, type ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/**
 * Operation budgets for one hourly hibernation pass, through the registry's
 * real keep rules and the sweep's real loop. A CPU capture of the sweep
 * (development 1.3.16, 2026-11-10) spent 3.6 s in the shared-checkout check
 * and 2.1 s of it in `path.normalizeString`: every candidate rescanned every
 * other candidate's directories, resolving both paths each time.
 *
 * The rules: normalization grows linearly with the candidate count, a
 * candidate kept on thread state never reaches the registry's busy or
 * sharing checks, and a pass of kept candidates lets the event loop run.
 */

const DAY = 86_400_000;
const POLICY: DesktopCheckoutHibernationPolicy = { enabled: true, idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function registry(): DesktopBackendRegistry {
  const stateDb = openInMemoryStateDb();
  const instance = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {},
      getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [],
      onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: new SqliteOverlayStore(stateDb),
  });
  cleanups.push(() => stateDb.close());
  cleanups.push(async () => await instance.close());
  return instance;
}

/** Idle threads, each in its own PwrAgent worktree, plus the repository
 * every thread links: the realistic shape of a large profile. */
function candidates(count: number, idleDays: number): ThreadArchiveCandidate[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    thread: {
      id: `t${index}`, title: `Thread ${index}`, titleSource: "explicit", source: "codex", threadStatus: "notLoaded",
      updatedAt: now - idleDays * DAY,
      projectKey: `/Users/fixture/.pwragent/worktrees/k${index}/repo`,
      linkedDirectories: [{ id: `d${index}`, label: "repo", kind: "worktree", path: "/Users/fixture/repo",
        worktreePath: `/Users/fixture/.pwragent/worktrees/k${index}/repo` }],
    } as AppServerThreadSummary,
    overlay: { backend: "codex", threadId: `t${index}`, extraLinkedDirectories: [
      { id: `x${index}`, label: "notes", kind: "local", path: `/Users/fixture/notes/${index}` },
    ] } as ThreadArchiveCandidate["overlay"],
  }));
}

/** One sweep pass. Every argument the sweep gives `keepReason` is passed on,
 * so the registry sees whatever per-pass state the sweep provides. */
async function sweepPass(owner: DesktopBackendRegistry, list: ThreadArchiveCandidate[], onKeepReason?: () => void) {
  const kept: Record<string, number> = {};
  const sweeper = new ThreadArchiveSweeper({
    listCandidates: async () => list,
    onError: (error) => { throw error; },
    hibernation: {
      getPolicy: () => POLICY,
      keepReason: (...args: Parameters<DesktopBackendRegistry["checkoutHibernationKeepReason"]>) => {
        onKeepReason?.();
        return owner.checkoutHibernationKeepReason(...args);
      },
      // Git is not the subject: every checkout that passes the rules stays.
      inspectWorkspace: async () => "Uncommitted changes",
      hibernate: async () => { throw new Error("nothing is hibernated in a budget test"); },
    },
  } as ConstructorParameters<typeof ThreadArchiveSweeper>[0]);
  cleanups.push(async () => await sweeper.stop());
  await sweeper.sweep();
  const status = sweeper.getStatus().hibernation!;
  for (const [reason, count] of Object.entries(status.kept)) kept[reason] = count;
  return { checked: status.checked, kept, failed: sweeper.getStatus().failed };
}

function countResolve(): { calls: () => number } {
  let calls = 0;
  const resolve = path.resolve;
  vi.spyOn(path, "resolve").mockImplementation((...segments: string[]) => { calls += 1; return resolve(...segments); });
  return { calls: () => calls };
}

describe("hibernation pass budgets", () => {
  it("normalizes paths linearly in the candidate count, keeping the same checkouts", async () => {
    const measure = async (count: number) => {
      const owner = registry();
      const list = candidates(count, 30);
      const counter = countResolve();
      const result = await sweepPass(owner, list);
      const calls = counter.calls();
      vi.restoreAllMocks();
      return { calls, result };
    };
    const small = await measure(60);
    const large = await measure(120);
    // Every checkout reaches the Git probe: none is shared, none is busy.
    expect(small.result).toEqual({ checked: 60, kept: { "Uncommitted changes": 60 }, failed: 0 });
    expect(large.result).toEqual({ checked: 120, kept: { "Uncommitted changes": 120 }, failed: 0 });
    // Doubling the candidates at most doubles the work, plus a constant.
    // The full scan per candidate made it about four times.
    expect(large.calls).toBeLessThanOrEqual(2 * small.calls + 16);
    // About one normalization per listed directory, and one per question.
    expect(large.calls).toBeLessThanOrEqual(8 * 120);
  });

  it("asks nothing of the registry for candidates the thread rules keep", async () => {
    const owner = registry();
    const busy = vi.spyOn(owner as unknown as { autoArchiveCandidateIsBusy: (candidate: ThreadArchiveCandidate) => boolean },
      "autoArchiveCandidateIsBusy");
    const internals = CheckoutPathOwners.prototype as unknown as { index: () => unknown };
    const indexed = vi.spyOn(internals, "index");
    const asked = vi.spyOn(CheckoutPathOwners.prototype, "sharedWithAnotherThread");
    const result = await sweepPass(owner, candidates(200, 1));
    expect(result).toEqual({ checked: 200, kept: { "Recently active": 200 }, failed: 0 });
    expect(busy).not.toHaveBeenCalled();
    // No owner index is built when no candidate needs the sharing answer.
    expect(asked).not.toHaveBeenCalled();
    expect(indexed).not.toHaveBeenCalled();
  });

  it("still keeps a checkout another live thread lists, and frees it once that thread is archived", async () => {
    const owner = registry();
    const list = candidates(3, 30);
    // A sub-thread works in t0's checkout through an extra directory.
    list[1]!.overlay!.extraLinkedDirectories = [{ id: "shared", label: "repo", kind: "worktree",
      path: "/Users/fixture/repo", worktreePath: "/Users/fixture/.pwragent/worktrees/k0/repo/" }];
    expect((await sweepPass(owner, list)).kept).toEqual({ "Shared with another thread": 1, "Uncommitted changes": 2 });
    list[1]!.overlay!.archiveTombstonedAt = 1;
    expect((await sweepPass(owner, list)).kept).toEqual({ "Uncommitted changes": 3 });
  });

  it("lets the event loop run during a pass that keeps every candidate", async () => {
    const owner = registry();
    let ticks = 0;
    let running = true;
    const tick = () => { ticks += 1; if (running) setImmediate(tick); };
    setImmediate(tick);
    const seen: number[] = [];
    try {
      const result = await sweepPass(owner, candidates(1000, 1), () => seen.push(ticks));
      expect(result.kept).toEqual({ "Recently active": 1000 });
    } finally {
      running = false;
    }
    // Without a yield every call sees the same macrotask; here timers, I/O
    // and IPC get a turn at least every 64 candidates.
    expect(new Set(seen).size).toBeGreaterThanOrEqual(Math.floor(1000 / 64));
  });
});
