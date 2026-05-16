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
