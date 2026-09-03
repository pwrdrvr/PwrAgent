import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
  THREAD_HISTORY_PAGE_LIMIT,
} from "../../../lib/thread-history-limits";
import { useTranscriptWindow } from "../useTranscriptWindow";

function entries(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `e${index}`);
}

type MessageEntry = {
  id: string;
  role: "assistant" | "user";
  text: string;
  type: "message";
};

function assistantEntries(count: number): MessageEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `assistant-${index}`,
    role: "assistant",
    text: `Assistant entry ${index}`,
    type: "message",
  }));
}

const SERVER_HAS_MORE = {
  supportsPagination: true,
  hasPreviousPage: true,
  previousCursor: "cursor-1",
};

describe("useTranscriptWindow", () => {
  it("mounts only the newest entries", () => {
    const { result } = renderHook(() =>
      useTranscriptWindow({
        entries: entries(200),
        onLoadOlder: vi.fn(),
        threadKey: "t",
      }),
    );

    expect(result.current.visibleEntries).toHaveLength(
      DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
    );
    // The TAIL, not the head: a transcript opens at its newest message.
    expect(result.current.visibleEntries.at(-1)).toBe("e199");
    expect(result.current.hiddenCount).toBe(
      200 - DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
    );
  });

  it("leaves a short transcript whole", () => {
    const { result } = renderHook(() =>
      useTranscriptWindow({
        entries: entries(3),
        onLoadOlder: vi.fn(),
        threadKey: "t",
      }),
    );

    expect(result.current.visibleEntries).toHaveLength(3);
    expect(result.current.hiddenCount).toBe(0);
    expect(result.current.hasMoreHistory).toBe(false);
  });

  it("keeps the latest user prompt visible when one long turn crosses the render limit", () => {
    const prompt: MessageEntry = {
      id: "user-prompt",
      role: "user",
      text: "Investigate the noisy canary error logs.",
      type: "message",
    };
    const { result } = renderHook(() =>
      useTranscriptWindow({
        entries: [
          prompt,
          ...assistantEntries(DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT),
        ],
        onLoadOlder: vi.fn(),
        threadKey: "long-first-turn",
      }),
    );

    expect(
      result.current.visibleEntries.filter((entry) => entry.role === "user"),
    ).toEqual([prompt]);
    expect(result.current.visibleEntries.at(-1)?.id).toBe("assistant-39");
  });

  it("pins only the newest copy when optimistic and authoritative prompts precede the window", () => {
    const promptText = "Investigate the noisy canary error logs.";
    const optimisticPrompt: MessageEntry = {
      id: "optimistic-launchpad-thread-1",
      role: "user",
      text: promptText,
      type: "message",
    };
    const authoritativePrompt: MessageEntry = {
      id: "authoritative-user-message",
      role: "user",
      text: promptText,
      type: "message",
    };
    const { result } = renderHook(() =>
      useTranscriptWindow({
        entries: [
          optimisticPrompt,
          authoritativePrompt,
          ...assistantEntries(DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT),
        ],
        onLoadOlder: vi.fn(),
        threadKey: "reconciled-first-turn",
      }),
    );

    expect(
      result.current.visibleEntries.filter((entry) => entry.role === "user"),
    ).toEqual([authoritativePrompt]);
  });

  it("claims a previous page while entries are held back locally", () => {
    const { result } = renderHook(() =>
      useTranscriptWindow({
        entries: entries(200),
        onLoadOlder: vi.fn(),
        threadKey: "t",
      }),
    );

    // The server has nothing more, but we do — without this the transcript
    // hides its load-older affordance over entries it already holds.
    expect(result.current.visiblePagination).toMatchObject({
      hasPreviousPage: true,
      supportsPagination: true,
    });
    expect(result.current.hasMoreHistory).toBe(true);
  });

  it("widens the window before it goes back to the server", async () => {
    const onLoadOlder = vi.fn();
    const onLimitChange = vi.fn();
    const { result } = renderHook(() =>
      useTranscriptWindow({
        entries: entries(200),
        limit: DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
        onLimitChange,
        onLoadOlder,
        pagination: SERVER_HAS_MORE,
        threadKey: "t",
      }),
    );

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(onLimitChange).toHaveBeenCalledWith(
      DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT + THREAD_HISTORY_PAGE_LIMIT,
    );
    // Nothing fetched: the entries it just revealed were already here.
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("fetches once the window has caught up with what was fetched", async () => {
    const onLoadOlder = vi.fn();
    const onLimitChange = vi.fn();
    const { result } = renderHook(() =>
      useTranscriptWindow({
        entries: entries(10),
        limit: DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT,
        onLimitChange,
        onLoadOlder,
        pagination: SERVER_HAS_MORE,
        threadKey: "t",
      }),
    );

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    // Capacity is reserved first, or the prepended page stays hidden behind
    // the existing tail window until a second upward scroll.
    expect(onLimitChange).toHaveBeenCalledWith(
      DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT + THREAD_HISTORY_PAGE_LIMIT,
    );
  });

  it("owns the limit itself when nobody else does", async () => {
    const { result, rerender } = renderHook(
      (props: { entries: string[] }) =>
        useTranscriptWindow({
          entries: props.entries,
          onLoadOlder: vi.fn(),
          threadKey: "t",
        }),
      { initialProps: { entries: entries(200) } },
    );

    await act(async () => {
      await result.current.loadOlder();
    });
    rerender({ entries: entries(200) });

    expect(result.current.visibleEntries).toHaveLength(
      DEFAULT_RENDERED_TRANSCRIPT_ENTRY_LIMIT + THREAD_HISTORY_PAGE_LIMIT,
    );
  });
});
