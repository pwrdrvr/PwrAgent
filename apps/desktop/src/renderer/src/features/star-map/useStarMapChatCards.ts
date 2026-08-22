import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildThreadIdentityKey,
  snapshotStarMapWorkspaceThread,
  starMapWorkspaceCardKey,
  STAR_MAP_WORKSPACE_VERSION,
  type NavigationThreadSummary,
  type StarMapWorkspaceAnchor,
  type StarMapWorkspaceLayout,
  type StarMapWorkspaceSnapshot,
  type StarMapWorkspaceThreadSnapshot,
  type StarMapWorkspaceView,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  cascadeChatCardRect,
  placeChatCardBesideAnchor,
  type ChatCardRect,
} from "./star-map-chat-card-geometry";

export type StarMapChatCardEntry = {
  key: string;
  ownerInstanceId: string;
  threadKey: string;
  rect: ChatCardRect;
  thread: StarMapWorkspaceThreadSnapshot;
  anchor: StarMapWorkspaceAnchor;
  anchorDx: number;
  anchorDy: number;
  instanceDx?: number;
  instanceDy?: number;
  /** One initial relative-anchor resolution; a later peer connection must
   * not teleport an already-visible card away from its fallback rectangle. */
  pendingAnchorRestore: boolean;
  contextOpen: boolean;
  terminalOpen: boolean;
  terminalHeight?: number;
};

export type StarMapChatCardAnchorPlacement = {
  anchor: StarMapWorkspaceAnchor;
  point: { x: number; y: number };
  /** Owner-body basis used when a thread card is unavailable on restore. */
  instancePoint?: { x: number; y: number };
};

export type StarMapChatCardAnchorResolution = {
  point: { x: number; y: number };
  basis: "anchor" | "instance";
};

type StarMapChatCardsState = {
  cards: StarMapChatCardEntry[];
  views: Partial<Record<StarMapWorkspaceLayout, StarMapWorkspaceView>>;
};

export type StarMapChatCardsController = {
  cards: StarMapChatCardEntry[];
  hydrated: boolean;
  close: (cardKey: string) => void;
  closeAll: () => void;
  depthOf: (cardKey: string) => number;
  open: (
    ownerInstanceId: string,
    thread: NavigationThreadSummary,
    placement?: {
      anchor: StarMapChatCardAnchorPlacement;
      bounds: { width: number; height: number };
      sourceRect: { x: number; y: number; width: number; height: number };
    },
    options?: { persist?: boolean },
  ) => void;
  raise: (cardKey: string, persist?: boolean) => boolean;
  remapOwner: (placeholderInstanceId: string, durableInstanceId: string) => void;
  /** Pointer-frame update. Deliberately memory-only. */
  setRect: (cardKey: string, rect: ChatCardRect) => void;
  /** Completed gesture: update relative geometry and persist once. */
  commitRect: (
    cardKey: string,
    rect: ChatCardRect,
    anchor?: StarMapChatCardAnchorPlacement,
  ) => void;
  resolveRestoredAnchors: (
    resolve: (
      anchor: StarMapWorkspaceAnchor,
    ) => StarMapChatCardAnchorResolution | undefined,
  ) => void;
  toggleContext: (cardKey: string) => void;
  toggleTerminal: (cardKey: string) => void;
  setTerminalHeight: (cardKey: string, height: number) => void;
  commitTerminalHeight: (cardKey: string, height: number) => void;
  viewFor: (layout: StarMapWorkspaceLayout) => StarMapWorkspaceView | undefined;
  commitView: (
    layout: StarMapWorkspaceLayout,
    view: StarMapWorkspaceView,
  ) => void;
  resetView: (layout: StarMapWorkspaceLayout) => void;
};

const EMPTY_STATE: StarMapChatCardsState = { cards: [], views: {} };
const WORKSPACE_LAYOUTS: readonly StarMapWorkspaceLayout[] = [
  "lanes",
  "orbit",
  "projects",
];

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function instancePointForPlacement(
  placement: StarMapChatCardAnchorPlacement,
): { x: number; y: number } | undefined {
  if (placement.instancePoint) return placement.instancePoint;
  return placement.anchor.kind === "instance" ? placement.point : undefined;
}

