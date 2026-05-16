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
  ComposerDraftStore,
} from "./useComposerDraftStore";

const DURABLE_SAVE_DEBOUNCE_MS = 200;
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
  const localRecoveryCandidatesRef = useRef<LocalRecoveryCandidate[]>([]);
  const localRecoverySequenceRef = useRef(0);
  const [hydrationVersion, setHydrationVersion] = useState(0);

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

  useEffect(() => {
    if (!desktopApi?.listComposerDraftLatest) {
      return;
    }

    let cancelled = false;
    void desktopApi.listComposerDraftLatest()
      .then((response) => {
        if (cancelled) {
          return;
        }
        let hydratedAny = false;
        for (const draft of response.drafts) {
          if (!baseStore.get(draft.scopeKey)) {
            baseStore.set(draft.scopeKey, snapshotFromDraftRecord(draft));
            createdAtRef.current.set(draft.scopeKey, draft.createdAt);
            hydratedAny = true;
          }
        }
        if (hydratedAny) {
          setHydrationVersion((current) => current + 1);
        }
      })
      .catch((error) => {
        console.warn("Failed to hydrate composer drafts", error);
      });

    return () => {
      cancelled = true;
    };
  }, [baseStore, desktopApi]);

  useEffect(() => {
    return () => {
      for (const [scopeKey, pending] of [...pendingSavesRef.current]) {
        flushPendingSave(scopeKey, pending);
      }
    };
  }, [flushPendingSave]);

  return useMemo(
    () => ({
      ...baseStore,
      hydrationVersion,
      delete: (scopeKey) => {
        baseStore.delete(scopeKey);
        createdAtRef.current.delete(scopeKey);
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
      recordHistory: (
        scopeKey: string,
        snapshot: ComposerDraftSnapshot,
        status: ComposerDraftLifecycle,
      ): void => {
        if (!desktopApi?.recordComposerDraftHistory) {
          return;
        }
        if (!shouldRecordHistory(snapshot, status)) {
          return;
        }
        const record = buildDraftRecord(scopeKey, snapshot, status, createdAtRef);
        rememberLocalRecoveryCandidate(record);
        void desktopApi.recordComposerDraftHistory({ draft: record }).catch((error) => {
          console.warn("Failed to record composer draft history", error);
        });
      },
      set: (scopeKey, snapshot) => {
        baseStore.set(scopeKey, snapshot);
        if (!desktopApi?.saveComposerDraft) {
          return;
        }

        const existingPending = pendingSavesRef.current.get(scopeKey);
        if (existingPending) {
          window.clearTimeout(existingPending.timer);
        }

        const saveComposerDraft = desktopApi.saveComposerDraft;
        const timer = window.setTimeout(() => {
          const pending = pendingSavesRef.current.get(scopeKey);
          if (pending) {
            flushPendingSave(scopeKey, pending);
          }
        }, DURABLE_SAVE_DEBOUNCE_MS);
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
      rememberLocalRecoveryCandidate,
    ],
  );
}

export function snapshotFromDraftRecord(
  record: ComposerDraftSnapshotRecord,
): ComposerDraftSnapshot {
  return {
    draft: record.text,
    editorDocument: record.editorDocument as JSONContent | undefined,
    imageAttachments: record.imageAttachments,
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
    scopeKey,
    scopeKind: scope.scopeKind,
    backend: scope.backend,
    threadId: scope.threadId,
    directoryKey: scope.directoryKey,
    text: snapshot.draft,
    editorDocument: snapshot.editorDocument as ComposerDraftJsonValue | undefined,
    skillTokens: snapshot.skillTokens,
    imageAttachments: snapshot.imageAttachments,
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
    snapshot.skillTokens.length > 0;
  if (status === "sent") {
    return hasRecoverableContent;
  }
  if (snapshot.imageAttachments.length > 0 || snapshot.skillTokens.length > 0) {
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
  return (
    previousText.length > 0 &&
    nextText.length > previousText.length &&
    nextText.startsWith(previousText)
  );
}

function hashDraftContent(snapshot: ComposerDraftSnapshot): string {
  const content = JSON.stringify({
    text: snapshot.draft,
    editorDocument: snapshot.editorDocument,
    skillTokens: snapshot.skillTokens.map((token) => ({
      id: token.id,
      index: token.index,
      name: token.name,
      path: token.path,
    })),
    imageAttachments: snapshot.imageAttachments.map((attachment) => ({
      url: attachment.url,
    })),
  });
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 33) ^ content.charCodeAt(index);
  }
  return `h${(hash >>> 0).toString(36)}`;
}
