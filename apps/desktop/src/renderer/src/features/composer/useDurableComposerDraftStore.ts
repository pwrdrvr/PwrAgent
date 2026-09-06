import { parseOwnedComposerScopeKey } from "@pwragent/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { JSONContent } from "@tiptap/react";
import type {
  AppServerBackendKind,
  ComposerDraftJsonValue,
  ComposerDraftLifecycle,
  ComposerDraftRecoveryCandidate,
  ComposerDraftScopeKind,
  ComposerDraftSnapshotRecord,
  ListComposerDraftRecoveryCandidatesRequest,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type {
  ComposerDraftSnapshot,
  ComposerDraftHydrationStatus,
  ComposerDraftStore,
} from "./useComposerDraftStore";

/**
 * How often an edited draft is written to sqlite, at most.
 *
 * This is an INTERVAL, not a debounce: the first edit after a quiet period
 * schedules a write this far out, and every edit inside that window is
 * coalesced into it. A trailing debounce would be wrong in the other
 * direction — someone typing continuously would never reach the quiet gap and
 * nothing would be persisted at all until they stopped.
 *
 * It was 200ms, which meant roughly five sqlite commits per second of typing
 * (~18,000/hour) for a feature whose purpose is shell-style draft RECOVERY —
 * getting back a message you walked away from. Recovery does not need
 * per-keystroke granularity; losing the last few seconds of typing on a hard
 * crash is not what this exists to prevent.
 */
const DURABLE_SAVE_INTERVAL_MS = 5_000;
const HISTORY_TEXT_THRESHOLD = 120;

type SaveComposerDraft = NonNullable<DesktopApi["saveComposerDraft"]>;

type PendingDraftSave = {
  saveComposerDraft: SaveComposerDraft;
  snapshot: ComposerDraftSnapshot;
  timer: number;
};

type LocalRecoveryCandidate = ComposerDraftRecoveryCandidate & {
  localSequence: number;
};

export function useDurableComposerDraftStore(
  baseStore: ComposerDraftStore,
  desktopApi?: DesktopApi,
): ComposerDraftStore {
  const pendingSavesRef = useRef(new Map<string, PendingDraftSave>());
  const createdAtRef = useRef(new Map<string, number>());
  // Content hash of what is actually in sqlite for each scope. Guards the
  // "edited" half of the rule: opening a thread and leaving, or any other
  // re-save of identical content, must not cost a write.
  const persistedHashRef = useRef(new Map<string, string>());
  const localRecoveryCandidatesRef = useRef<LocalRecoveryCandidate[]>([]);
  const localRecoverySequenceRef = useRef(0);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [hydration, setHydration] = useState<{
    baseStore: ComposerDraftStore;
    desktopApi: DesktopApi;
    status: ComposerDraftHydrationStatus;
  }>();
  // A replaced IPC/store cannot render one frame of the previous source's
  // readiness while the new hydration effect is waiting to run.
  const hydrationStatus: ComposerDraftHydrationStatus = !desktopApi?.listComposerDraftLatest
    ? "memory-only"
    : hydration?.baseStore === baseStore && hydration.desktopApi === desktopApi
      ? hydration.status : "loading";

  const rememberLocalRecoveryCandidate = useCallback(
    (record: ComposerDraftSnapshotRecord): void => {
      const nextCandidate = {
        ...record,
        localSequence: localRecoverySequenceRef.current,
      };
      localRecoverySequenceRef.current += 1;
      const [previousCandidate] = localRecoveryCandidatesRef.current;
      if (shouldReplacePreviousUnsentCandidate(previousCandidate, nextCandidate)) {
        localRecoveryCandidatesRef.current = [
          nextCandidate,
          ...localRecoveryCandidatesRef.current.slice(1),
        ].slice(0, 80);
        return;
      }
      const dedupeKey = getRecoveryCandidateKey(nextCandidate);
      localRecoveryCandidatesRef.current = [
        nextCandidate,
        ...localRecoveryCandidatesRef.current.filter(
          (candidate) => getRecoveryCandidateKey(candidate) !== dedupeKey,
        ),
      ].slice(0, 80);
    },
    [],
  );

  const flushPendingSave = useCallback(
    (scopeKey: string, pending: PendingDraftSave): void => {
      window.clearTimeout(pending.timer);
      pendingSavesRef.current.delete(scopeKey);
      const record = buildDraftRecord(
        scopeKey,
        pending.snapshot,
        "unsent",
        createdAtRef,
      );
      persistedHashRef.current.set(scopeKey, record.contentHash);
      if (shouldRecordHistory(pending.snapshot, "unsent")) {
        rememberLocalRecoveryCandidate(record);
      }
      void pending
        .saveComposerDraft({
          draft: record,
          recordHistory: shouldRecordHistory(pending.snapshot, "unsent"),
        })
        .catch((error) => {
          console.warn("Failed to save composer draft", error);
        });
    },
    [rememberLocalRecoveryCandidate],
  );

  const persistDraftHistory = useCallback(
    (
      scopeKey: string,
      snapshot: ComposerDraftSnapshot,
      status: ComposerDraftLifecycle,
      force = false,
    ): void => {
      if (!desktopApi?.recordComposerDraftHistory) {
        return;
      }
      if (!force && !shouldRecordHistory(snapshot, status)) {
        return;
      }
      const record = buildDraftRecord(scopeKey, snapshot, status, createdAtRef);
      rememberLocalRecoveryCandidate(record);
      void desktopApi.recordComposerDraftHistory({ draft: record }).catch((error) => {
        console.warn("Failed to record composer draft history", error);
      });
    },
    [desktopApi, rememberLocalRecoveryCandidate],
  );

  useEffect(() => {
    if (!desktopApi?.listComposerDraftLatest) {
      return;
    }

    let cancelled = false;
    setHydration({ baseStore, desktopApi, status: "loading" });
    void desktopApi.listComposerDraftLatest({ migrateKnownOwners: true })
      .then((response) => {
        if (cancelled) {
          return;
        }
        let hydratedAny = false;
        for (const draft of response.drafts) {
          if (!baseStore.get(draft.scopeKey)) {
            baseStore.set(draft.scopeKey, snapshotFromDraftRecord(draft));
            createdAtRef.current.set(draft.scopeKey, draft.createdAt);
            persistedHashRef.current.set(draft.scopeKey, draft.contentHash);
            hydratedAny = true;
          }
        }
        if (hydratedAny) {
          setHydrationVersion((current) => current + 1);
        }
        setHydration({ baseStore, desktopApi, status: "ready" });
      })
      .catch((error) => {
        if (cancelled) return;
        setHydration({ baseStore, desktopApi, status: "failed" });
        console.warn("Failed to hydrate composer drafts", error);
      });

    return () => {
      cancelled = true;
    };
  }, [baseStore, desktopApi]);

  const flushAllPendingSaves = useCallback((): void => {
    for (const [scopeKey, pending] of [...pendingSavesRef.current]) {
      flushPendingSave(scopeKey, pending);
    }
  }, [flushPendingSave]);

  useEffect(() => {
    return () => {
      flushAllPendingSaves();
    };
  }, [flushAllPendingSaves]);

  /**
   * Flush whenever the operator stops interacting with this window.
   *
   * The unmount cleanup above is a React lifecycle hook, and a renderer being
   * torn down — window closed, app quit — does not run it. That was near
   * enough to harmless while the write interval was 200ms; at 5s it would mean
   * typing for four seconds, quitting, and losing it, which is precisely the
   * failure a draft-recovery feature exists to prevent.
   *
   * Blur and `visibilitychange` both land well BEFORE teardown, so the async
   * IPC has a normal amount of time to complete — unlike `beforeunload`, where
   * an in-flight `invoke` may never be delivered. `beforeunload` is registered
   * anyway as a last resort for paths that somehow skip the others; it is
   * best-effort by nature, not the thing being relied on.
   *
   * Flushing on blur is cheap because the dirty check already gates it: a
   * window that lost focus with nothing pending writes nothing.
   */
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const flushIfHidden = (): void => {
      if (document.visibilityState === "hidden") {
        flushAllPendingSaves();
      }
    };

    window.addEventListener("blur", flushAllPendingSaves);
    window.addEventListener("beforeunload", flushAllPendingSaves);
    document.addEventListener("visibilitychange", flushIfHidden);
    return () => {
      window.removeEventListener("blur", flushAllPendingSaves);
      window.removeEventListener("beforeunload", flushAllPendingSaves);
      document.removeEventListener("visibilitychange", flushIfHidden);
    };
  }, [flushAllPendingSaves]);

  return useMemo(
    () => ({
      ...baseStore,
      hydrationVersion,
      hydrationStatus,
      delete: (scopeKey) => {
        baseStore.delete(scopeKey);
        createdAtRef.current.delete(scopeKey);
        persistedHashRef.current.delete(scopeKey);
        const pending = pendingSavesRef.current.get(scopeKey);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingSavesRef.current.delete(scopeKey);
        }
        void desktopApi?.clearComposerDraft?.({ scopeKey }).catch((error) => {
          console.warn("Failed to clear composer draft", error);
        });
      },
      listRecoveryCandidates: async (
        request: ListComposerDraftRecoveryCandidatesRequest,
      ): Promise<ComposerDraftRecoveryCandidate[]> => {
        const response = await desktopApi?.listComposerDraftRecoveryCandidates?.(
          request,
        );
        const localCandidates = localRecoveryCandidatesRef.current
          .filter((candidate) => matchesLocalRecoveryRequest(candidate, request))
          .map(({ localSequence: _localSequence, ...candidate }) => candidate);
        return mergeRecoveryCandidates(
          localCandidates,
          response?.candidates ?? [],
          request,
        );
      },
      pushDraft: (scopeKey, snapshot) => {
        const threadOwner = snapshot.threadOwner ?? baseStore.getScopeOwner?.(scopeKey);
        if (threadOwner) snapshot = { ...snapshot, threadOwner };
        baseStore.pushDraft(scopeKey, snapshot);
        persistDraftHistory(scopeKey, snapshot, "abandoned", true);
      },
      recordHistory: (
        scopeKey: string,
        snapshot: ComposerDraftSnapshot,
        status: ComposerDraftLifecycle,
      ): void => {
        const threadOwner = snapshot.threadOwner ?? baseStore.getScopeOwner?.(scopeKey);
        if (threadOwner) snapshot = { ...snapshot, threadOwner };
        persistDraftHistory(scopeKey, snapshot, status);
      },
      set: (scopeKey, snapshot) => {
        const threadOwner = snapshot.threadOwner ?? baseStore.getScopeOwner?.(scopeKey);
        if (threadOwner) snapshot = { ...snapshot, threadOwner };
        baseStore.set(scopeKey, snapshot);
        if (!desktopApi?.saveComposerDraft) {
          return;
        }

        const existingPending = pendingSavesRef.current.get(scopeKey);
        if (existingPending) {
          // A write is already scheduled. Take the newer snapshot but LEAVE
          // the timer alone — resetting it here is what would turn this back
          // into a debounce that never fires while someone keeps typing.
          pendingSavesRef.current.set(scopeKey, {
            ...existingPending,
            snapshot,
          });
          return;
        }

        // Nothing scheduled, so this is the first edit of a new window — and
        // only a real edit earns a write. An unchanged snapshot reaches here
        // constantly: the composer re-saves on unmount without a dirty check,
        // so merely opening a thread and navigating away would otherwise cost
        // a write and restamp `updated_at`.
        if (
          hashDraftContent(snapshot) === persistedHashRef.current.get(scopeKey)
        ) {
          return;
        }

        const saveComposerDraft = desktopApi.saveComposerDraft;
        const timer = window.setTimeout(() => {
          const pending = pendingSavesRef.current.get(scopeKey);
          if (pending) {
            flushPendingSave(scopeKey, pending);
          }
        }, DURABLE_SAVE_INTERVAL_MS);
        pendingSavesRef.current.set(scopeKey, {
          saveComposerDraft,
          snapshot,
          timer,
        });
      },
    }),
    [
      baseStore,
      desktopApi,
      flushPendingSave,
      hydrationVersion,
      hydrationStatus,
      persistDraftHistory,
    ],
  );
}

