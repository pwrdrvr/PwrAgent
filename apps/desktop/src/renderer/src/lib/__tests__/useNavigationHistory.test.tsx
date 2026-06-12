import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useNavigationHistory,
  type NavigationHistoryLocation,
} from "../useNavigationHistory";

function thread(threadKey: string): NavigationHistoryLocation {
  return { view: "thread", threadKey };
}

const SEARCH: NavigationHistoryLocation = { view: "search" };

/**
 * Drive the hook the way the app shell does: `restore` synchronously
 * updates the state that feeds `current` back in on the next render.
 */
function renderHistory(initial: NavigationHistoryLocation | undefined) {
  const restore = vi.fn();
  const hook = renderHook(
    ({ current }: { current: NavigationHistoryLocation | undefined }) =>
      useNavigationHistory({ current, restore }),
    { initialProps: { current: initial } },
  );
  const navigate = (current: NavigationHistoryLocation | undefined): void => {
    act(() => {
      hook.rerender({ current });
    });
  };
  // Apply what restore asked for, like App's setMainView/showThread would.
  const settle = (): void => {
    const location = restore.mock.lastCall?.[0] as
      | NavigationHistoryLocation
      | undefined;
    if (location !== undefined) {
      navigate(location);
    }
  };
  return { hook, navigate, restore, settle };
}

describe("useNavigationHistory", () => {
  it("starts with both directions disabled", () => {
    const { hook } = renderHistory(thread("codex:a"));
    expect(hook.result.current.canGoBack).toBe(false);
    expect(hook.result.current.canGoForward).toBe(false);
  });

  it("records thread-to-thread navigation and walks back/forward", () => {
    const { hook, navigate, restore, settle } = renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    expect(hook.result.current.canGoBack).toBe(true);

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:a"));
    settle();
    expect(hook.result.current.canGoBack).toBe(false);
    expect(hook.result.current.canGoForward).toBe(true);

    act(() => hook.result.current.goForward());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:b"));
    settle();
    expect(hook.result.current.canGoBack).toBe(true);
    expect(hook.result.current.canGoForward).toBe(false);
  });

  it("supports the search round-trip: thread → search → result → back → next result", () => {
    const { hook, navigate, restore, settle } = renderHistory(thread("codex:a"));
    navigate(SEARCH);
    navigate(thread("codex:b"));

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(SEARCH);
    settle();

    // Opening a different result from search clears the forward stack.
    navigate(thread("codex:c"));
    expect(hook.result.current.canGoForward).toBe(false);

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(SEARCH);
    settle();
    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:a"));
    settle();
    expect(hook.result.current.canGoBack).toBe(false);
  });

  it("does not record re-selecting the current location", () => {
    const { hook, navigate } = renderHistory(thread("codex:a"));
    navigate(thread("codex:a"));
    expect(hook.result.current.canGoBack).toBe(false);
  });

  it("holds the cursor across untracked surfaces (settings, launchpads)", () => {
    const { hook, navigate } = renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    navigate(undefined); // e.g. Settings overlay opens
    navigate(thread("codex:b")); // ...and closes back onto the same thread
    expect(hook.result.current.canGoBack).toBe(true);

    act(() => hook.result.current.goBack());
    // Straight to thread a — the settings detour never became an entry.
    expect(hook.result.current.canGoForward).toBe(true);
  });

  it("returns to the last tracked location from an untracked surface without consuming an entry", () => {
    const { hook, navigate, restore, settle } = renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    navigate(undefined); // launchpad in front
    expect(hook.result.current.canGoBack).toBe(true);

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:b"));
    settle();

    // The b → a entry is still there for the next back.
    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:a"));
  });

  it("keeps the forward stack usable from an untracked surface", () => {
    const { hook, navigate, restore, settle } = renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    act(() => hook.result.current.goBack());
    settle(); // at a, forward = [b]
    navigate(undefined); // launchpad in front

    act(() => hook.result.current.goForward());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:b"));
    settle();
    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:a"));
  });

  it("ignores back/forward when the stacks are empty", () => {
    const { hook, restore } = renderHistory(thread("codex:a"));
    act(() => hook.result.current.goBack());
    act(() => hook.result.current.goForward());
    expect(restore).not.toHaveBeenCalled();
  });

  it("caps the back stack at 50 entries", () => {
    const { hook, navigate, restore, settle } = renderHistory(thread("codex:t0"));
    for (let index = 1; index <= 60; index += 1) {
      navigate(thread(`codex:t${index}`));
    }
    for (let index = 0; index < 50; index += 1) {
      expect(hook.result.current.canGoBack).toBe(true);
      act(() => hook.result.current.goBack());
      settle();
    }
    expect(hook.result.current.canGoBack).toBe(false);
    // Oldest surviving entry is t10 (t0..t9 fell off the cap).
    expect(restore).toHaveBeenLastCalledWith(thread("codex:t10"));
  });
});
