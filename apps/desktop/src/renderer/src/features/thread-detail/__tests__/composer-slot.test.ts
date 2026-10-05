import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { handoffLaunchpadComposer } from "../../composer/launchpad-composer-handoff";
import {
  useComposerDraftStore,
  type ComposerDraftStore,
} from "../../composer/useComposerDraftStore";
import {
  composerSlotKey,
  nextComposerSlotLineage,
  threadComposerScope,
  type ComposerSlotLineage,
} from "../composer-slot";

const launchpadScope = "launchpad:starting:1:directory:/repo";

function createStore(): ComposerDraftStore {
  return renderHook(useComposerDraftStore).result.current;
}

function thread(id: string): NavigationThreadSummary {
  return {
    id, source: "codex", title: id, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false },
  };
}

/** Walk the views a ThreadView shows, returning each one's slot key. */
function walk(
  store: ComposerDraftStore,
  views: { launchpadScope?: string; threadScope?: string }[],
): string[] {
  let lineage: ComposerSlotLineage = {};
  return views.map((view) => {
    lineage = nextComposerSlotLineage(lineage, view, store);
    // Settles in one update: the next render must not see a change again.
    expect(nextComposerSlotLineage(lineage, view, store)).toBe(lineage);
    return composerSlotKey(lineage, view);
  });
}

/** Same key as the view before it: React keeps that view's composer. */
function sharesComposerWithPrevious(keys: string[]): boolean[] {
  return keys.slice(1).map((key, index) => key === keys[index]);
}

describe("composer slot", () => {
  it("keeps the launchpad's composer for the thread it became", () => {
    const store = createStore();
    const created = thread("created");
    handoffLaunchpadComposer(store, launchpadScope, created);

    expect(sharesComposerWithPrevious(walk(store, [
      { launchpadScope },
      { threadScope: threadComposerScope(created) },
      { threadScope: threadComposerScope(created) },
    ]))).toEqual([true, true]);
  });

  it("gives any other thread a fresh composer", () => {
    const store = createStore();
    const created = thread("created");
    handoffLaunchpadComposer(store, launchpadScope, created);

    expect(sharesComposerWithPrevious(walk(store, [
      { launchpadScope },
      // Navigated somewhere else before the created thread showed.
      { threadScope: threadComposerScope(thread("other")) },
      // Thread to thread keeps the composer, as it always did.
      { threadScope: threadComposerScope(created) },
    ]))).toEqual([false, true]);
  });

  it("does not adopt a launchpad that was never handed off", () => {
    const store = createStore();
    expect(sharesComposerWithPrevious(walk(store, [
      { launchpadScope },
      { threadScope: threadComposerScope(thread("created")) },
    ]))).toEqual([false]);
  });

  it("keeps the created thread's composer across later threads", () => {
    const store = createStore();
    const created = thread("created");
    handoffLaunchpadComposer(store, launchpadScope, created);

    expect(sharesComposerWithPrevious(walk(store, [
      { launchpadScope },
      { threadScope: threadComposerScope(created) },
      { threadScope: threadComposerScope(thread("other")) },
      { threadScope: threadComposerScope(created) },
    ]))).toEqual([true, true, true]);
  });

  it("gives the next launchpad a fresh composer after one was adopted", () => {
    const store = createStore();
    const created = thread("created");
    handoffLaunchpadComposer(store, launchpadScope, created);
    const nextLaunchpad = "launchpad:directory:/repo";

    expect(sharesComposerWithPrevious(walk(store, [
      { launchpadScope },
      { threadScope: threadComposerScope(created) },
      { launchpadScope: nextLaunchpad },
      // Launchpad to launchpad keeps the composer, as it always did.
      { launchpadScope },
      { threadScope: threadComposerScope(thread("other")) },
    ]))).toEqual([true, false, true, false]);
  });
});
