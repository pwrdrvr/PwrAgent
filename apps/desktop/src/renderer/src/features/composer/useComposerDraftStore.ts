import { useMemo, useRef } from "react";
import type { JSONContent } from "@tiptap/react";
import type { NavigationLaunchpadImageAttachment } from "@pwragent/shared";
import type { ComposerSkillToken } from "./ComposerInputTypes";

export type ComposerDraftSnapshot = {
  draft: string;
  editorDocument?: JSONContent;
  imageAttachments: NavigationLaunchpadImageAttachment[];
  skillTokens: ComposerSkillToken[];
};

export type ComposerQueuedTurnSnapshot = {
  text: string;
  imageAttachments: NavigationLaunchpadImageAttachment[];
};

export type ComposerPendingSteerSnapshot = {
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
  setPendingSteer(scopeKey: string, snapshot: ComposerPendingSteerSnapshot): void;
  setQueuedTurn(scopeKey: string, snapshot: ComposerQueuedTurnSnapshot): void;
  set(scopeKey: string, snapshot: ComposerDraftSnapshot): void;
};

export function useComposerDraftStore(): ComposerDraftStore {
  const storeRef = useRef(new Map<string, ComposerDraftSnapshot>());
  const pendingSteerStoreRef = useRef(new Map<string, ComposerPendingSteerSnapshot>());
  const queuedTurnStoreRef = useRef(new Map<string, ComposerQueuedTurnSnapshot>());

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
      getQueuedTurn: (scopeKey) => queuedTurnStoreRef.current.get(scopeKey),
      setPendingSteer: (scopeKey, snapshot) => {
        pendingSteerStoreRef.current.set(scopeKey, snapshot);
      },
      setQueuedTurn: (scopeKey, snapshot) => {
        queuedTurnStoreRef.current.set(scopeKey, snapshot);
      },
      set: (scopeKey, snapshot) => {
        storeRef.current.set(scopeKey, snapshot);
      },
    }),
    [],
  );
}
