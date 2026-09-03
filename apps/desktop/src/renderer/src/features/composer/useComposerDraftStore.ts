import { useMemo, useRef } from "react";
import type { JSONContent } from "@tiptap/react";
import type {
  AppServerBackendKind,
  AppServerReviewTarget,
  AppServerTurnInputItem,
  ComposerDraftLifecycle,
  ComposerDraftRecoveryCandidate,
  ListComposerDraftRecoveryCandidatesRequest,
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
  ModelSettingsRecent,
  ReviewRunMode,
  ThreadIdentifier,
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
  /** Submission is in flight to the main-process FIFO. */
  backendQueuePending?: boolean;
  /** Main-process FIFO entry once the renderer has handed off dispatch ownership. */
  queueEntryId?: string;
  /** Owner-clock creation time used to reject older navigation snapshots. */
  queueEntryCreatedAt?: number;
  /** Durable main-process scheduled action represented by this renderer chip. */
  scheduledActionId?: string;
  /** Terminal scheduled action converted into a locally recoverable draft. */
  failedScheduledActionId?: string;
  errorMessage?: string;
  input?: AppServerTurnInputItem[];
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  fileAttachments: NavigationLaunchpadFileAttachment[];
  scheduledSendAt?: number;
  reviewCommand?: {
    cwd?: string;
    displayText: string;
    runMode?: ReviewRunMode;
    target: AppServerReviewTarget;
    /**
     * Reviewer picked when the review was queued. Carried here because a
     * scheduled review is projected back into a queued turn and can be
     * released client-side; without it that release would silently fall back
     * to the thread's own provider.
     */
    reviewer?: ModelSettingsRecent;
  };
};

export type ComposerPendingSteerSnapshot = {
  id: string;
  clearComposerDraftOnAdmission?: boolean;
  expectedTurnId: string;
  input?: AppServerTurnInputItem[];
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  fileAttachments: NavigationLaunchpadFileAttachment[];
};

let queuedTurnIdSequence = 0;

/**
 * Reserves one renderer-owned identity for a main-process FIFO submission.
 * Every composer surface must mint through the same primitive so the pending
 * projection it shows is the entry the backend later acknowledges.
 */
export function createQueuedTurnId(): string {
  queuedTurnIdSequence += 1;
  return `queued-turn-${Date.now().toString(36)}-${queuedTurnIdSequence.toString(36)}`;
}

/**
 * The one definition of a thread composer's draft scope key. Everything that
 * reads or writes the store — the composer, the queued-turn release loop, the
 * sidebar's draft and queued indicators — has to agree on this string, and
 * before this existed four hand-rolled copies of the template literal did.
 */
export function buildThreadComposerScopeKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
): string {
  return `thread:${backend}:${threadId}`;
}

/**
 * Whether a snapshot holds anything an operator would be sorry to lose. The
 * same test the durable store uses to decide a draft is worth journalling, so
 * "this thread has an unsent draft" and "this draft is recoverable" can never
 * disagree. Whitespace-only text is not content: the composer leaves a
 * trailing newline behind constantly and a chip that lit up for it would be
 * noise.
 */
export function hasComposerDraftContent(
  snapshot: ComposerDraftSnapshot | undefined,
): boolean {
  if (!snapshot) {
    return false;
  }
  return (
    snapshot.draft.trim().length > 0
    || snapshot.imageAttachments.length > 0
    || (snapshot.fileAttachments?.length ?? 0) > 0
    || snapshot.skillTokens.length > 0
  );
}

