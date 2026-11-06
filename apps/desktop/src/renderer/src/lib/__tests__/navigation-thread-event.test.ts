import { expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { applyCheckoutHibernationUpdate, applyNavigationThreadEvent } from "../navigation-thread-event";

it("applies status updates only to the destination repository when PR numbers overlap", () => {
  const fork: PrSummary = {
    provider: "github.com",
    org: "fork",
    repo: "diskhound",
    number: 38,
    title: "Fork progress",
    state: "pending",
    url: "https://github.com/fork/diskhound/pull/38",
  };
  const legacyUpstream = {
    ...fork,
    title: "Upstream warnings",
    url: "https://github.com/upstream/diskhound/pull/38",
  };
  const thread: NavigationThreadSummary = {
    id: "thread",
    source: "codex",
    title: "Overlapping PRs",
    titleSource: "explicit",
    linkedDirectories: [],
    inbox: { inInbox: true },
    prs: [fork, legacyUpstream],
  };
  const updated: PrSummary = { ...legacyUpstream, org: "upstream", state: "passing" };
  const result = applyNavigationThreadEvent(thread, {
    backend: "codex",
    notification: {
      method: "pullRequest/status/updated",
      params: {
        prKey: "github.com/upstream/diskhound#38",
        pr: updated,
      },
    },
  });
  expect(result.prs).toEqual([fork, updated]);
  expect(result.prs?.[0]).toBe(fork);
});

it("applies and clears a thread lock from its owner event", () => {
  const thread: NavigationThreadSummary = {
    id: "thread",
    source: "codex",
    title: "Parked",
    titleSource: "explicit",
    linkedDirectories: [],
    inbox: { inInbox: false },
  };
  const lock = { note: "Handed off", lockedAt: 1, source: "operator" as const };
  const locked = applyNavigationThreadEvent(thread, {
    backend: "codex",
    notification: { method: "thread/lock/updated", params: { threadId: "thread", lock } },
  });
  expect(locked.lock).toEqual(lock);
  const unlocked = applyNavigationThreadEvent(locked, {
    backend: "codex",
    notification: { method: "thread/lock/updated", params: { threadId: "thread" } },
  });
  expect(unlocked.lock).toBeUndefined();
});

it("patches a hibernated checkout, its row mark, and Keep it awake from one event", () => {
  const thread: NavigationThreadSummary = {
    id: "thread", source: "codex", title: "Hibernation", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true },
  };
  const workspace = { worktreePath: "/wt", repositoryPath: "/repo", hibernatedAt: 1, restoring: true, restorePhase: "checkout" as const };
  const event = (params: Record<string, unknown>) => ({
    backend: "codex" as const,
    notification: { method: "thread/checkoutHibernation/updated", params: { threadId: "thread", ...params } },
  }) as never;

  const restoring = applyNavigationThreadEvent(thread, event({ workspace }));
  expect(restoring).toMatchObject({ workspaceHibernated: workspace, checkoutHibernated: true });
  // Keep it awake alone leaves the card as it is.
  const awake = applyNavigationThreadEvent(restoring, event({ keepAwake: true }));
  expect(awake).toMatchObject({ workspaceHibernated: workspace, checkoutHibernated: true, keepCheckoutAwake: true });
  // The restore ended: no card, no mark.
  const back = applyNavigationThreadEvent(awake, event({ workspace: null }));
  expect(back).not.toHaveProperty("workspaceHibernated");
  expect(back).not.toHaveProperty("checkoutHibernated");
  expect(back.keepCheckoutAwake).toBe(true);
  expect(applyCheckoutHibernationUpdate(back, { threadId: "thread", keepAwake: false })).not.toHaveProperty("keepCheckoutAwake");
  // Another thread's event changes nothing.
  expect(applyNavigationThreadEvent(thread, {
    backend: "codex", notification: { method: "thread/checkoutHibernation/updated", params: { threadId: "other", workspace } },
  } as never)).toBe(thread);
});
