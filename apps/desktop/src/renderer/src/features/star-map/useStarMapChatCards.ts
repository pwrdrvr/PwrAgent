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
    ) => { x: number; y: number } | undefined,
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

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function snapshotFor(state: StarMapChatCardsState): StarMapWorkspaceSnapshot {
  return {
    version: STAR_MAP_WORKSPACE_VERSION,
    cards: state.cards.map((card) => ({
      key: card.key,
      ownerInstanceId: card.ownerInstanceId,
      thread: card.thread,
      geometry: {
        anchor: card.anchor,
        dx: card.anchorDx,
        dy: card.anchorDy,
        fallbackRect: card.rect,
      },
      contextOpen: card.contextOpen,
      terminalOpen: card.terminalOpen,
      terminalHeight: card.terminalHeight,
    })),
    views: state.views,
  };
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
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const desktopApi = params.desktopApi;

  const enqueueWrite = useCallback(
    (next: StarMapChatCardsState) => {
      if (!desktopApi?.writeStarMapWorkspace) return;
      const snapshot = snapshotFor(next);
      writeQueueRef.current = writeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const response = await desktopApi.writeStarMapWorkspace?.({
            baseRevision: revisionRef.current,
            workspace: snapshot,
          });
          if (response) revisionRef.current = response.workspace.revision;
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
        return {
          ...card,
          rect,
          anchor: placement.anchor,
          anchorDx: rect.left - placement.point.x,
          anchorDy: rect.top - placement.point.y,
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
      ) => { x: number; y: number } | undefined,
    ) => {
      const current = stateRef.current;
      if (!current.cards.some((card) => card.pendingAnchorRestore)) return;
      const cards = current.cards.map((card) => {
        if (!card.pendingAnchorRestore) return card;
        const point = resolve(card.anchor);
        return {
          ...card,
          rect: point
            ? {
                ...card.rect,
                left: point.x + card.anchorDx,
                top: point.y + card.anchorDy,
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
