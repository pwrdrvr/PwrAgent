import { expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { applyNavigationThreadEvent } from "../navigation-thread-event";

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
