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
