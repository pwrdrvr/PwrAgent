import { useMemo, useRef } from "react";
import type { JSONContent } from "@tiptap/react";
import type {
  AppServerReviewTarget,
  AppServerTurnInputItem,
  ComposerDraftLifecycle,
  ComposerDraftRecoveryCandidate,
  ListComposerDraftRecoveryCandidatesRequest,
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
} from "@pwragent/shared";
import type { ComposerSkillToken } from "./ComposerInputTypes";

export type ComposerDraftSnapshot = {
  draft: string;
  editorDocument?: JSONContent;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  /** Path-only file references from drag-and-drop / the file picker. */
  fileAttachments?: NavigationLaunchpadFileAttachment[];
  skillTokens: ComposerSkillToken[];
};

export type ComposerQueuedTurnSnapshot = {
  id: string;
  input?: AppServerTurnInputItem[];
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  fileAttachments: NavigationLaunchpadFileAttachment[];
  scheduledSendAt?: number;
  reviewCommand?: {
    cwd?: string;
    displayText: string;
    target: AppServerReviewTarget;
  };
};

export type ComposerPendingSteerSnapshot = {
  id: string;
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  fileAttachments: NavigationLaunchpadFileAttachment[];
};

export type ComposerDraftStore = {
  delete(scopeKey: string): void;
  get(scopeKey: string): ComposerDraftSnapshot | undefined;
  hydrationVersion?: number;
  deletePendingSteer(scopeKey: string): void;
  deleteQueuedTurn(scopeKey: string): void;
  getPendingSteer(scopeKey: string): ComposerPendingSteerSnapshot | undefined;
  getQueuedTurn(scopeKey: string): ComposerQueuedTurnSnapshot | undefined;
  getQueuedTurns(scopeKey: string): ComposerQueuedTurnSnapshot[];
  /**
   * Monotonic counter bumped whenever the queued-turn map mutates. Pairs
   * with `subscribeQueuedTurns` for `useSyncExternalStore` so surfaces
   * outside the composer (e.g. the sidebar thread rows) can reactively
   * reflect queued/scheduled state that otherwise lives only in a ref Map.
   */
  getQueuedTurnVersion(): number;
  subscribeQueuedTurns(listener: () => void): () => void;
  removeQueuedTurnAt(scopeKey: string, index: number): ComposerQueuedTurnSnapshot | undefined;
  removeQueuedTurnById(scopeKey: string, id: string): ComposerQueuedTurnSnapshot | undefined;
  shiftQueuedTurn(scopeKey: string): ComposerQueuedTurnSnapshot | undefined;
  listRecoveryCandidates?(
    request: ListComposerDraftRecoveryCandidatesRequest,
  ): Promise<ComposerDraftRecoveryCandidate[]>;
  recordHistory?(
    scopeKey: string,
    snapshot: ComposerDraftSnapshot,
    status: ComposerDraftLifecycle,
  ): void;
  setPendingSteer(scopeKey: string, snapshot: ComposerPendingSteerSnapshot): void;
  setQueuedTurn(scopeKey: string, snapshot: ComposerQueuedTurnSnapshot): void;
  setQueuedTurns(scopeKey: string, snapshots: ComposerQueuedTurnSnapshot[]): void;
  set(scopeKey: string, snapshot: ComposerDraftSnapshot): void;
};

export function getQueuedTurnReleaseDelayMs(
  queuedTurn: Pick<ComposerQueuedTurnSnapshot, "scheduledSendAt">,
  now = Date.now(),
): number {
  const scheduledSendAt = queuedTurn.scheduledSendAt;
  if (typeof scheduledSendAt !== "number" || !Number.isFinite(scheduledSendAt)) {
    return 0;
  }
  return Math.max(0, scheduledSendAt - now);
}

export function getNextReleasableQueuedTurn<
  T extends Pick<ComposerQueuedTurnSnapshot, "scheduledSendAt">,
>(queuedTurns: readonly T[], now = Date.now()): T | undefined {
  return queuedTurns.find((queuedTurn) =>
    getQueuedTurnReleaseDelayMs(queuedTurn, now) === 0
  );
}