export function snapshotFromDraftRecord(
  record: ComposerDraftSnapshotRecord,
): ComposerDraftSnapshot {
  return {
    ...(record.threadOwner ? { threadOwner: record.threadOwner } : {}),
    draft: record.text,
    editorDocument: record.editorDocument as JSONContent | undefined,
    imageAttachments: record.imageAttachments,
    fileAttachments: record.fileAttachments,
    skillTokens: record.skillTokens,
  };
}

function buildDraftRecord(
  scopeKey: string,
  snapshot: ComposerDraftSnapshot,
  status: ComposerDraftLifecycle,
  createdAtRef: MutableRefObject<Map<string, number>>,
): ComposerDraftSnapshotRecord {
  const now = Date.now();
  const createdAt = createdAtRef.current.get(scopeKey) ?? now;
  createdAtRef.current.set(scopeKey, createdAt);
  const scope = parseScope(scopeKey);
  const contentHash = hashDraftContent(snapshot);

  return {
    ...(snapshot.threadOwner ? { threadOwner: snapshot.threadOwner } : {}),
    scopeKey,
    scopeKind: scope.scopeKind,
    backend: scope.backend,
    threadId: scope.threadId,
    directoryKey: scope.directoryKey,
    text: snapshot.draft,
    editorDocument: snapshot.editorDocument as ComposerDraftJsonValue | undefined,
    skillTokens: snapshot.skillTokens,
    imageAttachments: snapshot.imageAttachments,
    fileAttachments: snapshot.fileAttachments,
    status,
    createdAt,
    updatedAt: now,
    contentHash,
    charCount: snapshot.draft.length,
  };
}

