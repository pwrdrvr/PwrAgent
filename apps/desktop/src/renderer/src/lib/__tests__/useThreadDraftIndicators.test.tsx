import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  buildThreadComposerScopeKey,
  useComposerDraftStore,
  type ComposerDraftSnapshot,
  type ComposerDraftStore,
} from "../../features/composer/useComposerDraftStore";
import {
  selectThreadsWithDrafts,
  useThreadDraftIndicators,
} from "../useThreadDraftIndicators";

function makeThread(id: string): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    updatedAt: 0,
    inbox: { inInbox: false },
    linkedDirectories: [],
  };
}

function makeSnapshot(
  overrides: Partial<ComposerDraftSnapshot> = {},
): ComposerDraftSnapshot {
  return {
    draft: "",
    imageAttachments: [],
    fileAttachments: [],
    skillTokens: [],
    ...overrides,
  };
}

function scopeKey(thread: NavigationThreadSummary): string {
  return buildThreadComposerScopeKey(thread.source, thread.id);
}

function renderIndicators(threads: NavigationThreadSummary[]) {
  const renders = { count: 0 };
  const rendered = renderHook(
    ({ threads: currentThreads }) => {
      renders.count += 1;
      const store = useComposerDraftStore();
      const indicators = useThreadDraftIndicators({
        composerDraftStore: store,
        threads: currentThreads,
      });
      return { store, indicators };
    },
    { initialProps: { threads } },
  );
  return { ...rendered, renders };
}

function setDraft(
  store: ComposerDraftStore,
  thread: NavigationThreadSummary,
  snapshot: ComposerDraftSnapshot,
): void {
  act(() => {
    store.set(scopeKey(thread), snapshot);
  });
}

describe("useThreadDraftIndicators", () => {
  it("marks a thread once its composer holds text", () => {
    const thread = makeThread("thread-1");
    const { result } = renderIndicators([thread]);

    expect(result.current.indicators).toEqual({});

    setDraft(result.current.store, thread, makeSnapshot({ draft: "half a " }));

    expect(result.current.indicators).toEqual({ "codex:thread-1": true });
  });

  it("ignores whitespace-only text", () => {
    // The composer leaves a trailing newline behind constantly; a chip that
    // lit up for one would be permanent noise.
    const thread = makeThread("thread-1");
    const { result } = renderIndicators([thread]);

    setDraft(result.current.store, thread, makeSnapshot({ draft: "  \n " }));

    expect(result.current.indicators).toEqual({});
  });

  it("marks a thread carrying only attachments", () => {
    const thread = makeThread("thread-1");
    const { result } = renderIndicators([thread]);

    setDraft(
      result.current.store,
      thread,
      makeSnapshot({
        fileAttachments: [
          { id: "file-1", label: "notes.md", path: "/tmp/notes.md" },
        ],
      }),
    );

    expect(result.current.indicators).toEqual({ "codex:thread-1": true });
  });

  it("clears when the draft is deleted", () => {
    const thread = makeThread("thread-1");
    const { result } = renderIndicators([thread]);

    setDraft(result.current.store, thread, makeSnapshot({ draft: "text" }));
    expect(result.current.indicators).toEqual({ "codex:thread-1": true });

    act(() => {
      result.current.store.delete(scopeKey(thread));
    });

    expect(result.current.indicators).toEqual({});
  });

  it("keeps the mark while a draft is parked beneath a newer one", () => {
    // `pushDraft` parks the current draft under the scope rather than
    // destroying it. That parked text is still unsent work.
    const thread = makeThread("thread-1");
    const { result } = renderIndicators([thread]);

    act(() => {
      result.current.store.pushDraft(
        scopeKey(thread),
        makeSnapshot({ draft: "parked" }),
      );
    });

    expect(result.current.indicators).toEqual({ "codex:thread-1": true });

    act(() => {
      result.current.store.popDraft(scopeKey(thread));
    });

    expect(result.current.indicators).toEqual({});
  });

  it("does not re-render the subscriber on every keystroke", () => {
    // The store notifies on presence transitions only. Without that, every
    // character typed into the composer would re-render the whole thread
    // list.
    const thread = makeThread("thread-1");
    const { result, renders } = renderIndicators([thread]);

    setDraft(result.current.store, thread, makeSnapshot({ draft: "a" }));
    const rendersAfterFirstCharacter = renders.count;

    for (const draft of ["ab", "abc", "abcd"]) {
      setDraft(result.current.store, thread, makeSnapshot({ draft }));
    }

    expect(renders.count).toBe(rendersAfterFirstCharacter);
    expect(result.current.indicators).toEqual({ "codex:thread-1": true });
  });

  it("scopes the mark to the thread that was typed into", () => {
    const typed = makeThread("thread-1");
    const untouched = makeThread("thread-2");
    const { result } = renderIndicators([typed, untouched]);

    setDraft(result.current.store, typed, makeSnapshot({ draft: "text" }));

    expect(result.current.indicators).toEqual({ "codex:thread-1": true });
  });

  it("unsubscribes on unmount", () => {
    const thread = makeThread("thread-1");
    const unsubscribe = vi.fn();
    const store = {
      getDraftPresenceVersion: () => 0,
      hasDraftContent: () => false,
      subscribeDraftPresence: () => unsubscribe,
    } as unknown as ComposerDraftStore;

    const { unmount } = renderHook(() =>
      useThreadDraftIndicators({ composerDraftStore: store, threads: [thread] }),
    );
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("selectThreadsWithDrafts", () => {
  it("keeps the given order and drops undrafted threads", () => {
    const first = makeThread("thread-1");
    const second = makeThread("thread-2");
    const third = makeThread("thread-3");

    expect(
      selectThreadsWithDrafts([first, second, third], {
        "codex:thread-3": true,
        "codex:thread-1": true,
      }),
    ).toEqual([first, third]);
  });

  it("returns nothing when no map has been threaded down", () => {
    expect(selectThreadsWithDrafts([makeThread("thread-1")], undefined)).toEqual(
      [],
    );
  });
});
