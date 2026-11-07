import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  archiveCandidateKeepReason,
  archiveCandidateProtectionReason,
  CLAUDE_CHECKOUT_KEEP_REASON,
  keepSubthreadParents,
  MAX_SUBTHREADS_LEFT_BY_ARCHIVE,
  peerSubthreadKey,
  subthreadChildren,
  subthreadsFirst,
  isProtectedArchiveCandidate,
  ThreadArchiveSweeper,
  THREAD_ARCHIVE_SWEEP_INTERVAL_MS,
  THREAD_ARCHIVE_SWEEP_START_DELAY_MS,
  type ThreadArchiveCandidate,
} from "../app-server/thread-archive-sweeper";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;
afterEach(() => {
  vi.useRealTimers();
});

function candidate(id = "old"): ThreadArchiveCandidate {
  return {
    thread: {
      id, title: id, titleSource: "explicit", source: "codex", threadStatus: "notLoaded",
      updatedAt: Date.now() - SEVEN_DAYS_MS - 1,
      linkedDirectories: [],
    },
  };
}

const HIBERNATE_ON = { enabled: true, idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" as const };

function harness(candidates = [candidate()]) {
  const hibernate = vi.fn<NonNullable<ConstructorParameters<typeof ThreadArchiveSweeper>[0]["hibernation"]>["hibernate"]>(async () => true);
  const deps = {
    listCandidates: vi.fn(async () => candidates),
    cleanupRetention: vi.fn(async () => 0),
    hibernation: {
      getPolicy: () => HIBERNATE_ON,
      keepReason: (item: ThreadArchiveCandidate) => ({ target: `/worktrees/${item.thread.id}` }),
      inspectWorkspace: async () => undefined,
      hibernate,
    },
    onError: vi.fn(),
  };
  return { deps, hibernate, sweeper: new ThreadArchiveSweeper(deps) };
}

describe("ThreadArchiveSweeper", () => {
  it("reports worktree cleanup independently of the other phases and joins concurrent sweeps", async () => {
    const { deps } = harness([]);
    let release!: () => void;
    const cleanupWorktrees = vi.fn<NonNullable<ConstructorParameters<typeof ThreadArchiveSweeper>[0]["cleanupWorktrees"]>>(async ({ manual, onProgress, onFailure }) => {
      expect(manual).toBe(true);
      onProgress({ candidates: 501, protected: 3, processed: 0, removed: 0 });
      await new Promise<void>((resolve) => { release = resolve; });
      onProgress({ candidates: 501, protected: 3, processed: 501, removed: 500 });
      onFailure(new Error("Snapshot size limit exceeded"));
    });
    const sweeper = new ThreadArchiveSweeper({ ...deps, cleanupWorktrees, hibernation: undefined });
    const run = sweeper.sweep({ manual: true });
    expect(sweeper.getStatus()).toMatchObject({ running: true, worktrees: { candidates: 501, processed: 0 } });
    expect(sweeper.sweep({ manual: true })).toBe(run);
    release();
    await run;
    expect(cleanupWorktrees).toHaveBeenCalledOnce();
    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(sweeper.getStatus()).toMatchObject({ running: false, deleted: 0, failed: 1,
      worktrees: { candidates: 501, protected: 3, processed: 501, removed: 500 }, error: "Snapshot size limit exceeded" });
    await sweeper.stop();
  });

  it("starts after a delay, runs hourly, and stops scheduling on shutdown", async () => {
    vi.useFakeTimers();
    const { deps, sweeper } = harness([]);
    sweeper.start();
    sweeper.start();
    expect(deps.cleanupRetention).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_START_DELAY_MS);
    expect(deps.cleanupRetention).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_INTERVAL_MS - 1);
    expect(deps.cleanupRetention).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.cleanupRetention).toHaveBeenCalledTimes(2);
    await sweeper.stop();
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_INTERVAL_MS);
    expect(deps.cleanupRetention).toHaveBeenCalledTimes(2);
  });

  it("restarts the hourly interval after a manual sweep and reports when the next one runs", async () => {
    vi.useFakeTimers();
    const { deps, sweeper } = harness([]);
    sweeper.start();
    expect(sweeper.getStatus()).toEqual({
      running: false, deleted: 0, failed: 0, nextAt: Date.now() + THREAD_ARCHIVE_SWEEP_START_DELAY_MS,
    });
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_START_DELAY_MS / 2);
    await sweeper.sweep();
    expect(deps.cleanupRetention).toHaveBeenCalledTimes(1);
    const { finishedAt, nextAt } = sweeper.getStatus();
    expect(nextAt).toBe(finishedAt! + THREAD_ARCHIVE_SWEEP_INTERVAL_MS);
    // The startup timer was replaced, not left to run beside the new interval.
    await vi.advanceTimersByTimeAsync(THREAD_ARCHIVE_SWEEP_INTERVAL_MS - 1);
    expect(deps.cleanupRetention).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.cleanupRetention).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });

  it("publishes a running status, then deletion, hibernation and failure counts", async () => {
    const { deps, hibernate } = harness([candidate("failed"), candidate("hibernated"), candidate("kept")]);
    const statuses: unknown[] = [];
    const sweeper = new ThreadArchiveSweeper({
      ...deps,
      cleanupRetention: async (onFailure) => {
        onFailure(new Error("snapshot ref is locked"));
        return 2;
      },
      onStatus: (status) => { statuses.push(status); },
    });
    hibernate.mockImplementation(async (item: ThreadArchiveCandidate) => {
      if (item.thread.id === "failed") throw new Error("snapshot mismatch");
      return item.thread.id === "kept" ? "Rebase in progress" : true;
    });
    await sweeper.sweep();
    expect(statuses).toEqual([
      { running: true, startedAt: expect.any(Number), deleted: 0, failed: 0 },
      {
        running: false, startedAt: expect.any(Number), finishedAt: expect.any(Number),
        deleted: 2, failed: 2, error: "snapshot ref is locked",
        failures: [
          { phase: "retention", message: "snapshot ref is locked" },
          { phase: "hibernation", message: "snapshot mismatch", threadId: "failed" },
        ],
        hibernation: { checked: 3, hibernated: 1, kept: { "Rebase in progress": 1 } },
      },
    ]);
    // Retention logs its own failures; only the hibernation failure is logged here.
    expect(deps.onError).toHaveBeenCalledTimes(1);
    await sweeper.stop();
  });

  it("reports a failed thread listing and still reports worktree and retention results", async () => {
    const { deps } = harness();
    deps.listCandidates.mockRejectedValueOnce(new Error("Codex is restarting"));
    const sweeper = new ThreadArchiveSweeper({ ...deps,
      cleanupWorktrees: async ({ onProgress }) => { onProgress({ candidates: 2, protected: 0, processed: 2, removed: 2 }); },
      cleanupRetention: async () => 1,
    });
    await sweeper.sweep();
    expect(sweeper.getStatus()).toMatchObject({
      deleted: 1, failed: 1, worktrees: { removed: 2 },
      hibernation: { checked: 0, hibernated: 0, skipped: "Threads could not be listed" },
      failures: [{ phase: "hibernation", message: "Codex is restarting" }],
    });
    await sweeper.sweep();
    expect(sweeper.getStatus()).toMatchObject({ failed: 0, hibernation: { hibernated: 1 } });
    expect(sweeper.getStatus().error).toBeUndefined();
    await sweeper.stop();
  });

  it("says the hibernation pass was skipped when hibernation is off", async () => {
    const { deps, hibernate } = harness();
    const sweeper = new ThreadArchiveSweeper({ ...deps,
      hibernation: { ...deps.hibernation, getPolicy: () => ({ ...HIBERNATE_ON, enabled: false }) } });
    await sweeper.sweep();
    expect(sweeper.getStatus().hibernation).toMatchObject({ checked: 0, skipped: "Hibernation is off" });
    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(hibernate).not.toHaveBeenCalled();
    await sweeper.stop();
  });

  it("reports every failure with its path or thread, up to the cap", async () => {
    const { deps, hibernate } = harness([candidate("failed"), candidate("next")]);
    hibernate.mockImplementation(async (item: ThreadArchiveCandidate) => {
      if (item.thread.id === "failed") throw new Error("snapshot mismatch");
      return true;
    });
    const sweeper = new ThreadArchiveSweeper({ ...deps,
      cleanupWorktrees: async ({ onFailure }) => {
        onFailure(new Error("ENOENT: realpath '/gone'"), { path: "/worktrees/one" });
        onFailure(new Error("EACCES"), { path: "/worktrees/two" });
      },
    });
    await sweeper.sweep();
    expect(sweeper.getStatus()).toMatchObject({ failed: 3, error: "ENOENT: realpath '/gone'", hibernation: { hibernated: 1 } });
    expect(sweeper.getStatus().failures).toEqual([
      { phase: "worktrees", message: "ENOENT: realpath '/gone'", path: "/worktrees/one" },
      { phase: "worktrees", message: "EACCES", path: "/worktrees/two" },
      { phase: "hibernation", message: "snapshot mismatch", threadId: "failed" },
    ]);
    const capped = new ThreadArchiveSweeper({ ...harness([]).deps,
      cleanupWorktrees: async ({ onFailure }) => {
        for (let index = 0; index < 25; index++) onFailure(new Error(`failure ${index}`), { path: `/w/${index}` });
      },
    });
    await capped.sweep();
    expect(capped.getStatus().failed).toBe(25);
    expect(capped.getStatus().failures).toHaveLength(20);
    await sweeper.stop();
    await capped.stop();
  });

  it("keeps protection rules for Codex chat folders and PR watches", () => {
    const linked = candidate("codex-chat");
    linked.thread.linkedDirectories = [
      { id: "chat", kind: "local", label: "chat", path: "/Users/tester/Documents/Codex/2026-05-08/chat" },
    ];
    const extra = candidate("codex-chat-extra");
    extra.overlay = { backend: "codex", threadId: "codex-chat-extra", extraLinkedDirectories: [
      { id: "chat", kind: "local", label: "chat", path: "C:\\Users\\tester\\Documents\\Codex\\2026-05-08\\chat" },
    ] };
    const lookalike = candidate("lookalike");
    lookalike.thread.linkedDirectories = [
      { id: "repo", kind: "local", label: "repo", path: "/Users/tester/Documents/Codex-tools/repo" },
    ];
    expect(archiveCandidateProtectionReason(linked)).toBe("Codex chat folder");
    expect(isProtectedArchiveCandidate(extra)).toBe(true);
    expect(isProtectedArchiveCandidate(lookalike)).toBe(false);
    const watched = { ...candidate("watched"), activePrWatch: true };
    expect(archiveCandidateProtectionReason(watched)).toBe("Watching a PR");
    expect(archiveCandidateKeepReason(watched, Date.now())).toBeDefined();
  });

  it("uses the 30-day boundary and protects recent views and restores", () => {
    const item = candidate();
    item.thread.updatedAt = Date.now() - SEVEN_DAYS_MS;
    expect(archiveCandidateKeepReason(item, Date.now())).toBeUndefined();
    item.overlay = { backend: "codex", threadId: "old", extraLinkedDirectories: [], lastSeenAt: Date.now() };
    expect(archiveCandidateKeepReason(item, Date.now())).toBeDefined();
    item.overlay.lastSeenAt = undefined;
    item.overlay.archiveRestoredAt = Date.now();
    expect(archiveCandidateKeepReason(item, Date.now())).toBeDefined();
    item.overlay.archiveRestoredAt = undefined;
    item.overlay.agent = { name: "Agent", updatedAt: 1, instructionLineCount: 0, instructionsTooLong: false };
    expect(archiveCandidateKeepReason(item, Date.now())).toBeDefined();
  });

  it("coalesces overlapping sweeps and drains an in-flight hibernation before stopping", async () => {
    const { hibernate, sweeper } = harness();
    let finish!: () => void;
    const pendingHibernation = new Promise<void>((resolve) => { finish = resolve; });
    hibernate.mockImplementation(async () => { await pendingHibernation; return true; });
    const pending = sweeper.sweep();
    expect(sweeper.sweep()).toBe(pending);
    await vi.waitFor(() => expect(hibernate).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = sweeper.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stop;
    await sweeper.sweep();
    expect(hibernate).toHaveBeenCalledTimes(1);
  });
});