function parseScope(scopeKey: string): {
  backend?: AppServerBackendKind;
  directoryKey?: string;
  scopeKind: ComposerDraftScopeKind;
  threadId?: string;
} {
  const owned = parseOwnedComposerScopeKey(scopeKey);
  if (owned) return { backend: owned.backend, threadId: owned.threadId, scopeKind: "thread" };
  if (scopeKey.startsWith("thread:")) {
    const remainder = scopeKey.slice("thread:".length);
    const separatorIndex = remainder.indexOf(":");
    if (separatorIndex === -1) {
      return { scopeKind: "thread", threadId: remainder };
    }
    return {
      backend: remainder.slice(0, separatorIndex) as AppServerBackendKind,
      scopeKind: "thread",
      threadId: remainder.slice(separatorIndex + 1),
    };
  }
  if (scopeKey.startsWith("launchpad:")) {
    return {
      directoryKey: scopeKey.slice("launchpad:".length),
      scopeKind: "launchpad",
    };
  }
  return { scopeKind: "empty" };
}

function shouldRecordHistory(
  snapshot: ComposerDraftSnapshot,
  status: ComposerDraftLifecycle,
): boolean {
  if (status === "cleared") {
    return false;
  }
  const hasRecoverableContent =
    snapshot.draft.trim().length > 0 ||
    snapshot.imageAttachments.length > 0 ||
    (snapshot.fileAttachments?.length ?? 0) > 0 ||
    snapshot.skillTokens.length > 0;
  if (status === "sent") {
    return hasRecoverableContent;
  }
  if (
    snapshot.imageAttachments.length > 0 ||
    (snapshot.fileAttachments?.length ?? 0) > 0 ||
    snapshot.skillTokens.length > 0
  ) {
    return true;
  }
  return snapshot.draft.trim().length >= HISTORY_TEXT_THRESHOLD;
}