export type ComposerDraftStore = {
  delete(scopeKey: string): void;
  get(scopeKey: string): ComposerDraftSnapshot | undefined;
  /**
   * Whether this scope currently holds unsent content — its active draft or
   * anything parked beneath it. Pairs with `subscribeDraftPresence` so
   * surfaces outside the composer can mark a thread as having a draft.
   */
  hasDraftContent(scopeKey: string): boolean;
  /**
   * Monotonic counter bumped when a scope *gains or loses* draft content.
   * Deliberately not bumped on every edit: the sidebar only cares whether a
   * draft exists, and a per-keystroke notification would re-render every
   * thread row for the whole time an operator is typing.
   */
  getDraftPresenceVersion(): number;
  subscribeDraftPresence(listener: () => void): () => void;
  /** Remove and return the most recently parked draft beneath this scope. */
  popDraft(scopeKey: string): ComposerDraftSnapshot | undefined;
  /** Park a draft beneath this scope's active draft. */
  pushDraft(scopeKey: string, snapshot: ComposerDraftSnapshot): void;
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
  T extends Pick<
    ComposerQueuedTurnSnapshot,
    | "backendQueuePending"
    | "queueEntryId"
    | "scheduledActionId"
    | "scheduledSendAt"
  >,
>(queuedTurns: readonly T[], now = Date.now()): T | undefined {
  for (const queuedTurn of queuedTurns) {
    // A backend-owned entry is already in the authoritative FIFO. Local
    // scheduled turns and reviews behind it must not leapfrog that entry.
    if (
      queuedTurn.backendQueuePending
      || queuedTurn.queueEntryId
      || queuedTurn.scheduledActionId
    ) {
      return undefined;
    }
    if (getQueuedTurnReleaseDelayMs(queuedTurn, now) === 0) {
      return queuedTurn;
    }
  }
  return undefined;
}

export function useComposerDraftStore(): ComposerDraftStore {
  const storeRef = useRef(new Map<string, ComposerDraftSnapshot>());
  const draftStackStoreRef = useRef(new Map<string, ComposerDraftSnapshot[]>());
  const pendingSteerStoreRef = useRef(new Map<string, ComposerPendingSteerSnapshot>());
  const queuedTurnStoreRef = useRef(new Map<string, ComposerQueuedTurnSnapshot[]>());
  // Reactivity bridge for the queued-turn Map. The Map itself is a ref
  // (no React state) so composer writes stay cheap, but subscribers like
  // the sidebar need to know when it changes. Every mutation path below
  // funnels through `notifyQueuedTurnChange`, which bumps the version and
  // fans out to listeners registered via `subscribeQueuedTurns`.
  const queuedTurnVersionRef = useRef(0);
  const queuedTurnListenersRef = useRef(new Set<() => void>());
  // Same reactivity bridge, one level coarser: presence, not content. The
  // set holds every scope key that currently has unsent content, and the
  // version only moves when membership does.
  const draftPresenceRef = useRef(new Set<string>());
  const draftPresenceVersionRef = useRef(0);
  const draftPresenceListenersRef = useRef(new Set<() => void>());

  return useMemo(() => {
    const notifyQueuedTurnChange = (): void => {
      queuedTurnVersionRef.current += 1;
      for (const listener of queuedTurnListenersRef.current) {
        listener();
      }
    };

    // Re-reads both the active draft and the parked stack for one scope and
    // notifies only on a transition. Every mutation path below calls it; the
    // early return is what keeps typing free of re-renders.
    const syncDraftPresence = (scopeKey: string): void => {
      const present =
        hasComposerDraftContent(storeRef.current.get(scopeKey))
        || (draftStackStoreRef.current.get(scopeKey) ?? []).some(
          hasComposerDraftContent,
        );
      if (present === draftPresenceRef.current.has(scopeKey)) {
        return;
      }
      if (present) {
        draftPresenceRef.current.add(scopeKey);
      } else {
        draftPresenceRef.current.delete(scopeKey);
      }
      draftPresenceVersionRef.current += 1;
      for (const listener of draftPresenceListenersRef.current) {
        listener();
      }
    };

    return {
      delete: (scopeKey) => {
        storeRef.current.delete(scopeKey);
        syncDraftPresence(scopeKey);
      },
      get: (scopeKey) => storeRef.current.get(scopeKey),
      hasDraftContent: (scopeKey) => draftPresenceRef.current.has(scopeKey),
      getDraftPresenceVersion: () => draftPresenceVersionRef.current,
      subscribeDraftPresence: (listener) => {
        draftPresenceListenersRef.current.add(listener);
        return () => {
          draftPresenceListenersRef.current.delete(listener);
        };
      },
      // Presence is synced after the pop, so a scope whose only content was
      // the parked draft reads as absent until the composer `set`s the
      // returned snapshot back as the active one. Both happen inside the same
      // React event, so the two notifications batch into one render and the
      // chip does not visibly blink.
      popDraft: (scopeKey) => {
        const current = draftStackStoreRef.current.get(scopeKey) ?? [];
        const restored = current.at(-1);
        if (!restored) {
          return undefined;
        }
        const next = current.slice(0, -1);
        if (next.length === 0) {
          draftStackStoreRef.current.delete(scopeKey);
        } else {
          draftStackStoreRef.current.set(scopeKey, next);
        }
        syncDraftPresence(scopeKey);
        return restored;
      },
      pushDraft: (scopeKey, snapshot) => {
        const current = draftStackStoreRef.current.get(scopeKey) ?? [];
        draftStackStoreRef.current.set(scopeKey, [...current, snapshot]);
        syncDraftPresence(scopeKey);
      },
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
        syncDraftPresence(scopeKey);
      },
    };
  }, []);
}
