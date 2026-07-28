import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useNavigationHistory,
  type NavigationHistoryLocation,
} from "../useNavigationHistory";

function thread(threadKey: string): NavigationHistoryLocation {
  return { view: "thread", threadKey };
}

function launchpad(directoryKey: string): NavigationHistoryLocation {
  return { view: "launchpad", directoryKey };
}

const SEARCH: NavigationHistoryLocation = { view: "search" };

type HistoryHookProps = {
  current: NavigationHistoryLocation | undefined;
  liveLaunchpadKeys?: ReadonlySet<string>;
  liveThreadKeys?: ReadonlySet<string>;
};

/**
 * Drive the hook the way the app shell does: `restore` synchronously
 * updates the state that feeds `current` back in on the next render.
 */
function renderHistory(initial: NavigationHistoryLocation | undefined) {
  const restore = vi.fn();
  let props: HistoryHookProps = { current: initial };
  const hook = renderHook(
    (hookProps: HistoryHookProps) =>
      useNavigationHistory({ ...hookProps, restore }),
    { initialProps: props },
  );
  const update = (patch: Partial<HistoryHookProps>): void => {
    props = { ...props, ...patch };
    act(() => {
      hook.rerender(props);
    });
  };
  const navigate = (current: NavigationHistoryLocation | undefined): void => {
    update({ current });
  };
  const setLiveThreadKeys = (keys: ReadonlySet<string> | undefined): void => {
    update({ liveThreadKeys: keys });
  };
  const setLiveLaunchpadKeys = (keys: ReadonlySet<string> | undefined): void => {
    update({ liveLaunchpadKeys: keys });
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
  return {
    hook,
    navigate,
    restore,
    setLiveLaunchpadKeys,
    setLiveThreadKeys,
    settle,
  };
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

  it("holds the cursor across untracked overlay surfaces", () => {
    const { hook, navigate } = renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    navigate(undefined); // e.g. Settings opens
    navigate(thread("codex:b")); // ...and closes back onto the same thread
    expect(hook.result.current.canGoBack).toBe(true);

    act(() => hook.result.current.goBack());
    // Straight to thread a — the settings detour never became an entry.
    expect(hook.result.current.canGoForward).toBe(true);
  });

  it("returns to the last tracked location from an untracked surface without consuming an entry", () => {
    const { hook, navigate, restore, settle } = renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    navigate(undefined); // Settings in front
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
    navigate(undefined); // Settings in front

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

  it("returns to an unsubmitted project launchpad with its live draft", () => {
    const { hook, navigate, restore, settle } =
      renderHistory(thread("codex:a"));
    navigate(launchpad("directory:/repo"));
    navigate(thread("codex:b"));

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(launchpad("directory:/repo"));
    settle();

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:a"));
  });

  it("keeps only the newest history position for each project launchpad", () => {
    const { hook, navigate, restore, settle } =
      renderHistory(thread("codex:a"));
    navigate(launchpad("directory:/repo-a"));
    navigate(thread("codex:b"));
    navigate(launchpad("directory:/repo-b"));
    navigate(thread("codex:c"));
    navigate(launchpad("directory:/repo-a"));
    navigate(thread("codex:d"));

    const expected = [
      launchpad("directory:/repo-a"),
      thread("codex:c"),
      launchpad("directory:/repo-b"),
      thread("codex:b"),
      thread("codex:a"),
    ];
    for (const location of expected) {
      act(() => hook.result.current.goBack());
      expect(restore).toHaveBeenLastCalledWith(location);
      settle();
    }
    expect(hook.result.current.canGoBack).toBe(false);
  });

  it("removes a submitted launchpad without removing other project launchpads", () => {
    const {
      hook,
      navigate,
      restore,
      setLiveLaunchpadKeys,
      settle,
    } = renderHistory(thread("codex:a"));
    setLiveLaunchpadKeys(
      new Set(["directory:/repo-a", "directory:/repo-b"]),
    );
    navigate(launchpad("directory:/repo-b"));
    navigate(thread("codex:b"));
    navigate(launchpad("directory:/repo-a"));

    // Submission clears repo-a's launchpad before selecting its new thread.
    setLiveLaunchpadKeys(new Set(["directory:/repo-b"]));
    navigate(thread("codex:new"));
    navigate(thread("codex:c"));

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:new"));
    settle();
    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:b"));
    settle();
    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(launchpad("directory:/repo-b"));
  });

  it("prunes vanished threads from both stacks so Back never lands on a dead thread", () => {
    const { hook, navigate, restore, setLiveThreadKeys, settle } =
      renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    navigate(thread("codex:c"));
    // Walk back so b sits in the forward stack too: back=[a], forward=[c].
    act(() => hook.result.current.goBack());
    settle();
    act(() => hook.result.current.goBack());
    settle(); // at a, forward = [b, c]

    // Thread b gets archived out of the snapshot.
    setLiveThreadKeys(new Set(["codex:a", "codex:c"]));

    act(() => hook.result.current.goForward());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:c"));
  });

  it("collapses consecutive duplicates exposed by pruning", () => {
    const { hook, navigate, restore, setLiveThreadKeys, settle } =
      renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    navigate(thread("codex:a"));
    navigate(thread("codex:b"));
    navigate(thread("codex:c")); // back = [a, b, a, b]

    setLiveThreadKeys(new Set(["codex:a", "codex:c"])); // back → [a]

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(thread("codex:a"));
    settle();
    expect(hook.result.current.canGoBack).toBe(false);
  });

  it("keeps search entries when pruning threads", () => {
    const { hook, navigate, restore, setLiveThreadKeys, settle } =
      renderHistory(thread("codex:a"));
    navigate(SEARCH);
    navigate(thread("codex:b")); // back = [a, search]

    setLiveThreadKeys(new Set(["codex:b"])); // back → [search]

    act(() => hook.result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(SEARCH);
    settle();
    expect(hook.result.current.canGoBack).toBe(false);
  });

  it("leaves history alone while liveThreadKeys is undefined (snapshot loading)", () => {
    const { hook, navigate, setLiveThreadKeys } = renderHistory(thread("codex:a"));
    navigate(thread("codex:b"));
    setLiveThreadKeys(new Set(["codex:a", "codex:b"]));
    setLiveThreadKeys(undefined); // e.g. transient empty snapshot
    expect(hook.result.current.canGoBack).toBe(true);
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