function mergeRecoveryCandidates(
  localCandidates: ComposerDraftRecoveryCandidate[],
  durableCandidates: ComposerDraftRecoveryCandidate[],
  request: ListComposerDraftRecoveryCandidatesRequest,
): ComposerDraftRecoveryCandidate[] {
  const seen = new Set<string>();
  const limit = clampRecoveryLimit(request.limit);
  return [...localCandidates, ...durableCandidates]
    .filter((candidate) => {
      const key = getRecoveryCandidateKey(candidate);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      const leftScore = scoreRecoveryCandidate(left, request);
      const rightScore = scoreRecoveryCandidate(right, request);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, limit);
}

function clampRecoveryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 20;
  }
  return Math.max(1, Math.min(50, Math.floor(limit)));
}

function getRecoveryCandidateKey(
  candidate: Pick<
    ComposerDraftRecoveryCandidate,
    "contentHash" | "scopeKey" | "status"
  >,
): string {
  return `${candidate.scopeKey}:${candidate.status}:${candidate.contentHash}`;
}

function matchesLocalRecoveryRequest(
  candidate: ComposerDraftRecoveryCandidate,
  request: ListComposerDraftRecoveryCandidatesRequest,
): boolean {
  if (candidate.status === "sent" && !request.includeSent) {
    return false;
  }
  if (request.backend && candidate.backend !== request.backend) {
    return false;
  }
  if (request.scopeKey && candidate.scopeKey === request.scopeKey) {
    return true;
  }
  if (request.threadId && candidate.threadId === request.threadId) {
    return true;
  }
  if (request.directoryKey && candidate.directoryKey === request.directoryKey) {
    return true;
  }
  return !request.scopeKey && !request.threadId && !request.directoryKey;
}

