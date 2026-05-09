import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "../useMediaQuery";

type FakeMediaQueryList = {
  matches: boolean;
  // Test-only: flip the matches value and notify listeners.
  setMatches: (next: boolean) => void;
};

type FakeMatchMedia = ((query: string) => MediaQueryList) & {
  // Test-only: get the writable fake associated with a query.
  __get(query: string): FakeMediaQueryList | undefined;
};

function createFakeMatchMedia(initial: Record<string, boolean>): FakeMatchMedia {
  // The browser's `MediaQueryList` declares `matches` readonly, but
  // a real implementation flips it internally before notifying
  // listeners. Our fake is a writable mirror; the cast at the
  // function-return site re-asserts the readonly contract for
  // hook consumers. Only `addEventListener("change", ...)` is
  // exercised by the hook; the legacy `addListener` path is a
  // no-op so the type satisfies `MediaQueryList` without forcing
  // the hook to support both registration shapes.
  const queries = new Map<string, FakeMediaQueryList>();
  const fn = ((query: string): MediaQueryList => {
    const existing = queries.get(query);
    if (existing) return existing as unknown as MediaQueryList;
    const handlers = new Set<(event: MediaQueryListEvent) => void>();
    const target = {
      matches: initial[query] ?? false,
      media: query,
      onchange: null,
      addEventListener(
        _event: "change",
        handler: (event: MediaQueryListEvent) => void,
      ) {
        handlers.add(handler);
      },
      removeEventListener(
        _event: "change",
        handler: (event: MediaQueryListEvent) => void,
      ) {
        handlers.delete(handler);
      },
      addListener() {
        // legacy path; unused
      },
      removeListener() {
        // legacy path; unused
      },
      dispatchEvent() {
        return true;
      },
      setMatches(next: boolean) {
        target.matches = next;
        for (const handler of handlers) {
          handler({ matches: next, media: query } as MediaQueryListEvent);
        }
      },
    };
    queries.set(query, target);
    return target as unknown as MediaQueryList;
  }) as FakeMatchMedia;
  fn.__get = (query: string) => queries.get(query);
  return fn;
}

describe("useMediaQuery", () => {
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia;
    } else {
      // @ts-expect-error: cleanup for jsdom that didn't have matchMedia
      delete window.matchMedia;
    }
  });

  it("returns the initial match value synchronously on the first render", () => {
    window.matchMedia = createFakeMatchMedia({ "(min-width: 1700px)": true });
    const { result } = renderHook(() => useMediaQuery("(min-width: 1700px)"));
    expect(result.current).toBe(true);
  });

  it("returns false initially when the query does not match", () => {
    window.matchMedia = createFakeMatchMedia({ "(min-width: 1700px)": false });
    const { result } = renderHook(() => useMediaQuery("(min-width: 1700px)"));
    expect(result.current).toBe(false);
  });

  it("flips the returned value when the media query changes", () => {
    const matchMedia = createFakeMatchMedia({ "(min-width: 1700px)": false });
    window.matchMedia = matchMedia;
    const { result } = renderHook(() => useMediaQuery("(min-width: 1700px)"));
    expect(result.current).toBe(false);

    act(() => {
      matchMedia.__get("(min-width: 1700px)")?.setMatches(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      matchMedia.__get("(min-width: 1700px)")?.setMatches(false);
    });
    expect(result.current).toBe(false);
  });

  it("removes its change listener on unmount", () => {
    const removeSpy = vi.fn();
    const fakeMql: MediaQueryList = {
      matches: false,
      media: "(min-width: 1700px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: removeSpy,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    window.matchMedia = vi.fn().mockReturnValue(fakeMql);
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 1700px)"));
    expect(removeSpy).not.toHaveBeenCalled();
    unmount();
    expect(removeSpy).toHaveBeenCalledOnce();
  });

  it("returns false when matchMedia is not available", () => {
    // @ts-expect-error: simulate non-browser env
    window.matchMedia = undefined;
    const { result } = renderHook(() => useMediaQuery("(min-width: 1700px)"));
    expect(result.current).toBe(false);
  });
});
