import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useRecoverableState } from "./RendererRecoveryState";

/**
 * One entry in the renderer's browser-style navigation history. Only the
 * "content" surfaces are recorded: an open thread (by identity key), a
 * project launchpad (by directory key, plus the peer's instance id when the
 * launchpad starts its thread on another machine), a thread that is still
 * starting from a submitted launchpad, and the thread-search view.
 * Overlay-ish surfaces — Settings, Automations, and the empty no-selection
 * state — are deliberately untracked: they behave like modal chrome, not
 * places you navigate back to. The caller signals those by passing
 * `current: undefined`.
 */
export type NavigationHistoryLocation = (
  | { view: "launchpad"; directoryKey: string; instanceId?: string }
  | { view: "search" }
  /**
   * A submitted launchpad whose thread does not exist yet. Keyed by the
   * creation, not the directory: the directory's launchpad is an empty draft
   * again by now. When the thread lands, every entry for the creation becomes
   * that thread's entry. A creation that ends with no thread becomes its
   * launchpad's entry, where the draft was put back.
   */
  | { view: "starting"; creationId: string; directoryKey: string; instanceId?: string }
  | { view: "thread"; threadKey: string }
) & {
  /**
   * What the place was called when it was visited, for the Back/Forward
   * tooltips. Not part of its identity: a renamed thread is the same place.
   */
  label?: string;
};

/** Per-stack depth cap, matching what a browser-ish history needs. */
const MAX_HISTORY_DEPTH = 50;

function sameLocation(
  a: NavigationHistoryLocation,
  b: NavigationHistoryLocation,
): boolean {
  if (a.view === "search") {
    return b.view === "search";
  }
  if (a.view === "starting") {
    return b.view === "starting" && a.creationId === b.creationId;
  }
  if (a.view === "launchpad") {
    // Peer directory keys are the peer's paths, which can coincide with this
    // machine's, so the machine is part of a launchpad's identity.
    return b.view === "launchpad"
      && a.directoryKey === b.directoryKey
      && a.instanceId === b.instanceId;
  }
  return b.view === "thread" && a.threadKey === b.threadKey;
}

/**
 * Append with consecutive-duplicate dedup + depth cap. Launchpads are
 * singletons: revisiting a project's still-unsubmitted launchpad moves its
 * one history entry to the newest position instead of preserving stale
 * visits to the same live draft.
 */
function appendLocation(
  stack: NavigationHistoryLocation[],
  location: NavigationHistoryLocation,
): NavigationHistoryLocation[] {
  const base =
    location.view === "launchpad"
      ? stack.filter((candidate) => !sameLocation(candidate, location))
      : stack;
  const top = base[base.length - 1];
  if (top !== undefined && sameLocation(top, location)) {
    return base;
  }
  return [...base, location].slice(-MAX_HISTORY_DEPTH);
}

/**
 * Rewrite each entry through `resolve` and drop entries that no longer pass
 * `isLive`, collapsing any consecutive duplicates the changes expose
 * (A, dead, A → A). Returns the input array unchanged when nothing changed
 * so effect callers can compare by identity.
 */
function pruneStack(
  stack: NavigationHistoryLocation[],
  isLive: (location: NavigationHistoryLocation) => boolean,
  resolve: (location: NavigationHistoryLocation) => NavigationHistoryLocation,
): NavigationHistoryLocation[] {
  let rewritten = false;
  const resolved = stack.map((location) => {
    const next = resolve(location);
    rewritten ||= next !== location;
    return next;
  });
  const filtered = resolved.filter(isLive);
  if (!rewritten && filtered.length === stack.length) {
    return stack;
  }
  const collapsed: NavigationHistoryLocation[] = [];
  for (const location of filtered) {
    const top = collapsed[collapsed.length - 1];
    if (top !== undefined && sameLocation(top, location)) {
      continue;
    }
    collapsed.push(location);
  }
  return collapsed;
}

type HistoryStacks = {
  back: NavigationHistoryLocation[];
  /**
   * The history cursor: the last tracked location the user was on. Stays
   * put while an untracked surface (Settings, Automations) is in front, so
   * returning to the same location afterwards never records a hop.
   */
  cursor: NavigationHistoryLocation | undefined;
  forward: NavigationHistoryLocation[];
};