function scoreRecoveryCandidate(
  candidate: ComposerDraftRecoveryCandidate,
  request: ListComposerDraftRecoveryCandidatesRequest,
): number {
  let score = 0;
  if (request.scopeKey && candidate.scopeKey === request.scopeKey) {
    score += 100;
  }
  if (request.threadId && candidate.threadId === request.threadId) {
    score += 60;
  }
  if (request.directoryKey && candidate.directoryKey === request.directoryKey) {
    score += 40;
  }
  if (candidate.status === "unsent") {
    score += 20;
  }
  if (candidate.status === "sent") {
    score -= 10;
  }
  return score;
}

function shouldReplacePreviousUnsentCandidate(
  previous: ComposerDraftRecoveryCandidate | undefined,
  next: ComposerDraftRecoveryCandidate,
): boolean {
  if (!previous || previous.status === "sent" || next.status === "sent") {
    return false;
  }
  if (previous.scopeKey !== next.scopeKey) {
    return false;
  }
  const previousText = previous.text.trimEnd();
  const nextText = next.text.trimEnd();
  // Must stay in step with `shouldReplacePreviousUnsentDraft` in
  // composer-draft-recovery-store.ts — this is the in-memory half of the same
  // rule, and it carried the same bug: both sides are `trimEnd`ed, so a
  // strict length comparison failed on every typed space and left one
  // candidate per word instead of one per edit.
  return previousText.length > 0 && nextText.startsWith(previousText);
}

/**
 * Content fingerprint for a snapshot.
 *
 * Note what this now decides. It started as a dedupe/ranking key for recovery
 * candidates, where a collision merely merged two entries in a list. It is now
 * also the dirty check that decides whether an edit is persisted AT ALL, so a
 * collision means a draft change is silently never written. djb2/32-bit makes
 * that vanishingly unlikely between successive edits of one document, and the
 * consequence is bounded (the next distinct edit writes), but the risk class
 * changed when the second caller arrived — do not widen its use further
 * without swapping in something with real collision resistance.
 *
 * It must also stay in step with the record round-trip: hydration seeds the
 * persisted-hash map straight from a stored `contentHash`, so if this function
 * and `snapshotFromDraftRecord` ever disagree about which fields matter, the
 * dirty check either stops suppressing (harmless) or suppresses a real edit
 * (not). `useDurableComposerDraftStore.test.tsx` pins that round-trip.
 */
function hashDraftContent(snapshot: ComposerDraftSnapshot): string {
  const content = JSON.stringify({
    ...(snapshot.threadOwner ? { threadOwner: snapshot.threadOwner } : {}),
    text: snapshot.draft,
    editorDocument: snapshot.editorDocument,
    skillTokens: snapshot.skillTokens.map((token) => ({
      id: token.id,
      index: token.index,
      kind: token.kind,
      name: token.name,
      path: token.path,
    })),
    imageAttachments: snapshot.imageAttachments.map((attachment) => ({
      url: attachment.url,
    })),
    fileAttachments: (snapshot.fileAttachments ?? []).map((attachment) => ({
      path: attachment.path,
    })),
  });
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 33) ^ content.charCodeAt(index);
  }
  return `h${(hash >>> 0).toString(36)}`;
}
