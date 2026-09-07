import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
  it("distinguishes pending, successful-empty and failed hydration without writing", async () => {
    let resolve!: (value: { drafts: [] }) => void;
    const saveComposerDraft = vi.fn();
    const firstApi = {
      listComposerDraftLatest: vi.fn(() => new Promise<{ drafts: [] }>((done) => { resolve = done; })),
      saveComposerDraft,
    } as unknown as DesktopApi;
    const rendered = renderHook(({ api }) =>
      useDurableComposerDraftStore(useComposerDraftStore(), api),
    { initialProps: { api: firstApi } });
    expect(rendered.result.current.hydrationStatus).toBe("loading");
    await act(async () => { resolve({ drafts: [] }); });
    expect(rendered.result.current.hydrationStatus).toBe("ready");
    expect(rendered.result.current.hydrationVersion).toBe(0);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failedApi = { listComposerDraftLatest: vi.fn(async () => { throw new Error("unavailable"); }) } as unknown as DesktopApi;
      rendered.rerender({ api: failedApi });
      expect(rendered.result.current.hydrationStatus).toBe("loading");
      await waitFor(() => expect(rendered.result.current.hydrationStatus).toBe("failed"));
      expect(saveComposerDraft).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("enumerates draft and queued scopes independently of navigation rows", () => {
    const { result } = renderHook(() => useComposerDraftStore());
    act(() => {
      result.current.set("thread:codex:off-page", buildSnapshot("Private unsent input"));
      result.current.pushDraft("thread:codex:parked", buildSnapshot("Parked input"));
      result.current.setQueuedTurns("thread:codex:queued-off-page", [{
        id: "local-queue", text: "Private queued input", imageAttachments: [], fileAttachments: [],
      }]);
    });
    const drafts = result.current.getDraftScopeKeys();
    expect(drafts).toEqual(["thread:codex:off-page", "thread:codex:parked"]);
    expect(result.current.getQueuedScopeKeys()).toEqual(["thread:codex:queued-off-page"]);
    // The scope string is not evidence of owner identity. These reads neither
    // parse it nor expose content, and callers cannot mutate store membership.
    expect(JSON.stringify(drafts)).not.toContain("Private");
    (drafts as string[]).length = 0;
    expect(result.current.getDraftScopeKeys()).toHaveLength(2);
    const presenceVersion = result.current.getDraftPresenceVersion();
    act(() => result.current.set("thread:codex:off-page", buildSnapshot("Another edit")));
    expect(result.current.getDraftPresenceVersion()).toBe(presenceVersion);
    act(() => {
      result.current.delete("thread:codex:off-page");
      result.current.popDraft("thread:codex:parked");
      result.current.deleteQueuedTurn("thread:codex:queued-off-page");
    });
    expect(result.current.getDraftScopeKeys()).toEqual([]);
    expect(result.current.getQueuedScopeKeys()).toEqual([]);
  });

  it("does not rewrite a hydrated draft when a thread is merely opened and left", async () => {
    // The PR's headline claim, and the one that depends on a fragile
    // round-trip: hydration seeds the persisted-hash map from the STORED
    // `contentHash`, so suppressing this write requires
    // `snapshotFromDraftRecord` -> `hashDraftContent` to reproduce exactly the
    // hash the record was written with. Add a field to the snapshot and update
    // only one side and this silently either stops suppressing (harmless) or
    // suppresses a real edit (not).
    //
    // The composer re-saves on unmount with no dirty check, so an unchanged
    // snapshot arrives here just from opening a thread and navigating away.
    vi.useFakeTimers();
    const saveComposerDraft = vi.fn<NonNullable<DesktopApi["saveComposerDraft"]>>(
      async (request) => ({ draft: request.draft }),
    );

    // Establish the hash the renderer itself produces for this content, so the
    // fixture cannot drift from the real implementation.
    const probeApi = { saveComposerDraft } as Partial<DesktopApi> as DesktopApi;
    const probe = renderHook(() =>
      useDurableComposerDraftStore(useComposerDraftStore(), probeApi),
    );
    act(() => {
      probe.result.current.set(
        "thread:codex:thread-1",
        buildSnapshot("A draft from a previous launch."),
      );
      vi.advanceTimersByTime(5_000);
    });
    const storedHash = saveComposerDraft.mock.calls[0]![0].draft.contentHash;
    probe.unmount();
    saveComposerDraft.mockClear();

    const hydratedApi = {
      saveComposerDraft,
      listComposerDraftLatest: async () => ({
        drafts: [
          {
            scopeKey: "thread:codex:thread-1",
            scopeKind: "thread" as const,
            backend: "codex" as const,
            threadId: "thread-1",
            text: "A draft from a previous launch.",
            skillTokens: [],
            imageAttachments: [],
            fileAttachments: [],
            status: "unsent" as const,
            createdAt: 1,
            updatedAt: 2,
            contentHash: storedHash,
            charCount: 31,
          },
        ],
      }),
    } as Partial<DesktopApi> as DesktopApi;
    // Hydration resolves a promise, and fake timers do not flush microtasks —
    // so let it settle on real timers before measuring the cadence.
    vi.useRealTimers();
    const { result } = renderHook(() =>
      useDurableComposerDraftStore(useComposerDraftStore(), hydratedApi),
    );
    await waitFor(() => {
      expect(result.current.get("thread:codex:thread-1")).toBeDefined();
    });
    vi.useFakeTimers();

    act(() => {
      result.current.set(
        "thread:codex:thread-1",
        buildSnapshot("A draft from a previous launch."),
      );
      vi.advanceTimersByTime(60_000);
    });

    expect(saveComposerDraft).not.toHaveBeenCalled();
  });

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
      // Assert the count and the boundary, not merely that something happened
      // — a per-keystroke implementation would satisfy `toHaveBeenCalled()`
      // and this is the test standing between the two designs.
      const { result, saveComposerDraft } = setup();

      act(() => {
        result.current.set("thread:codex:thread-1", buildSnapshot("a"));
      });

      // Keep editing across the whole window without ever pausing.
      act(() => {
        vi.advanceTimersByTime(2_500);
        result.current.set("thread:codex:thread-1", buildSnapshot("ab"));
      });
      expect(saveComposerDraft).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2_500);
        result.current.set("thread:codex:thread-1", buildSnapshot("abc"));
      });

      // Exactly one write, at the 5s boundary, carrying the newest text —
      // the edit that landed at 5s is coalesced into it rather than queued.
      expect(saveComposerDraft).toHaveBeenCalledOnce();
      expect(saveComposerDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({ text: "ab" }),
        }),
      );

      // ...and the edit made after that write starts a fresh window.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(saveComposerDraft).toHaveBeenCalledTimes(2);
      expect(saveComposerDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({ text: "abc" }),
        }),
      );
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

    it("flushes pending work when the window loses focus", () => {
      // The unmount cleanup is a React lifecycle hook, and a renderer being
      // torn down (window closed, app quit) does not run it. Blur lands well
      // before teardown, so this is what keeps "typed for four seconds then
      // quit" from losing the text now that the interval is 5s rather than
      // 200ms.
      const { result, saveComposerDraft } = setup();

      act(() => {
        result.current.set(
          "thread:codex:thread-1",
          buildSnapshot("Typed just before quitting."),
        );
      });
      expect(saveComposerDraft).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      expect(saveComposerDraft).toHaveBeenCalledOnce();
      expect(saveComposerDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({ text: "Typed just before quitting." }),
        }),
      );
    });

    it("writes nothing on blur when there is nothing pending", () => {
      const { saveComposerDraft } = setup();

      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      expect(saveComposerDraft).not.toHaveBeenCalled();
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
