import { useCallback, useState } from "react";
import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import {
  cascadeChatCardRect,
  raiseChatCard,
  type ChatCardRect,
} from "./star-map-chat-card-geometry";

export type StarMapChatCardEntry = {
  key: string;
  rect: ChatCardRect;
  thread: NavigationThreadSummary;
};

export type StarMapChatCardsController = {
  cards: StarMapChatCardEntry[];
  close: (cardKey: string) => void;
  closeAll: () => void;
  /** Stack depth of a card, lowest first. */
  depthOf: (cardKey: string) => number;
  open: (thread: NavigationThreadSummary) => void;
  raise: (cardKey: string) => void;
  setRect: (cardKey: string, rect: ChatCardRect) => void;
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
    (thread: NavigationThreadSummary) => {
      const key = buildThreadIdentityKey(thread.source, thread.id);
      setCards((current) => {
        if (current.some((card) => card.key === key)) return current;
        return [
          ...current,
          {
            key,
            rect: cascadeChatCardRect({
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

  const depthOf = useCallback(
    (cardKey: string) => {
      const index = order.indexOf(cardKey);
      return index === -1 ? 0 : index;
    },
    [order],
  );

  return { cards, close, closeAll, depthOf, open, raise, setRect };
}
