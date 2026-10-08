import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DismissOperatorQuestionRequest } from "@pwragent/shared";
import { operatorQuestionItemKey } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { buildOperatorWaits, type OperatorWait } from "./operator-waits";

export type OperatorRequestsController = {
  /** Every local thread's waits, most urgent first. */
  waits: OperatorWait[];
  /** Waits per `backend:threadId`, most urgent first. */
  waitsByThreadKey: ReadonlyMap<string, OperatorWait[]>;
  /** Item keys the operator has had on screen, to-dos included. */
  seenKeys: ReadonlySet<string>;
  /** Records items as seen. Calls in one tick go out as one write. */
  markSeen: (keys: readonly string[]) => void;
  dismissQuestion: (target: OperatorQuestionTarget) => Promise<void>;
  /** Question item keys dismissed from this window. */
  dismissedQuestionKeys: ReadonlySet<string>;
};

export type OperatorQuestionTarget = Pick<
  DismissOperatorQuestionRequest,
  "backend" | "threadId" | "messageId"
>;

type OperatorRequestsApi = Pick<
  DesktopApi,
  | "listOperatorRequests"
  | "markOperatorItemsSeen"
  | "dismissOperatorQuestion"
  | "onOperatorRequestsChanged"
>;

const EMPTY_WAITS: OperatorWait[] = [];
const EMPTY_MAP: ReadonlyMap<string, OperatorWait[]> = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * What every local thread is waiting on the operator for, and what the
 * operator has seen. Requests are answered on the instance that owns the
 * thread, so a window fronting a peer has none.
 *
 * The change event is a marker: each one triggers one list call, and events
 * that arrive while a list is in flight collapse into one follow-up.
 */
export function useOperatorRequests(
  desktopApi: OperatorRequestsApi | undefined,
): OperatorRequestsController {
  const remoteWindow = readRendererFederationTarget() !== undefined;
  const api = remoteWindow ? undefined : desktopApi;
  const [waits, setWaits] = useState<OperatorWait[]>(EMPTY_WAITS);
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(EMPTY_SET);
  const loadingRef = useRef(false);
  const reloadQueuedRef = useRef(false);
  const pendingSeenRef = useRef(new Set<string>());
  // What is stored, read by markSeen so a mark already stored costs no write.
  const storedSeenRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  const flushScheduledRef = useRef(false);

  const reload = useCallback(async (): Promise<void> => {
    const list = api?.listOperatorRequests;
    if (!list) return;
    if (loadingRef.current) {
      reloadQueuedRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      do {
        reloadQueuedRef.current = false;
        try {
          const response = await list();
          const next = buildOperatorWaits(response);
          // A reload that changed no wait keeps the same array, so the
          // sidebar's rows, which read it through context, do not re-render.
          setWaits((current) => sameWaits(current, next)
            ? current
            : next.length > 0 ? next : EMPTY_WAITS);
          storedSeenRef.current = new Set(response.seenKeys);
          // A mark sent but not yet stored stays seen here.
          const seen = new Set([...response.seenKeys, ...pendingSeenRef.current]);
          setSeenKeys((current) =>
            current.size === seen.size && [...seen].every((key) => current.has(key))
              ? current
              : seen);
        } catch (error) {
          console.warn("Loading operator requests failed.", error);
        }
      } while (reloadQueuedRef.current);
    } finally {
      loadingRef.current = false;
    }
  }, [api]);

  useEffect(() => {
    void reload();
    const unsubscribe = api?.onOperatorRequestsChanged?.(() => {
      void reload();
    });
    return () => unsubscribe?.();
  }, [api, reload]);

  const markSeen = useCallback((keys: readonly string[]): void => {
    const send = api?.markOperatorItemsSeen;
    if (!send) return;
    const fresh = keys.filter((key) =>
      !pendingSeenRef.current.has(key) && !storedSeenRef.current.has(key));
    if (fresh.length === 0) return;
    for (const key of fresh) pendingSeenRef.current.add(key);
    setSeenKeys((current) => {
      if (fresh.every((key) => current.has(key))) return current;
      const next = new Set(current);
      for (const key of fresh) next.add(key);
      return next;
    });
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    // One write per tick, however many surfaces marked items in it.
    queueMicrotask(() => {
      flushScheduledRef.current = false;
      const batch = [...pendingSeenRef.current];
      void send({ keys: batch }).then(() => {
        storedSeenRef.current = new Set([...storedSeenRef.current, ...batch]);
      }, (error: unknown) => {
        console.warn("Recording seen operator items failed.", error);
      }).finally(() => {
        for (const key of batch) pendingSeenRef.current.delete(key);
      });
    });
  }, [api]);

  const [dismissedQuestionKeys, setDismissedQuestionKeys] =
    useState<ReadonlySet<string>>(EMPTY_SET);
  const dismissQuestion = useCallback(async (target: OperatorQuestionTarget): Promise<void> => {
    if (!api?.dismissOperatorQuestion) return;
    const key = operatorQuestionItemKey(target.backend, target.threadId, target.messageId);
    setDismissedQuestionKeys((current) =>
      current.has(key) ? current : new Set([...current, key]));
    try {
      await api.dismissOperatorQuestion({
        backend: target.backend,
        threadId: target.threadId,
        messageId: target.messageId,
      });
    } catch (error) {
      // The question is still open, so its transcript card must not fold.
      setDismissedQuestionKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      throw error;
    }
  }, [api]);

  const waitsByThreadKey = useMemo(() => {
    if (waits.length === 0) return EMPTY_MAP;
    const map = new Map<string, OperatorWait[]>();
    for (const wait of waits) {
      const list = map.get(wait.threadKey);
      if (list) list.push(wait);
      else map.set(wait.threadKey, [wait]);
    }
    return map;
  }, [waits]);

  return useMemo(
    () => ({
      waits,
      waitsByThreadKey,
      seenKeys,
      markSeen,
      dismissQuestion,
      dismissedQuestionKeys,
    }),
    [waits, waitsByThreadKey, seenKeys, markSeen, dismissQuestion, dismissedQuestionKeys],
  );
}

/** Same waits, in the same order. A key names one immutable request or question. */
function sameWaits(left: readonly OperatorWait[], right: readonly OperatorWait[]): boolean {
  return left.length === right.length
    && left.every((wait, index) => wait.key === right[index]!.key);
}

export type OperatorWaitsContextValue = {
  waitsByThreadKey: ReadonlyMap<string, OperatorWait[]>;
  seenKeys: ReadonlySet<string>;
};

/**
 * Waits per thread for the sidebar's chips, through context for the same
 * reason as the to-do counts: the chip sits several list components below
 * App. `undefined` means this window has no list (a peer's window), and the
 * row falls back to the session's own approval and input flags.
 */
export const OperatorWaitsContext = createContext<OperatorWaitsContextValue | undefined>(
  undefined,
);

export function useOperatorWaitsContext(): OperatorWaitsContextValue | undefined {
  return useContext(OperatorWaitsContext);
}