function snapshotCard(
  card: StarMapChatCardEntry,
): StarMapWorkspaceSnapshot["cards"][number] {
  return {
    key: card.key,
    ownerInstanceId: card.ownerInstanceId,
    thread: card.thread,
    geometry: {
      anchor: card.anchor,
      dx: card.anchorDx,
      dy: card.anchorDy,
      instanceDx: card.instanceDx,
      instanceDy: card.instanceDy,
      fallbackRect: card.rect,
    },
    contextOpen: card.contextOpen,
    terminalOpen: card.terminalOpen,
    terminalHeight: card.terminalHeight,
  };
}

function snapshotFor(state: StarMapChatCardsState): StarMapWorkspaceSnapshot {
  return {
    version: STAR_MAP_WORKSPACE_VERSION,
    cards: state.cards.map(snapshotCard),
    views: state.views,
  };
}

function snapshotsMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function raisedCardKey(
  base: StarMapWorkspaceSnapshot,
  next: StarMapWorkspaceSnapshot,
): string | undefined {
  if (base.cards.length !== next.cards.length || next.cards.length === 0) {
    return undefined;
  }
  const candidate = next.cards.at(-1)?.key;
  if (!candidate) return undefined;
  const baseKeys = base.cards.map((card) => card.key);
  const nextKeys = next.cards.map((card) => card.key);
  if (
    !baseKeys.every((key) => nextKeys.includes(key))
    || snapshotsMatch(baseKeys, nextKeys)
  ) {
    return undefined;
  }
  const moved = [...baseKeys.filter((key) => key !== candidate), candidate];
  return snapshotsMatch(moved, nextKeys) ? candidate : undefined;
}

function rebaseCardChange(params: {
  base: StarMapWorkspaceSnapshot["cards"][number];
  next: StarMapWorkspaceSnapshot["cards"][number];
  latest?: StarMapWorkspaceSnapshot["cards"][number];
}): StarMapWorkspaceSnapshot["cards"][number] {
  const latest = params.latest ?? params.base;
  return {
    key: params.next.key,
    ownerInstanceId:
      params.base.ownerInstanceId === params.next.ownerInstanceId
        ? latest.ownerInstanceId
        : params.next.ownerInstanceId,
    thread: snapshotsMatch(params.base.thread, params.next.thread)
      ? latest.thread
      : params.next.thread,
    geometry: snapshotsMatch(params.base.geometry, params.next.geometry)
      ? latest.geometry
      : params.next.geometry,
    contextOpen:
      params.base.contextOpen === params.next.contextOpen
        ? latest.contextOpen
        : params.next.contextOpen,
    terminalOpen:
      params.base.terminalOpen === params.next.terminalOpen
        ? latest.terminalOpen
        : params.next.terminalOpen,
    terminalHeight:
      params.base.terminalHeight === params.next.terminalHeight
        ? latest.terminalHeight
        : params.next.terminalHeight,
  };
}

/**
 * Reapply one viewer gesture to a newer durable snapshot. Each queued write
 * carries the before/after pair from the local semantic boundary, so a peer
 * window's intervening cards and camera changes survive a revision conflict.
 */
