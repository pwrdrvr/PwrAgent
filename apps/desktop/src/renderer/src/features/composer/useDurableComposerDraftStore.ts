import {
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

export function useDurableComposerDraftStore(
  baseStore: ComposerDraftStore,
  desktopApi?: DesktopApi,
): ComposerDraftStore {
  const saveTimersRef = useRef(new Map<string, number>());
  const createdAtRef = useRef(new Map<string, number>());
  const [hydrationVersion, setHydrationVersion] = useState(0);

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
      for (const timer of saveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      saveTimersRef.current.clear();
    };
  }, []);

  return useMemo(
    () => ({
      ...baseStore,
      hydrationVersion,
      delete: (scopeKey) => {
        baseStore.delete(scopeKey);
        createdAtRef.current.delete(scopeKey);
        const timer = saveTimersRef.current.get(scopeKey);
        if (timer) {
          window.clearTimeout(timer);
          saveTimersRef.current.delete(scopeKey);
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
        return response?.candidates ?? [];
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
        void desktopApi.recordComposerDraftHistory({ draft: record }).catch((error) => {
          console.warn("Failed to record composer draft history", error);
        });
      },
      set: (scopeKey, snapshot) => {
        baseStore.set(scopeKey, snapshot);
        if (!desktopApi?.saveComposerDraft) {
          return;
        }

        const existingTimer = saveTimersRef.current.get(scopeKey);
        if (existingTimer) {
          window.clearTimeout(existingTimer);
        }

        const saveComposerDraft = desktopApi.saveComposerDraft;
        const timer = window.setTimeout(() => {
          saveTimersRef.current.delete(scopeKey);
          const record = buildDraftRecord(
            scopeKey,
            snapshot,
            "unsent",
            createdAtRef,
          );
          void saveComposerDraft({
            draft: record,
            recordHistory: shouldRecordHistory(snapshot, "unsent"),
          }).catch((error) => {
            console.warn("Failed to save composer draft", error);
          });
        }, DURABLE_SAVE_DEBOUNCE_MS);
        saveTimersRef.current.set(scopeKey, timer);
      },
    }),
    [baseStore, desktopApi, hydrationVersion],
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
  if (snapshot.imageAttachments.length > 0 || snapshot.skillTokens.length > 0) {
    return true;
  }
  return snapshot.draft.trim().length >= HISTORY_TEXT_THRESHOLD;
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
