import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES,
  normalizeCheckoutHibernationPolicy,
  type AppServerThreadSummary,
  type DesktopCheckoutHibernationPolicy,
  type ThreadOverlayState,
  type WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { hibernationKeepReason } from "../app-server/checkout-hibernation";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";

/**
 * Model test. `eligible` below restates the approved design (section 10 of
 * the Thread Maintenance UX review) as one predicate, written apart from the
 * implementation's ordered keep reasons. Every generated candidate must get
 * the same yes/no from both, and pinning must never change the answer.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6);
const ROOTS = {
  pwragent: "/Users/fixture/.pwragent/worktrees/abc/repo",
  pwragentProfile: "/Users/fixture/.pwragent/profiles/dev/worktrees/abc/repo",
  codex: "/Users/fixture/.codex/worktrees/abc/repo",
  inRepo: "/Users/fixture/repo/.worktrees/abc/repo",
} as const;

/** Each blocker is rare, so a run reaches the eligible corner often enough
 * to exercise every single rule on its own. */
const rarely = fc.oneof({ weight: 12, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) });
const usually = <T>(common: T, ...others: T[]) =>
  fc.oneof({ weight: 6, arbitrary: fc.constant(common) }, { weight: 1, arbitrary: fc.constantFrom(...others) });

const scenario = fc.record({
  enabled: usually(true, false),
  idleDays: fc.integer({ min: 1, max: 60 }),
  source: fc.constantFrom("codex", "codex", "claude", "acp:kimi"),
  root: usually<keyof typeof ROOTS | "none">("pwragent", "pwragentProfile", "codex", "inRepo", "none"),
  external: rarely,
  archived: usually("no", "provider", "tombstone", "retention"),
  pinned: fc.constantFrom("no", "provider", "rank"),
  agent: rarely,
  mergeHeld: rarely,
  pendingWork: rarely,
  prWatch: rarely,
  scheduled: rarely,
  remote: rarely,
  activeSubAgent: rarely,
  unreadable: rarely,
  threadStatus: usually<AppServerThreadSummary["threadStatus"] | undefined>("notLoaded", "idle", "active", undefined),
  idleFor: fc.integer({ min: 0, max: 90 * DAY }),
  seenLater: fc.integer({ min: 0, max: 10 * DAY }),
  snapshot: usually("none", "hibernated", "archivedPending", "archivedRestored", "restored"),
  keepAwake: rarely,
  busy: rarely,
  sharedPath: rarely,
});