describe("sub-thread parents", () => {
  it("keeps a selected parent only while it would leave more than 2 sub-threads, repeating as parents drop out", () => {
    // grand -> mid (selected) -> 3 unselected children; grand also has 2 more.
    const children = new Map([
      ["codex:grand", ["codex:mid", "codex:g1", "codex:g2"]],
      ["codex:mid", ["codex:m1", "codex:m2", "codex:m3"]],
    ]);
    const selected = new Set(["codex:grand", "codex:mid", "codex:g1", "codex:g2"]);
    // mid leaves 3 behind, so it stays; then grand would leave mid behind
    // only, which is within the limit.
    expect(keepSubthreadParents(selected, children)).toEqual(["codex:mid"]);
    expect([...selected].sort()).toEqual(["codex:g1", "codex:g2", "codex:grand"]);
  });

  it("keeps every selected parent whose local and peer sub-threads left would exceed 2", () => {
    fc.assert(fc.property(
      fc.array(fc.nat({ max: 9 }), { minLength: 1, maxLength: 10 }),
      fc.array(fc.nat({ max: 4 }), { minLength: 10, maxLength: 10 }),
      fc.uniqueArray(fc.nat({ max: 9 }), { maxLength: 10 }),
      (parents, peerCounts, chosen) => {
        // Node i's parent is an earlier node, so the links form a forest.
        const nodes = parents.map((parent, index): ThreadArchiveCandidate => ({
          ...candidate(`n${index}`),
          ...(index > 0 && parent < index
            ? { overlay: { parentThreadId: `n${parent}` } as ThreadArchiveCandidate["overlay"] }
            : {}),
        }));
        // Sub-threads on peers, which no archive here can archive.
        const peer = new Map(nodes.map(({ thread }, index) => [`codex:${thread.id}`,
          Array.from({ length: peerCounts[index]! }, (_, child) => peerSubthreadKey("pwr_peer", "codex", `${thread.id}-p${child}`))]));
        const selected = new Set(chosen.filter((index) => index < nodes.length).map((index) => `codex:n${index}`));
        keepSubthreadParents(selected, subthreadChildren(nodes, peer));
        // Oracle, from the forest itself: what each selected thread leaves.
        for (const key of selected) {
          const id = key.slice("codex:".length);
          const local = nodes.filter((node) => node.overlay?.parentThreadId === id && !selected.has(`codex:${node.thread.id}`)).length;
          expect(local + (peer.get(key)?.length ?? 0)).toBeLessThanOrEqual(MAX_SUBTHREADS_LEFT_BY_ARCHIVE);
        }
      },
    ));
  });

  it("never leaves a selected parent with more than 2 unselected sub-threads", () => {
    const ids = fc.constantFrom(...Array.from({ length: 8 }, (_, index) => `codex:t${index}`));
    fc.assert(fc.property(
      fc.array(fc.tuple(ids, ids), { maxLength: 24 }),
      fc.uniqueArray(ids, { maxLength: 8 }),
      (edges, chosen) => {
        const children = new Map<string, string[]>();
        for (const [parent, child] of edges) {
          if (parent !== child) children.set(parent, [...new Set([...children.get(parent) ?? [], child])]);
        }
        const selected = new Set(chosen);
        const kept = keepSubthreadParents(selected, children);
        for (const key of selected) {
          expect((children.get(key) ?? []).filter((child) => !selected.has(child)).length).toBeLessThanOrEqual(2);
        }
        for (const key of kept) expect(selected.has(key)).toBe(false);
      },
    ));
  });

  it("cleans up a Claude thread only in a worktree PwrAgent created", () => {
    const claude = (projectKey: string, directory: Record<string, unknown> = {}): ThreadArchiveCandidate => ({
      thread: { ...candidate("c").thread, source: "claude", projectKey,
        linkedDirectories: [{ id: "d", label: "repo", path: "/src/repo", kind: "local", ...directory }] },
    });
    const managed = "/Users/me/.pwragent/worktrees/k3m9/repo";
    expect(archiveCandidateProtectionReason(claude(managed, { worktreePath: managed }))).toBeUndefined();
    expect(archiveCandidateProtectionReason(claude("/Users/me/.pwragent/profiles/work/worktrees/k3m9/repo"))).toBeUndefined();
    for (const independent of [
      "/src/repo",
      "/src/repo/.claude/worktrees/fix-login",
      "/Users/me/.claude/worktrees/fix-login",
      "/Users/me/.codex/worktrees/a1b2/repo",
      "/Users/me/.codex/worktrees/.pwragent/worktrees/repo",
    ]) {
      expect(archiveCandidateProtectionReason(claude(independent))).toBe(CLAUDE_CHECKOUT_KEEP_REASON);
    }
    expect(archiveCandidateProtectionReason(claude(managed, { worktreePath: "/src/repo/.claude/worktrees/x" })))
      .toBe(CLAUDE_CHECKOUT_KEEP_REASON);
    expect(archiveCandidateProtectionReason(claude(managed, { worktreeOwnership: "external" })))
      .toBe(CLAUDE_CHECKOUT_KEEP_REASON);
    // Other providers keep their own rules.
    expect(archiveCandidateProtectionReason({ thread: { ...candidate("x").thread, projectKey: "/src/repo" } })).toBeUndefined();
  });

  it("never offers a Claude thread outside PwrAgent's worktree root", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom(".pwragent", ".pwragnt", ".codex", ".claude", "src", "worktrees", "profiles", "work", "k3m9", "repo"),
        { minLength: 1, maxLength: 7 }),
      (segments) => {
        const projectKey = `/Users/me/${segments.join("/")}`;
        const reason = archiveCandidateProtectionReason({
          thread: { ...candidate("c").thread, source: "claude", projectKey, linkedDirectories: [] },
        });
        // The leftmost tool worktree root in the path must be PwrAgent's.
        const root = /\/\.(codex|pwrag(?:ent|nt))(?:\/profiles\/[^/]+)?\/worktrees\/[^/]+\/[^/]+/.exec(projectKey);
        if (reason === undefined) expect(root?.[1]).toMatch(/^pwrag/);
      },
    ));
  });

  it("orders every thread after all of its sub-threads, however deep", () => {
    fc.assert(fc.property(
      fc.array(fc.nat({ max: 12 }), { minLength: 1, maxLength: 13 }),
      fc.array(fc.nat({ max: 12 }), { maxLength: 13 }),
      (parents, order) => {
        // Node i's parent is an earlier node, so the links form a forest.
        const nodes = parents.map((parent, index) => ({
          thread: { ...candidate(`n${index}`).thread },
          ...(index > 0 && parent % (index + 1) !== index
            ? { overlay: { parentThreadId: `n${parent % index}` } as ThreadArchiveCandidate["overlay"] }
            : {}),
        }));
        const shuffled = [...nodes];
        for (const [index, swap] of order.entries()) {
          const a = index % shuffled.length;
          const b = swap % shuffled.length;
          [shuffled[a], shuffled[b]] = [shuffled[b]!, shuffled[a]!];
        }
        const position = new Map(subthreadsFirst(shuffled).map(({ thread }, index) => [thread.id, index]));
        for (const node of nodes) {
          const parent = node.overlay?.parentThreadId;
          if (parent) expect(position.get(node.thread.id)!).toBeLessThan(position.get(parent)!);
        }
      },
    ));
  });

  it("counts only local, non-archived sub-threads and orders them before parents", () => {
    const row = (id: string, overlay?: Record<string, unknown>) => ({
      thread: { ...candidate(id).thread },
      ...(overlay ? { overlay: overlay as ThreadArchiveCandidate["overlay"] } : {}),
    });
    const candidates = [
      row("parent"),
      row("local", { parentThreadId: "parent" }),
      row("peer", { parentThreadId: "parent", parentThreadInstanceId: "pwr_peer" }),
      row("archived", { parentThreadId: "parent", archiveRetentionStartedAt: 1 }),
    ];
    expect(subthreadChildren(candidates)).toEqual(new Map([["codex:parent", ["codex:local"]]]));
    expect(subthreadsFirst(candidates).map(({ thread }) => thread.id)).toEqual(["local", "peer", "archived", "parent"]);
  });
});
