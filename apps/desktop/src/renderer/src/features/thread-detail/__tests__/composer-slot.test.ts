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
  LAUNCHPAD_COMPOSER_SLOT_KEY,
  nextComposerSlotLineage,
  THREAD_COMPOSER_SLOT_KEY,
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

describe("composer slot", () => {
  it("keeps the launchpad's slot for the thread it became", () => {
    const store = createStore();
    const created = thread("created");
    handoffLaunchpadComposer(store, launchpadScope, created);

    expect(walk(store, [
      { launchpadScope },
      { threadScope: threadComposerScope(created) },
      { threadScope: threadComposerScope(created) },
    ])).toEqual([
      LAUNCHPAD_COMPOSER_SLOT_KEY,
      LAUNCHPAD_COMPOSER_SLOT_KEY,
      LAUNCHPAD_COMPOSER_SLOT_KEY,
    ]);
  });

  it("gives any other thread the thread slot", () => {
    const store = createStore();
    const created = thread("created");
    handoffLaunchpadComposer(store, launchpadScope, created);

    expect(walk(store, [
      { launchpadScope },
      // Navigated somewhere else before the created thread showed.
      { threadScope: threadComposerScope(thread("other")) },
      { threadScope: threadComposerScope(created) },
    ])).toEqual([
      LAUNCHPAD_COMPOSER_SLOT_KEY,
      THREAD_COMPOSER_SLOT_KEY,
      THREAD_COMPOSER_SLOT_KEY,
    ]);
  });

  it("does not adopt a launchpad that was never handed off", () => {
    const store = createStore();
    expect(walk(store, [
      { launchpadScope },
      { threadScope: threadComposerScope(thread("created")) },
    ])).toEqual([LAUNCHPAD_COMPOSER_SLOT_KEY, THREAD_COMPOSER_SLOT_KEY]);
  });

  it("returns to the thread slot once the created thread is left", () => {
    const store = createStore();
    const created = thread("created");
    handoffLaunchpadComposer(store, launchpadScope, created);

    expect(walk(store, [
      { launchpadScope },
      { threadScope: threadComposerScope(created) },
      { threadScope: threadComposerScope(thread("other")) },
      { threadScope: threadComposerScope(created) },
    ])).toEqual([
      LAUNCHPAD_COMPOSER_SLOT_KEY,
      LAUNCHPAD_COMPOSER_SLOT_KEY,
      THREAD_COMPOSER_SLOT_KEY,
      THREAD_COMPOSER_SLOT_KEY,
    ]);
  });
});
