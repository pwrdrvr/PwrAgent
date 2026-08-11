import { useCallback, useState } from "react";
import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import {
  cascadeChatCardRect,
  placeChatCardBesideAnchor,
  raiseChatCard,
  type ChatCardRect,
} from "./star-map-chat-card-geometry";

export type StarMapChatCardEntry = {
  key: string;
  rect: ChatCardRect;
  thread: NavigationThreadSummary;
  /** The context satellite card is open, docked to the right. */
  contextOpen?: boolean;
  /** The terminal satellite card is open, docked below. */
  terminalOpen?: boolean;
  /** Operator-resized terminal height; the dock geometry supplies a default. */
  terminalHeight?: number;
};

export type StarMapChatCardsController = {
  cards: StarMapChatCardEntry[];
  close: (cardKey: string) => void;
  closeAll: () => void;
  /** Stack depth of a card, lowest first. */
  depthOf: (cardKey: string) => number;
  /**
   * Open a card for a thread. `placement` puts it beside the thread's own
   * card on the map; without one the card cascades from a corner, which
   * is the fallback when the thread has no card on screen (filtered out,
   * or folded into a cloud's overflow).
   */
  open: (
    thread: NavigationThreadSummary,
    placement?: {
      anchor: { x: number; y: number; width: number; height: number };
      bounds: { width: number; height: number };
    },
  ) => void;
  raise: (cardKey: string) => void;
  setRect: (cardKey: string, rect: ChatCardRect) => void;
  /** Open/close the satellites. They live on the entry, so closing the
   * chat card closes its whole group for free. */
  toggleContext: (cardKey: string) => void;
  toggleTerminal: (cardKey: string) => void;
  setTerminalHeight: (cardKey: string, height: number) => void;
};

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Owns the set of floating chat cards over the star map.
 *
 * Cards are keyed by thread identity, so clicking the same thread twice
 * raises the existing card instead of stacking a duplicate on top of it.
 * Geometry lives here rather than in each card so that the cascade can see
 * how many cards are already open.
 */
export function useStarMapChatCards(): StarMapChatCardsController {
  const [cards, setCards] = useState<StarMapChatCardEntry[]>([]);
  const [order, setOrder] = useState<readonly string[]>([]);

  const raise = useCallback((cardKey: string) => {
    setOrder((current) => raiseChatCard(current, cardKey));
  }, []);

  const open = useCallback(
    (
      thread: NavigationThreadSummary,
      placement?: {
        anchor: { x: number; y: number; width: number; height: number };
        bounds: { width: number; height: number };
      },
    ) => {
      const key = buildThreadIdentityKey(thread.source, thread.id);
      setCards((current) => {
        if (current.some((card) => card.key === key)) return current;
        return [
          ...current,
          {
            key,
            rect: placement
              ? placeChatCardBesideAnchor({
                  anchor: placement.anchor,
                  bounds: placement.bounds,
                  occupied: current.map((card) => card.rect),
                })
              : cascadeChatCardRect({
                  openCardCount: current.length,
                  viewport: viewportSize(),
                }),
            thread,
          },
        ];
      });
      raise(key);
    },
    [raise],
  );

  const close = useCallback((cardKey: string) => {
    setCards((current) => current.filter((card) => card.key !== cardKey));
    setOrder((current) => current.filter((entry) => entry !== cardKey));
  }, []);

  const closeAll = useCallback(() => {
    setCards([]);
    setOrder([]);
  }, []);

  const setRect = useCallback((cardKey: string, rect: ChatCardRect) => {
    setCards((current) =>
      current.map((card) => (card.key === cardKey ? { ...card, rect } : card)),
    );
  }, []);

  const toggleContext = useCallback((cardKey: string) => {
    setCards((current) =>
      current.map((card) =>
        card.key === cardKey
          ? { ...card, contextOpen: !card.contextOpen }
          : card,
      ),
    );
  }, []);

  const toggleTerminal = useCallback((cardKey: string) => {
    setCards((current) =>
      current.map((card) =>
        card.key === cardKey
          ? { ...card, terminalOpen: !card.terminalOpen }
          : card,
      ),
    );
  }, []);

  const setTerminalHeight = useCallback(
    (cardKey: string, height: number) => {
      setCards((current) =>
        current.map((card) =>
          card.key === cardKey ? { ...card, terminalHeight: height } : card,
        ),
      );
    },
    [],
  );

  const depthOf = useCallback(
    (cardKey: string) => {
      const index = order.indexOf(cardKey);
      return index === -1 ? 0 : index;
    },
    [order],
  );

  return {
    cards,
    close,
    closeAll,
    depthOf,
    open,
    raise,
    setRect,
    setTerminalHeight,
    toggleContext,
    toggleTerminal,
  };
}