const EMPTY_STACKS: HistoryStacks = { back: [], cursor: undefined, forward: [] };

/**
 * Browser-style back/forward history over the app shell's navigation
 * state. The hook OBSERVES `current` rather than requiring every
 * navigation call-site to push explicitly — any change of the tracked
 * location (sidebar click, search result, menu deep-link, thread
 * creation) lands in the back stack automatically, and a new navigation
 * clears the forward stack, exactly like a browser.
 *
 * `restore` is invoked from goBack/goForward to set the shell state that
 * derives `current`; the hook moves its cursor first, so the resulting
 * `current` change is recognized as its own restore and not re-pushed.
 * Only a change of the observed location records a hop, so the page being
 * left can keep re-rendering until the restore lands.
 */
export function useNavigationHistory(args: {
  /** The tracked location now showing, or undefined on untracked surfaces. */
  current: NavigationHistoryLocation | undefined;
  /** Apply a previously recorded location. */
  restore: (location: NavigationHistoryLocation) => void;
  /**
   * Identity keys of the threads in the current navigation snapshot.
   * When provided, history entries pointing at vanished threads (archived,
   * backend disconnected) are pruned so Back/Forward never land on a dead
   * thread. Pass undefined while the snapshot is empty or still loading so
   * a transient blank list can't wipe the history.
   */
  liveThreadKeys?: ReadonlySet<string>;
  /** Explicit archive identities; absence from a bounded page is not deletion. */
  archivedThreadKeys?: ReadonlySet<string>;
  /**
   * Directory keys whose unsubmitted launchpads still exist. A successful
   * submission or discard removes the key and prunes that launchpad from
   * both directions of history.
   */
  liveLaunchpadKeys?: ReadonlySet<string>;
  /**
   * Creations still starting from a submitted launchpad, by creation id,
   * each with its thread's identity key once the owner has answered. A
   * `starting` entry follows its creation: it becomes the thread's entry when
   * the key arrives, and the launchpad's entry when the creation ends
   * without one. Pass undefined to leave `starting` entries alone.
   */
  startingThreads?: ReadonlyMap<string, string | undefined>;
}): {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Label of the place Back would open, when it was recorded with one. */
  backLabel?: string;
  forwardLabel?: string;
  goBack: () => void;
  goForward: () => void;
} {
  const [stacks, setStacks] = useRecoverableState<HistoryStacks>("navigation.history", EMPTY_STACKS);
  // Mirror for synchronous reads from goBack/goForward — the setState
  // value alone would go stale inside the stable callbacks below.
  const stacksRef = useRef(stacks);
  const currentRef = useRef<NavigationHistoryLocation | undefined>(undefined);
  const restoreRef = useRef(args.restore);
  useEffect(() => {
    restoreRef.current = args.restore;
  });

  const archivedThreadKeys = args.archivedThreadKeys;
  const startingThreads = args.startingThreads;
  // A creation's thread key, kept from the render that brought it until no
  // entry can still name the creation. The key and the creation's end can
  // arrive in separate renders, and the end alone must not read as a failure.
  const startedThreadKeysRef = useRef(new Map<string, string>());
  // Creation ids the current-location effect has already seen. A `starting`
  // location for an id not in here is the launchpad being submitted.
  const knownCreationIdsRef = useRef<ReadonlySet<string>>(new Set());
  const startedThreadKey = args.current?.view === "starting"
    ? startingThreads?.get(args.current.creationId)
    : undefined;
  const currentLabel = args.current?.label;
  const startedThreadLocation = useMemo<NavigationHistoryLocation | undefined>(
    () => startedThreadKey !== undefined
      ? {
          view: "thread",
          threadKey: startedThreadKey,
          ...(currentLabel !== undefined ? { label: currentLabel } : {}),
        }
      : undefined,
    [currentLabel, startedThreadKey],
  );
  const resolvedCurrent = startedThreadLocation ?? args.current;
  const current = resolvedCurrent?.view === "thread" && archivedThreadKeys?.has(resolvedCurrent.threadKey)
    ? undefined
    : resolvedCurrent;
  useEffect(() => {
    const observed = currentRef.current;
    currentRef.current = current;
    if (current === undefined) {
      // Untracked surface in front; the cursor holds its place.
      return;
    }
    const prev = stacksRef.current;
    if (prev.cursor !== undefined && sameLocation(prev.cursor, current)) {
      // Same place (or our own goBack/goForward restore) — nothing to record.
      // A thread's title often arrives after its key, so the cursor takes
      // the newer label rather than keeping a blank one for the back stack.
      if (current.label !== undefined && current.label !== prev.cursor.label) {
        const next: HistoryStacks = { ...prev, cursor: current };
        stacksRef.current = next;
        setStacks(next);
      }
      return;
    }
    if (
      current.view === "starting"
      && !knownCreationIdsRef.current.has(current.creationId)
      && prev.cursor?.view === "launchpad"
      && prev.cursor.directoryKey === current.directoryKey
      && prev.cursor.instanceId === current.instanceId
    ) {
      // Submitting a launchpad turns the draft into the starting thread. It
      // replaces the launchpad's entry instead of stacking on it: going Back
      // to the directory's launchpad would open an empty draft.
      const next: HistoryStacks = { ...prev, cursor: current };
      stacksRef.current = next;
      setStacks(next);
      return;
    }
    if (observed !== undefined && sameLocation(observed, current)) {
      // Only a change of location is a navigation. goBack/goForward move the
      // cursor before their restore commits, so the page being left can
      // still re-derive here: a commit whose effect was pending when Back
      // was clicked, or a restore that settles asynchronously. Recording it
      // would push the page being left and clear Forward.
      return;
    }
    const baseBack =
      current.view === "launchpad"
        ? prev.back.filter((location) => !sameLocation(location, current))
        : prev.back;
    const next: HistoryStacks = {
      back:
        prev.cursor !== undefined
          ? appendLocation(baseBack, prev.cursor)
          : baseBack,
      cursor: current,
      forward: [],
    };
    stacksRef.current = next;
    setStacks(next);
  }, [current]);
  // Declared after the effect above, so that effect sees a new creation as
  // new in the commit that brings it.
  useEffect(() => {
    if (startingThreads !== undefined) {
      knownCreationIdsRef.current = new Set(startingThreads.keys());
    }
  }, [startingThreads]);

  const liveThreadKeys = args.liveThreadKeys;
  const liveLaunchpadKeys = args.liveLaunchpadKeys;
  useLayoutEffect(() => {
    if (
      liveThreadKeys === undefined
      && liveLaunchpadKeys === undefined
      && archivedThreadKeys === undefined
      && startingThreads === undefined
    ) {
      return;
    }
    const startedThreadKeys = startedThreadKeysRef.current;
    for (const [creationId, threadKey] of startingThreads ?? []) {
      if (threadKey !== undefined) {
        startedThreadKeys.set(creationId, threadKey);
      }
    }
    const resolve = (location: NavigationHistoryLocation): NavigationHistoryLocation => {
      if (location.view !== "starting" || startingThreads === undefined) {
        return location;
      }
      const threadKey = startingThreads.get(location.creationId)
        ?? startedThreadKeys.get(location.creationId);
      const label = location.label !== undefined ? { label: location.label } : {};
      if (threadKey !== undefined) {
        return { view: "thread", threadKey, ...label };
      }
      if (startingThreads.has(location.creationId)) {
        return location;
      }
      // Ended with no thread. Main put the draft back in the launchpad.
      return {
        view: "launchpad",
        directoryKey: location.directoryKey,
        ...(location.instanceId !== undefined ? { instanceId: location.instanceId } : {}),
      };
    };
    const prev = stacksRef.current;
    const isLive = (location: NavigationHistoryLocation): boolean => {
      if (location.view === "thread") {
        return !archivedThreadKeys?.has(location.threadKey)
          && (liveThreadKeys === undefined || liveThreadKeys.has(location.threadKey));
      }
      if (location.view === "launchpad") {
        // The live set lists this machine's launchpads; a peer's is not in it.
        return liveLaunchpadKeys === undefined
          || location.instanceId !== undefined
          || liveLaunchpadKeys.has(location.directoryKey);
      }
      return true;
    };
    let back = pruneStack(prev.back, isLive, resolve);
    let forward = pruneStack(prev.forward, isLive, resolve);
    const resolvedCursor = prev.cursor !== undefined ? resolve(prev.cursor) : undefined;
    let cursor =
      resolvedCursor !== undefined && isLive(resolvedCursor)
        ? resolvedCursor
        : undefined;
    if (startingThreads !== undefined) {
      // Every entry for an ended creation was rewritten above.
      for (const creationId of startedThreadKeys.keys()) {
        if (!startingThreads.has(creationId)) {
          startedThreadKeys.delete(creationId);
        }
      }
    }
    if (
      prev.cursor !== undefined
      && cursor === undefined
      && back.length > 0
    ) {
      // A cancelled launchpad clears the shell selection, making `current`
      // untracked. Preserve a usable Back target by promoting the newest live
      // entry into the cursor that untracked-surface navigation restores.
      cursor = back[back.length - 1];
      back = back.slice(0, -1);
    }
    // Removing the middle visit in A → archived B → A must not leave an
    // enabled Back button targeting the location already showing.
    while (cursor && back.length && sameLocation(back[back.length - 1], cursor)) {
      back = back.slice(0, -1);
    }
    while (cursor && forward.length && sameLocation(forward[0], cursor)) {
      forward = forward.slice(1);
    }
    if (
      back === prev.back
      && cursor === prev.cursor
      && forward === prev.forward
    ) {
      return;
    }
    // Drop a dead cursor too. During launch submission, the materialized
    // thread becomes the next cursor; during cancellation, the promotion
    // above preserves the prior live location for Back.
    const next: HistoryStacks = { back, cursor, forward };
    stacksRef.current = next;
    setStacks(next);
  }, [archivedThreadKeys, current, liveLaunchpadKeys, liveThreadKeys, startingThreads]);

  const goBack = useCallback((): void => {
    const prev = stacksRef.current;
    if (currentRef.current === undefined) {
      // From an untracked surface, "back" returns to the last tracked
      // location without consuming a history entry — like dismissing the
      // overlay rather than walking the stack.
      if (prev.cursor !== undefined) {
        restoreRef.current(prev.cursor);
      }
      return;
    }
    const target = prev.back[prev.back.length - 1];
    if (target === undefined) {
      return;
    }
    const next: HistoryStacks = {
      back: prev.back.slice(0, -1),
      cursor: target,
      forward:
        prev.cursor !== undefined
          ? [prev.cursor, ...prev.forward].slice(0, MAX_HISTORY_DEPTH)
          : prev.forward,
    };
    stacksRef.current = next;
    setStacks(next);
    restoreRef.current(target);
  }, []);

  const goForward = useCallback((): void => {
    const prev = stacksRef.current;
    const target = prev.forward[0];
    if (target === undefined) {
      return;
    }
    const next: HistoryStacks = {
      back:
        prev.cursor !== undefined
          ? appendLocation(prev.back, prev.cursor)
          : prev.back,
      cursor: target,
      forward: prev.forward.slice(1),
    };
    stacksRef.current = next;
    setStacks(next);
    restoreRef.current(target);
  }, []);

  const canGoBack =
    stacks.back.length > 0 ||
    (current === undefined && stacks.cursor !== undefined);
  const canGoForward = stacks.forward.length > 0;
  // Mirrors goBack: from an untracked surface, Back returns to the cursor.
  const backLabel = current === undefined
    ? stacks.cursor?.label
    : stacks.back[stacks.back.length - 1]?.label;
  const forwardLabel = stacks.forward[0]?.label;

  return useMemo(
    () => ({ backLabel, canGoBack, canGoForward, forwardLabel, goBack, goForward }),
    [backLabel, canGoBack, canGoForward, forwardLabel, goBack, goForward],
  );
}