function rebaseWorkspaceChange(params: {
  base: StarMapWorkspaceSnapshot;
  next: StarMapWorkspaceSnapshot;
  latest: StarMapWorkspaceSnapshot;
}): StarMapWorkspaceSnapshot {
  const baseByKey = new Map(params.base.cards.map((card) => [card.key, card]));
  const nextByKey = new Map(params.next.cards.map((card) => [card.key, card]));
  let cards = params.latest.cards.filter(
    (card) => !(baseByKey.has(card.key) && !nextByKey.has(card.key)),
  );
  for (const nextCard of params.next.cards) {
    const baseCard = baseByKey.get(nextCard.key);
    if (baseCard && snapshotsMatch(baseCard, nextCard)) continue;
    const index = cards.findIndex((card) => card.key === nextCard.key);
    const rebasedCard = baseCard
      ? rebaseCardChange({
          base: baseCard,
          next: nextCard,
          latest: index >= 0 ? cards[index] : undefined,
        })
      : nextCard;
    if (index >= 0) {
      cards = [
        ...cards.slice(0, index),
        rebasedCard,
        ...cards.slice(index + 1),
      ];
    } else {
      cards = [...cards, rebasedCard];
    }
  }
  const raised = raisedCardKey(params.base, params.next);
  if (raised) {
    const card = cards.find((entry) => entry.key === raised);
    if (card) cards = [...cards.filter((entry) => entry.key !== raised), card];
  }

  const views = { ...params.latest.views };
  for (const layout of WORKSPACE_LAYOUTS) {
    if (snapshotsMatch(params.base.views[layout], params.next.views[layout])) {
      continue;
    }
    const nextView = params.next.views[layout];
    if (nextView) views[layout] = nextView;
    else delete views[layout];
  }
  return {
    version: STAR_MAP_WORKSPACE_VERSION,
    cards,
    views,
  };
}

function isWorkspaceRevisionConflict(error: unknown): boolean {
  return String(error).includes("Star Map workspace revision conflict");
}

function entryFromSnapshot(
  card: StarMapWorkspaceSnapshot["cards"][number],
): StarMapChatCardEntry {
  return {
    key: card.key,
    ownerInstanceId: card.ownerInstanceId,
    threadKey: buildThreadIdentityKey(card.thread.source, card.thread.id),
    rect: card.geometry.fallbackRect,
    thread: card.thread,
    anchor: card.geometry.anchor,
    anchorDx: card.geometry.dx,
    anchorDy: card.geometry.dy,
    instanceDx: card.geometry.instanceDx,
    instanceDy: card.geometry.instanceDy,
    pendingAnchorRestore: true,
    contextOpen: card.contextOpen,
    terminalOpen: card.terminalOpen,
    terminalHeight: card.terminalHeight,
  };
}

/**
 * Owns the viewer-local Star Map desk. Live drag frames stay in React memory;
 * completed gestures and explicit open/close/toggle actions enqueue one full,
 * atomic workspace snapshot through the main-process profile database.
 */
