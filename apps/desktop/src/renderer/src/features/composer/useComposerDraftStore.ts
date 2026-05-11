import { useMemo, useRef } from "react";
import type { JSONContent } from "@tiptap/react";
import type {
  AppServerReviewTarget,
  AppServerTurnInputItem,
  NavigationLaunchpadImageAttachment,
} from "@pwragent/shared";
import type { ComposerSkillToken } from "./ComposerInputTypes";

export type ComposerDraftSnapshot = {
  draft: string;
  editorDocument?: JSONContent;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  skillTokens: ComposerSkillToken[];
};

export type ComposerQueuedTurnSnapshot = {
  id: string;
  input?: AppServerTurnInputItem[];
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  reviewCommand?: {
    displayText: string;
    target: AppServerReviewTarget;
  };
};

export type ComposerPendingSteerSnapshot = {
  id: string;
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
};

export type ComposerDraftStore = {
  delete(scopeKey: string): void;
  get(scopeKey: string): ComposerDraftSnapshot | undefined;
  deletePendingSteer(scopeKey: string): void;
  deleteQueuedTurn(scopeKey: string): void;
  getPendingSteer(scopeKey: string): ComposerPendingSteerSnapshot | undefined;
  getQueuedTurn(scopeKey: string): ComposerQueuedTurnSnapshot | undefined;
  getQueuedTurns(scopeKey: string): ComposerQueuedTurnSnapshot[];
  removeQueuedTurnAt(scopeKey: string, index: number): ComposerQueuedTurnSnapshot | undefined;
  removeQueuedTurnById(scopeKey: string, id: string): ComposerQueuedTurnSnapshot | undefined;
  shiftQueuedTurn(scopeKey: string): ComposerQueuedTurnSnapshot | undefined;
  setPendingSteer(scopeKey: string, snapshot: ComposerPendingSteerSnapshot): void;
  setQueuedTurn(scopeKey: string, snapshot: ComposerQueuedTurnSnapshot): void;
  setQueuedTurns(scopeKey: string, snapshots: ComposerQueuedTurnSnapshot[]): void;
  set(scopeKey: string, snapshot: ComposerDraftSnapshot): void;
};

export function useComposerDraftStore(): ComposerDraftStore {
  const storeRef = useRef(new Map<string, ComposerDraftSnapshot>());
  const pendingSteerStoreRef = useRef(new Map<string, ComposerPendingSteerSnapshot>());
  const queuedTurnStoreRef = useRef(new Map<string, ComposerQueuedTurnSnapshot[]>());

  return useMemo(
    () => ({
      delete: (scopeKey) => {
        storeRef.current.delete(scopeKey);
      },
      get: (scopeKey) => storeRef.current.get(scopeKey),
      deletePendingSteer: (scopeKey) => {
        pendingSteerStoreRef.current.delete(scopeKey);
      },
      deleteQueuedTurn: (scopeKey) => {
        queuedTurnStoreRef.current.delete(scopeKey);
      },
      getPendingSteer: (scopeKey) => pendingSteerStoreRef.current.get(scopeKey),
      getQueuedTurn: (scopeKey) => queuedTurnStoreRef.current.get(scopeKey)?.[0],
      getQueuedTurns: (scopeKey) => queuedTurnStoreRef.current.get(scopeKey) ?? [],
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
        return first;
      },
      setPendingSteer: (scopeKey, snapshot) => {
        pendingSteerStoreRef.current.set(scopeKey, snapshot);
      },
      setQueuedTurn: (scopeKey, snapshot) => {
        queuedTurnStoreRef.current.set(scopeKey, [snapshot]);
      },
      setQueuedTurns: (scopeKey, snapshots) => {
        if (snapshots.length === 0) {
          queuedTurnStoreRef.current.delete(scopeKey);
        } else {
          queuedTurnStoreRef.current.set(scopeKey, [...snapshots]);
        }
      },
      set: (scopeKey, snapshot) => {
        storeRef.current.set(scopeKey, snapshot);
      },
    }),
    [],
  );
}
