import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { ComposerDraftSnapshot } from "../useComposerDraftStore";
import { useComposerDraftStore } from "../useComposerDraftStore";
import { useDurableComposerDraftStore } from "../useDurableComposerDraftStore";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDurableComposerDraftStore", () => {
  describe("write cadence", () => {
    const setup = () => {
      vi.useFakeTimers();
      const saveComposerDraft = vi.fn<
        NonNullable<DesktopApi["saveComposerDraft"]>
      >(async (request) => ({ draft: request.draft }));
      const desktopApi = {
        saveComposerDraft,
      } as Partial<DesktopApi> as DesktopApi;
      const rendered = renderHook(() =>
        useDurableComposerDraftStore(useComposerDraftStore(), desktopApi),
      );
      return { ...rendered, saveComposerDraft };
    };

    it("coalesces a burst of typing into a single write", () => {
      // The point of the change: this used to be one sqlite commit per 200ms,
      // roughly five a second while typing, for a recovery feature that does
      // not need per-keystroke granularity.
      const { result, saveComposerDraft } = setup();
      const sentence = "I like dogs and cats and bears.";

      act(() => {
        for (let index = 1; index <= sentence.length; index += 1) {
          result.current.set(
            "thread:codex:thread-1",
            buildSnapshot(sentence.slice(0, index)),
          );
        }
      });
      expect(saveComposerDraft).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(saveComposerDraft).toHaveBeenCalledOnce();
      expect(saveComposerDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({ text: sentence }),
        }),
      );
    });

    it("still writes while typing continuously, rather than waiting for a pause", () => {
      // A trailing debounce would fail this: someone typing without a gap
      // would never reach the quiet window and nothing would persist at all.
      const { result, saveComposerDraft } = setup();

      act(() => {
        result.current.set("thread:codex:thread-1", buildSnapshot("a"));
      });
      for (let tick = 0; tick < 3; tick += 1) {
        act(() => {
          vi.advanceTimersByTime(2_500);
          result.current.set(
            "thread:codex:thread-1",
            buildSnapshot(`a${"b".repeat(tick + 1)}`),
          );
        });
      }

      // ~7.5s of unbroken typing, so the interval has elapsed and written.
      expect(saveComposerDraft).toHaveBeenCalled();
    });

    it("does not write when nothing changed", () => {
      // The composer re-saves on unmount with no dirty check, so an unchanged
      // snapshot arrives here just from opening a thread and leaving.
      const { result, saveComposerDraft } = setup();

      act(() => {
        result.current.set("thread:codex:thread-1", buildSnapshot("Same text."));
        vi.advanceTimersByTime(5_000);
      });
      expect(saveComposerDraft).toHaveBeenCalledOnce();

      act(() => {
        result.current.set("thread:codex:thread-1", buildSnapshot("Same text."));
        vi.advanceTimersByTime(60_000);
      });

      expect(saveComposerDraft).toHaveBeenCalledOnce();
    });

    it("writes again once the draft actually changes", () => {
      const { result, saveComposerDraft } = setup();

      act(() => {
        result.current.set("thread:codex:thread-1", buildSnapshot("First."));
        vi.advanceTimersByTime(5_000);
      });
      act(() => {
        result.current.set("thread:codex:thread-1", buildSnapshot("Second."));
        vi.advanceTimersByTime(5_000);
      });

      expect(saveComposerDraft).toHaveBeenCalledTimes(2);
      expect(saveComposerDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({ text: "Second." }),
        }),
      );
    });
  });

  it("flushes pending debounced draft saves on teardown", () => {
    vi.useFakeTimers();
    const saveComposerDraft = vi.fn<NonNullable<DesktopApi["saveComposerDraft"]>>(
      async (request) => ({ draft: request.draft }),
    );
    const desktopApi = {
      saveComposerDraft,
    } as Partial<DesktopApi> as DesktopApi;
    const { result, unmount } = renderHook(() =>
      useDurableComposerDraftStore(useComposerDraftStore(), desktopApi),
    );

    act(() => {
      result.current.set(
        "thread:codex:thread-1",
        buildSnapshot("Keep this draft before teardown."),
      );
    });

    expect(saveComposerDraft).not.toHaveBeenCalled();
    unmount();

    expect(saveComposerDraft).toHaveBeenCalledOnce();
    expect(saveComposerDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          scopeKey: "thread:codex:thread-1",
          status: "unsent",
          text: "Keep this draft before teardown.",
        }),
      }),
    );
  });

  it("records short sent prompts in durable recovery history", () => {
    const recordComposerDraftHistory = vi.fn<
      NonNullable<DesktopApi["recordComposerDraftHistory"]>
    >(async (request) => ({ candidate: request.draft }));
    const desktopApi = {
      recordComposerDraftHistory,
    } as Partial<DesktopApi> as DesktopApi;
    const { result } = renderHook(() =>
      useDurableComposerDraftStore(useComposerDraftStore(), desktopApi),
    );

    act(() => {
      result.current.recordHistory?.(
        "thread:codex:thread-1",
        buildSnapshot("Short prompt"),
        "sent",
      );
    });

    expect(recordComposerDraftHistory).toHaveBeenCalledOnce();
    expect(recordComposerDraftHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          scopeKey: "thread:codex:thread-1",
          status: "sent",
          text: "Short prompt",
        }),
      }),
    );
  });

  it("parks short stacked drafts in durable recovery history", () => {
    const recordComposerDraftHistory = vi.fn<
      NonNullable<DesktopApi["recordComposerDraftHistory"]>
    >(async (request) => ({ candidate: request.draft }));
    const desktopApi = {
      recordComposerDraftHistory,
    } as Partial<DesktopApi> as DesktopApi;
    const { result } = renderHook(() =>
      useDurableComposerDraftStore(useComposerDraftStore(), desktopApi),
    );
    const parkedDraft = buildSnapshot("Existing project draft");

    act(() => {
      result.current.pushDraft("launchpad:directory:/repo", parkedDraft);
    });

    expect(result.current.popDraft("launchpad:directory:/repo")).toBe(
      parkedDraft,
    );
    expect(recordComposerDraftHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          scopeKey: "launchpad:directory:/repo",
          status: "abandoned",
          text: "Existing project draft",
        }),
      }),
    );
  });

  it("returns just-recorded sent prompts before durable history finishes", async () => {
    type RecordHistoryResponse = Awaited<
      ReturnType<NonNullable<DesktopApi["recordComposerDraftHistory"]>>
    >;
    let resolveRecordHistory:
      | ((response: RecordHistoryResponse) => void)
      | undefined;
    const recordComposerDraftHistory = vi.fn<
      NonNullable<DesktopApi["recordComposerDraftHistory"]>
    >(
      () =>
        new Promise((resolve) => {
          resolveRecordHistory = resolve;
        }),
    );
    const listComposerDraftRecoveryCandidates = vi.fn<
      NonNullable<DesktopApi["listComposerDraftRecoveryCandidates"]>
    >(async () => ({ candidates: [] }));
    const desktopApi = {
      listComposerDraftRecoveryCandidates,
      recordComposerDraftHistory,
    } as Partial<DesktopApi> as DesktopApi;
    const { result } = renderHook(() =>
      useDurableComposerDraftStore(useComposerDraftStore(), desktopApi),
    );

    act(() => {
      result.current.recordHistory?.(
        "thread:codex:thread-1",
        buildSnapshot("Short prompt"),
        "sent",
      );
    });

    const candidates = await result.current.listRecoveryCandidates?.({
      backend: "codex",
      includeSent: true,
      scopeKey: "thread:codex:thread-1",
      threadId: "thread-1",
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        scopeKey: "thread:codex:thread-1",
        status: "sent",
        text: "Short prompt",
      }),
    ]);

    const draft = recordComposerDraftHistory.mock.calls[0]?.[0].draft;
    expect(draft).toBeDefined();
    resolveRecordHistory?.({ candidate: draft! });
  });

  it("replaces the optimistic unsubmitted prefix candidate with the longer draft", async () => {
    const recordComposerDraftHistory = vi.fn<
      NonNullable<DesktopApi["recordComposerDraftHistory"]>
    >(async (request) => ({ candidate: request.draft }));
    const listComposerDraftRecoveryCandidates = vi.fn<
      NonNullable<DesktopApi["listComposerDraftRecoveryCandidates"]>
    >(async () => ({ candidates: [] }));
    const desktopApi = {
      listComposerDraftRecoveryCandidates,
      recordComposerDraftHistory,
    } as Partial<DesktopApi> as DesktopApi;
    const { result } = renderHook(() =>
      useDurableComposerDraftStore(useComposerDraftStore(), desktopApi),
    );

    act(() => {
      result.current.recordHistory?.(
        "thread:codex:thread-1",
        buildSnapshot(
          "the quick fox typed enough context to be treated as a complete recoverable draft before it grew past the minimum recovery threshold",
        ),
        "abandoned",
      );
      result.current.recordHistory?.(
        "thread:codex:thread-1",
        buildSnapshot(
          "the quick fox typed enough context to be treated as a complete recoverable draft before it grew past the minimum recovery threshold into a longer coherent prompt",
        ),
        "abandoned",
      );
    });

    const candidates = await result.current.listRecoveryCandidates?.({
      backend: "codex",
      scopeKey: "thread:codex:thread-1",
      threadId: "thread-1",
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        text: "the quick fox typed enough context to be treated as a complete recoverable draft before it grew past the minimum recovery threshold into a longer coherent prompt",
      }),
    ]);
  });
});

function buildSnapshot(draft: string): ComposerDraftSnapshot {
  return {
    draft,
    editorDocument: undefined,
    imageAttachments: [],
    skillTokens: [],
  };
}