export function useStarMapChatCards(params: {
  desktopApi?: DesktopApi;
}): StarMapChatCardsController {
  const [state, setState] = useState<StarMapChatCardsState>(EMPTY_STATE);
  const [hydrated, setHydrated] = useState(false);
  const stateRef = useRef(state);
  const mutatedBeforeHydrationRef = useRef(false);
  const revisionRef = useRef(0);
  const persistedWorkspaceRef = useRef(snapshotFor(EMPTY_STATE));
  const queuedWorkspaceRef = useRef(snapshotFor(EMPTY_STATE));
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writeFailedRef = useRef(false);
  const desktopApi = params.desktopApi;

  const enqueueWrite = useCallback(
    (next: StarMapChatCardsState) => {
      const writeWorkspace = desktopApi?.writeStarMapWorkspace;
      if (!writeWorkspace) return;
      const readWorkspace = desktopApi?.readStarMapWorkspace;
      const queuedBase = queuedWorkspaceRef.current;
      const snapshot = snapshotFor(next);
      queuedWorkspaceRef.current = snapshot;
      writeQueueRef.current = writeQueueRef.current.then(async () => {
        // If the prior boundary failed, `queuedBase` contains state that was
        // never durable. Reapply the complete local delta from the last
        // successful snapshot so a later gesture carries the failed change
        // forward instead of silently treating it as already saved.
        const base = writeFailedRef.current
          ? persistedWorkspaceRef.current
          : queuedBase;
        try {
          let rebased = rebaseWorkspaceChange({
            base,
            next: snapshot,
            latest: persistedWorkspaceRef.current,
          });
          for (;;) {
            try {
              const response = await writeWorkspace({
                baseRevision: revisionRef.current,
                workspace: rebased,
              });
              revisionRef.current = response.workspace.revision;
              persistedWorkspaceRef.current = {
                version: response.workspace.version,
                cards: response.workspace.cards,
                views: response.workspace.views,
              };
              writeFailedRef.current = false;
              return;
            } catch (error) {
              if (!readWorkspace || !isWorkspaceRevisionConflict(error)) {
                throw error;
              }
              const response = await readWorkspace();
              revisionRef.current = response.workspace.revision;
              persistedWorkspaceRef.current = {
                version: response.workspace.version,
                cards: response.workspace.cards,
                views: response.workspace.views,
              };
              rebased = rebaseWorkspaceChange({
                base,
                next: snapshot,
                latest: persistedWorkspaceRef.current,
              });
            }
          }
        } catch {
          writeFailedRef.current = true;
        }
      });
    },
    [desktopApi],
  );

  const applyState = useCallback(
    (next: StarMapChatCardsState, persist: boolean) => {
      stateRef.current = next;
      setState(next);
      if (!hydrated) mutatedBeforeHydrationRef.current = true;
      if (persist && hydrated) enqueueWrite(next);
    },
    [enqueueWrite, hydrated],
  );

  useEffect(() => {
    let cancelled = false;
    void desktopApi
      ?.readStarMapWorkspace?.()
      .then((response) => {
        if (cancelled) return;
        revisionRef.current = response.workspace.revision;
        const restored: StarMapChatCardsState = {
          cards: response.workspace.cards.map(entryFromSnapshot),
          views: response.workspace.views,
        };
        const restoredSnapshot = snapshotFor(restored);
        persistedWorkspaceRef.current = restoredSnapshot;
        queuedWorkspaceRef.current = restoredSnapshot;
        const current = stateRef.current;
        const next = mutatedBeforeHydrationRef.current
          ? {
              cards: [
                ...restored.cards.filter(
                  (card) => !current.cards.some((entry) => entry.key === card.key),
                ),
                ...current.cards,
              ],
              views: { ...restored.views, ...current.views },
            }
          : restored;
        stateRef.current = next;
        setState(next);
        setHydrated(true);
        if (mutatedBeforeHydrationRef.current) enqueueWrite(next);
        else queuedWorkspaceRef.current = snapshotFor(next);
      })
      .catch(() => {
        if (!cancelled) setHydrated(true);
      });
    if (!desktopApi?.readStarMapWorkspace) setHydrated(true);
    return () => {
      cancelled = true;
    };
  }, [desktopApi, enqueueWrite]);

  const raise = useCallback(
    (cardKey: string, persist = true): boolean => {
      const current = stateRef.current;
      const index = current.cards.findIndex((card) => card.key === cardKey);
      if (index === -1 || index === current.cards.length - 1) return false;
      const card = current.cards[index];
      applyState(
        {
          ...current,
          cards: [
            ...current.cards.slice(0, index),
            ...current.cards.slice(index + 1),
            card,
          ],
        },
        persist,
      );
      return true;
    },
    [applyState],
  );

  const remapOwner = useCallback(
    (placeholderInstanceId: string, durableInstanceId: string) => {
      if (placeholderInstanceId === durableInstanceId) return;
      const current = stateRef.current;
      if (
        !current.cards.some(
          (card) => card.ownerInstanceId === placeholderInstanceId,
        )
      ) {
        return;
      }
      const cards: StarMapChatCardEntry[] = [];
      for (const card of current.cards) {
        const remapped = card.ownerInstanceId === placeholderInstanceId
          ? {
              ...card,
              key: starMapWorkspaceCardKey({
                instanceId: durableInstanceId,
                threadKey: card.threadKey,
              }),
              ownerInstanceId: durableInstanceId,
              anchor:
                card.anchor.kind !== "canvas"
                && card.anchor.instanceId === placeholderInstanceId
                  ? { ...card.anchor, instanceId: durableInstanceId }
                  : card.anchor,
            }
          : card;
        const duplicate = cards.findIndex((entry) => entry.key === remapped.key);
        if (duplicate >= 0) cards.splice(duplicate, 1);
        cards.push(remapped);
      }
      applyState({ ...current, cards }, true);
    },
    [applyState],
  );

  const open = useCallback(
    (
      ownerInstanceId: string,
      thread: NavigationThreadSummary,
      placement?: {
        anchor: StarMapChatCardAnchorPlacement;
        bounds: { width: number; height: number };
        sourceRect: { x: number; y: number; width: number; height: number };
      },
      options?: { persist?: boolean },
    ) => {
      const persist = options?.persist ?? true;
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const key = starMapWorkspaceCardKey({
        instanceId: ownerInstanceId,
        threadKey,
      });
      const current = stateRef.current;
      const existingIndex = current.cards.findIndex((card) => card.key === key);
      if (existingIndex >= 0) {
        const existing = current.cards[existingIndex];
        applyState(
          {
            ...current,
            cards: [
              ...current.cards.slice(0, existingIndex),
              ...current.cards.slice(existingIndex + 1),
              {
                ...existing,
                thread: snapshotStarMapWorkspaceThread(thread),
              },
            ],
          },
          persist,
        );
        return;
      }
      const rect = placement
        ? placeChatCardBesideAnchor({
            anchor: placement.sourceRect,
            bounds: placement.bounds,
            occupied: current.cards.map((card) => card.rect),
          })
        : cascadeChatCardRect({
            openCardCount: current.cards.length,
            viewport: viewportSize(),
          });
      const anchor = placement?.anchor ?? {
        anchor: { kind: "canvas" } as const,
        point: { x: 0, y: 0 },
      };
      const instancePoint = instancePointForPlacement(anchor);
      applyState(
        {
          ...current,
          cards: [
            ...current.cards,
            {
              key,
              ownerInstanceId,
              threadKey,
              rect,
              thread: snapshotStarMapWorkspaceThread(thread),
              anchor: anchor.anchor,
              anchorDx: rect.left - anchor.point.x,
              anchorDy: rect.top - anchor.point.y,
              instanceDx: instancePoint
                ? rect.left - instancePoint.x
                : undefined,
              instanceDy: instancePoint
                ? rect.top - instancePoint.y
                : undefined,
              pendingAnchorRestore: false,
              contextOpen: false,
              terminalOpen: false,
            },
          ],
        },
        persist,
      );
    },
    [applyState],
  );

  const close = useCallback(
    (cardKey: string) => {
      const current = stateRef.current;
      const cards = current.cards.filter((card) => card.key !== cardKey);
      if (cards.length === current.cards.length) return;
      applyState({ ...current, cards }, true);
    },
    [applyState],
  );

  const closeAll = useCallback(() => {
    const current = stateRef.current;
    if (current.cards.length === 0) return;
    applyState({ ...current, cards: [] }, true);
  }, [applyState]);

  const setRect = useCallback(
    (cardKey: string, rect: ChatCardRect) => {
      const current = stateRef.current;
      const cards = current.cards.map((card) =>
        card.key === cardKey ? { ...card, rect } : card,
      );
      applyState({ ...current, cards }, false);
    },
    [applyState],
  );

  const commitRect = useCallback(
    (
      cardKey: string,
      rect: ChatCardRect,
      anchor?: StarMapChatCardAnchorPlacement,
    ) => {
      const current = stateRef.current;
      const cards = current.cards.map((card) => {
        if (card.key !== cardKey) return card;
        const placement = anchor ?? {
          anchor: { kind: "canvas" } as const,
          point: { x: 0, y: 0 },
        };
        const instancePoint = instancePointForPlacement(placement);
        return {
          ...card,
          rect,
          anchor: placement.anchor,
          anchorDx: rect.left - placement.point.x,
          anchorDy: rect.top - placement.point.y,
          instanceDx: instancePoint
            ? rect.left - instancePoint.x
            : undefined,
          instanceDy: instancePoint
            ? rect.top - instancePoint.y
            : undefined,
          pendingAnchorRestore: false,
        };
      });
      applyState({ ...current, cards }, true);
    },
    [applyState],
  );

  const resolveRestoredAnchors = useCallback(
    (
      resolve: (
        anchor: StarMapWorkspaceAnchor,
      ) => StarMapChatCardAnchorResolution | undefined,
    ) => {
      const current = stateRef.current;
      if (!current.cards.some((card) => card.pendingAnchorRestore)) return;
      const cards = current.cards.map((card) => {
        if (!card.pendingAnchorRestore) return card;
        const resolution = resolve(card.anchor);
        const offset = resolution?.basis === "instance"
          && card.instanceDx !== undefined
          && card.instanceDy !== undefined
            ? { dx: card.instanceDx, dy: card.instanceDy }
            : resolution?.basis === "anchor"
              ? { dx: card.anchorDx, dy: card.anchorDy }
              : undefined;
        return {
          ...card,
          rect: resolution && offset
            ? {
                ...card.rect,
                left: resolution.point.x + offset.dx,
                top: resolution.point.y + offset.dy,
              }
            : card.rect,
          pendingAnchorRestore: false,
        };
      });
      applyState({ ...current, cards }, false);
    },
    [applyState],
  );

  const toggleFlag = useCallback(
    (cardKey: string, flag: "contextOpen" | "terminalOpen") => {
      const current = stateRef.current;
      const cards = current.cards.map((card) =>
        card.key === cardKey ? { ...card, [flag]: !card[flag] } : card,
      );
      applyState({ ...current, cards }, true);
    },
    [applyState],
  );

  const toggleContext = useCallback(
    (cardKey: string) => toggleFlag(cardKey, "contextOpen"),
    [toggleFlag],
  );
  const toggleTerminal = useCallback(
    (cardKey: string) => toggleFlag(cardKey, "terminalOpen"),
    [toggleFlag],
  );

  const updateTerminalHeight = useCallback(
    (cardKey: string, height: number, persist: boolean) => {
      const current = stateRef.current;
      const cards = current.cards.map((card) =>
        card.key === cardKey ? { ...card, terminalHeight: height } : card,
      );
      applyState({ ...current, cards }, persist);
    },
    [applyState],
  );

  const setTerminalHeight = useCallback(
    (cardKey: string, height: number) =>
      updateTerminalHeight(cardKey, height, false),
    [updateTerminalHeight],
  );
  const commitTerminalHeight = useCallback(
    (cardKey: string, height: number) =>
      updateTerminalHeight(cardKey, height, true),
    [updateTerminalHeight],
  );

  const viewFor = useCallback(
    (layout: StarMapWorkspaceLayout) => state.views[layout],
    [state.views],
  );

  const commitView = useCallback(
    (layout: StarMapWorkspaceLayout, view: StarMapWorkspaceView) => {
      const current = stateRef.current;
      applyState(
        { ...current, views: { ...current.views, [layout]: view } },
        true,
      );
    },
    [applyState],
  );

  const resetView = useCallback(
    (layout: StarMapWorkspaceLayout) => {
      const current = stateRef.current;
      if (!current.views[layout]) return;
      const views = { ...current.views };
      delete views[layout];
      applyState({ ...current, views }, true);
    },
    [applyState],
  );

  const depthOf = useCallback(
    (cardKey: string) => {
      const index = state.cards.findIndex((card) => card.key === cardKey);
      return index === -1 ? 0 : index;
    },
    [state.cards],
  );

  return useMemo(
    () => ({
      cards: state.cards,
      hydrated,
      close,
      closeAll,
      commitRect,
      commitTerminalHeight,
      commitView,
      depthOf,
      open,
      raise,
      remapOwner,
      resetView,
      resolveRestoredAnchors,
      setRect,
      setTerminalHeight,
      toggleContext,
      toggleTerminal,
      viewFor,
    }),
    [
      close,
      closeAll,
      commitRect,
      commitTerminalHeight,
      commitView,
      depthOf,
      hydrated,
      open,
      raise,
      remapOwner,
      resetView,
      resolveRestoredAnchors,
      setRect,
      setTerminalHeight,
      state.cards,
      toggleContext,
      toggleTerminal,
      viewFor,
    ],
  );
}