type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function build(input: Scenario): { candidate: ThreadArchiveCandidate; policy: DesktopCheckoutHibernationPolicy } {
  const worktreePath = input.root === "none" ? undefined : ROOTS[input.root];
  const updatedAt = NOW - input.idleFor;
  const snapshot = (state: WorktreeSnapshotSummary["state"], restoredAt?: number): WorktreeSnapshotSummary => ({
    id: "s", backend: "codex", threadId: "t", worktreePath: worktreePath ?? "/elsewhere", repositoryPath: "/Users/fixture/repo",
    snapshotRef: "refs/pwragent/snapshots/s", snapshotCommit: "c", createdAt: 1, state, ignoredFilesExcluded: true,
    ...(restoredAt !== undefined ? { restoredAt } : {}),
  });
  const snapshots = {
    none: [],
    hibernated: [snapshot("hibernated")],
    archivedPending: [snapshot("archived")],
    // An old archive whose restore finished long ago does not count as activity now.
    archivedRestored: [snapshot("archived", 1)],
    restored: [snapshot("restored", 1)],
  }[input.snapshot];
  const thread: AppServerThreadSummary = {
    id: "t", source: input.source as AppServerThreadSummary["source"], title: "Fixture", titleSource: "explicit",
    linkedDirectories: worktreePath ? [{ id: "d", kind: "worktree", label: "repo", path: "/Users/fixture/repo", worktreePath,
      ...(input.external ? { worktreeOwnership: "external" as const } : {}) }] : [],
    // A Claude thread outside a PwrAgent worktree is already kept by archive's rules.
    projectKey: worktreePath,
    updatedAt,
    threadStatus: input.threadStatus,
    ...(input.pinned === "provider" ? { isPinned: true } : {}),
    ...(input.archived === "provider" ? { archivedAt: 1 } : {}),
    ...(input.remote ? { codexEnvironmentRuntime: { executionTarget: "remote" } as AppServerThreadSummary["codexEnvironmentRuntime"] } : {}),
  };
  const overlay: ThreadOverlayState = {
    lastSeenAt: updatedAt - input.seenLater,
    worktreeSnapshots: snapshots,
    ...(input.pinned === "rank" ? { pinnedRank: 1 } : {}),
    ...(input.keepAwake ? { keepCheckoutAwake: true } : {}),
    ...(input.archived === "tombstone" ? { archiveTombstonedAt: 1 } : {}),
    ...(input.archived === "retention" ? { archiveRetentionStartedAt: 1 } : {}),
    ...(input.agent ? { agent: {} as ThreadOverlayState["agent"] } : {}),
    ...(input.mergeHeld ? { mergeHolds: [{ status: "waiting" }] as ThreadOverlayState["mergeHolds"] } : {}),
    ...(input.pendingWork ? { prAutoDispatchPending: {} as ThreadOverlayState["prAutoDispatchPending"] } : {}),
    ...(input.scheduled ? { scheduledStart: { state: "scheduled" } as ThreadOverlayState["scheduledStart"] } : {}),
  } as ThreadOverlayState;
  return {
    candidate: { thread, overlay, activeSubAgent: input.activeSubAgent, activePrWatch: input.prWatch, unreadable: input.unreadable },
    policy: { enabled: input.enabled, idleDays: input.idleDays, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send" },
  };
}

/** The design, as one predicate. */
function eligible(input: Scenario): boolean {
  const pwragentRoot = input.root === "pwragent" || input.root === "pwragentProfile";
  // Codex never removes a checkout in ~/.codex/worktrees, so it hibernates
  // too. A Claude thread's checkout there is not one PwrAgent made for it.
  const toolRoot = pwragentRoot || (input.root === "codex" && input.source !== "claude");
  const idleDays = input.idleFor / DAY;
  return input.enabled
    && input.archived === "no"
    // Keep it awake exempts the thread until the operator turns it off.
    && !input.keepAwake
    && !input.unreadable
    // Agent, merge hold, pending work, PR watch, schedule, remote execution, active.
    && !input.agent && !input.mergeHeld && !input.pendingWork && !input.prWatch && !input.scheduled && !input.remote
    && !input.activeSubAgent
    && (input.threadStatus === "idle" || input.threadStatus === "notLoaded")
    // Only PwrAgent's and Codex's own, unborrowed worktrees.
    && toolRoot && !input.external
    && input.snapshot !== "hibernated" && input.snapshot !== "archivedPending"
    && !(input.source === "claude" && idleDays > 30)
    && idleDays >= input.idleDays
    && !input.busy && !input.sharedPath;
}

describe("checkout hibernation keep rules", () => {
  it("agree with the design for every candidate, pinned or not", () => {
    fc.assert(fc.property(scenario, (input) => {
      const { candidate, policy } = build(input);
      const reason = hibernationKeepReason(candidate, NOW, policy, { busy: input.busy, sharedPath: input.sharedPath });
      expect(reason === undefined).toBe(eligible(input));
      // Pinned threads may hibernate: a pin never changes the answer.
      const unpinned = build({ ...input, pinned: "no" });
      expect(hibernationKeepReason(unpinned.candidate, NOW, unpinned.policy, { busy: input.busy, sharedPath: input.sharedPath }))
        .toBe(reason);
    }), { numRuns: 5000 });
  });

  it("treats a checkout under Codex's worktree root like one under PwrAgent's", () => {
    const notClaude = scenario.filter((input) => input.source !== "claude");
    fc.assert(fc.property(notClaude, (input) => {
      const codex = build({ ...input, root: "codex" });
      const pwragent = build({ ...input, root: "pwragent" });
      const options = { busy: input.busy, sharedPath: input.sharedPath };
      expect(hibernationKeepReason(codex.candidate, NOW, codex.policy, options))
        .toBe(hibernationKeepReason(pwragent.candidate, NOW, pwragent.policy, options));
    }), { numRuns: 2000 });
  });

  it("keeps a Claude thread's checkout under Codex's worktree root", () => {
    fc.assert(fc.property(scenario, (input) => {
      const { candidate, policy } = build({ ...input, source: "claude", root: "codex" });
      expect(hibernationKeepReason(candidate, NOW, policy, { busy: input.busy, sharedPath: input.sharedPath })).toBeDefined();
    }));
  });
});

describe("checkout hibernation policy normalization", () => {
  const anything = fc.oneof(fc.double(), fc.integer({ min: -10, max: 10_000 }), fc.constant(undefined), fc.constant(Number.NaN));
  const value = fc.record({
    enabled: fc.option(fc.boolean(), { nil: undefined }),
    idleDays: anything,
    maxSnapshotMb: anything,
    removeRebuildableOutput: fc.option(fc.boolean(), { nil: undefined }),
    restoreOn: fc.constantFrom("send", "open", "later", undefined),
  });

  it("keeps every field in range, and is on unless set off", () => {
    fc.assert(fc.property(value, (raw) => {
      const policy = normalizeCheckoutHibernationPolicy(raw as Partial<DesktopCheckoutHibernationPolicy>);
      expect(Number.isInteger(policy.idleDays)).toBe(true);
      expect(policy.idleDays).toBeGreaterThanOrEqual(1);
      expect(policy.idleDays).toBeLessThanOrEqual(3650);
      expect(CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES).toContain(policy.maxSnapshotMb);
      expect(["send", "open"]).toContain(policy.restoreOn);
      // Hibernation is the automatic way to reclaim disk: on by default,
      // upgrades included, and only an explicit `false` turns it off.
      expect(policy.enabled).toBe(raw.enabled !== false);
      // Normalizing again changes nothing.
      expect(normalizeCheckoutHibernationPolicy(policy)).toEqual(policy);
    }), { numRuns: 1000 });
  });

  it("defaults to on, 7 days, 100 MB, rebuildable output removed, restore on send", () => {
    expect(normalizeCheckoutHibernationPolicy()).toEqual({
      enabled: true, idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, restoreOn: "send",
    });
  });
});