export function useComposerDraftStore(): ComposerDraftStore {
  const storeRef = useRef(new Map<string, ComposerDraftSnapshot>());
  const pendingSteerStoreRef = useRef(new Map<string, ComposerPendingSteerSnapshot>());
  const queuedTurnStoreRef = useRef(new Map<string, ComposerQueuedTurnSnapshot[]>());
  // Reactivity bridge for the queued-turn Map. The Map itself is a ref
  // (no React state) so composer writes stay cheap, but subscribers like
  // the sidebar need to know when it changes. Every mutation path below
  // funnels through `notifyQueuedTurnChange`, which bumps the version and
  // fans out to listeners registered via `subscribeQueuedTurns`.
  const queuedTurnVersionRef = useRef(0);
  const queuedTurnListenersRef = useRef(new Set<() => void>());

  return useMemo(() => {
    const notifyQueuedTurnChange = (): void => {
      queuedTurnVersionRef.current += 1;
      for (const listener of queuedTurnListenersRef.current) {
        listener();
      }
    };

    return {
      delete: (scopeKey) => {
        storeRef.current.delete(scopeKey);
      },
      get: (scopeKey) => storeRef.current.get(scopeKey),
      deletePendingSteer: (scopeKey) => {
        pendingSteerStoreRef.current.delete(scopeKey);
      },
      deleteQueuedTurn: (scopeKey) => {
        if (queuedTurnStoreRef.current.delete(scopeKey)) {
          notifyQueuedTurnChange();
        }
      },
      getPendingSteer: (scopeKey) => pendingSteerStoreRef.current.get(scopeKey),
      getQueuedTurn: (scopeKey) => queuedTurnStoreRef.current.get(scopeKey)?.[0],
      getQueuedTurns: (scopeKey) => queuedTurnStoreRef.current.get(scopeKey) ?? [],
      getQueuedTurnVersion: () => queuedTurnVersionRef.current,
      subscribeQueuedTurns: (listener) => {
        queuedTurnListenersRef.current.add(listener);
        return () => {
          queuedTurnListenersRef.current.delete(listener);
        };
      },
      removeQueuedTurnAt: (scopeKey, index) => {
        const current = queuedTurnStoreRef.current.get(scopeKey) ?? [];
        if (index < 0 || index >= current.length) {
          return undefined;
        }
        const next = [...current];
        const [removed] = next.splice(index, 1);
        if (next.length === 0) {
          queuedTurnStoreRef.current.delete(scopeKey);
        } else {
          queuedTurnStoreRef.current.set(scopeKey, next);
        }
        notifyQueuedTurnChange();
        return removed;
      },
      removeQueuedTurnById: (scopeKey, id) => {
        const current = queuedTurnStoreRef.current.get(scopeKey) ?? [];
        const index = current.findIndex((entry) => entry.id === id);
        if (index === -1) {
          return undefined;
        }
        const next = [...current];
        const [removed] = next.splice(index, 1);
        if (next.length === 0) {
          queuedTurnStoreRef.current.delete(scopeKey);
        } else {
          queuedTurnStoreRef.current.set(scopeKey, next);
        }
        notifyQueuedTurnChange();
        return removed;
      },
      shiftQueuedTurn: (scopeKey) => {
        const current = queuedTurnStoreRef.current.get(scopeKey) ?? [];
        const [first, ...rest] = current;
        if (!first) {
          return undefined;
        }
        if (rest.length === 0) {
          queuedTurnStoreRef.current.delete(scopeKey);
        } else {
          queuedTurnStoreRef.current.set(scopeKey, rest);
        }
        notifyQueuedTurnChange();
        return first;
      },
      setPendingSteer: (scopeKey, snapshot) => {
        pendingSteerStoreRef.current.set(scopeKey, snapshot);
      },
      setQueuedTurn: (scopeKey, snapshot) => {
        queuedTurnStoreRef.current.set(scopeKey, [snapshot]);
        notifyQueuedTurnChange();
      },
      setQueuedTurns: (scopeKey, snapshots) => {
        if (snapshots.length === 0) {
          queuedTurnStoreRef.current.delete(scopeKey);
        } else {
          queuedTurnStoreRef.current.set(scopeKey, [...snapshots]);
        }
        notifyQueuedTurnChange();
      },
      set: (scopeKey, snapshot) => {
        storeRef.current.set(scopeKey, snapshot);
      },
    };
  }, []);
}
