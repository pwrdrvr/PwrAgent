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
});

function buildSnapshot(draft: string): ComposerDraftSnapshot {
  return {
    draft,
    editorDocument: undefined,
    imageAttachments: [],
    skillTokens: [],
  };
}
