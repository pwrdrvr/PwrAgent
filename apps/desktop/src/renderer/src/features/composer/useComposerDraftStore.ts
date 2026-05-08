import { useMemo, useRef } from "react";
import type { JSONContent } from "@tiptap/react";
import type { NavigationLaunchpadImageAttachment } from "@pwragent/shared";
import type { ComposerSkillToken } from "./ComposerRichInput";

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

export type ComposerDraftStore = {
  delete(scopeKey: string): void;
  get(scopeKey: string): ComposerDraftSnapshot | undefined;
  deleteQueuedTurn(scopeKey: string): void;
  getQueuedTurn(scopeKey: string): ComposerQueuedTurnSnapshot | undefined;
  setQueuedTurn(scopeKey: string, snapshot: ComposerQueuedTurnSnapshot): void;
  set(scopeKey: string, snapshot: ComposerDraftSnapshot): void;
};

export function useComposerDraftStore(): ComposerDraftStore {
  const storeRef = useRef(new Map<string, ComposerDraftSnapshot>());
  const queuedTurnStoreRef = useRef(new Map<string, ComposerQueuedTurnSnapshot>());

  return useMemo(
    () => ({
      delete: (scopeKey) => {
        storeRef.current.delete(scopeKey);
      },
      get: (scopeKey) => storeRef.current.get(scopeKey),
      deleteQueuedTurn: (scopeKey) => {
        queuedTurnStoreRef.current.delete(scopeKey);
      },
      getQueuedTurn: (scopeKey) => queuedTurnStoreRef.current.get(scopeKey),
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
