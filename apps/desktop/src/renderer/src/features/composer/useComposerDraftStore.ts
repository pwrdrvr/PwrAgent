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

export type ComposerDraftStore = {
  delete(scopeKey: string): void;
  get(scopeKey: string): ComposerDraftSnapshot | undefined;
  set(scopeKey: string, snapshot: ComposerDraftSnapshot): void;
};

export function useComposerDraftStore(): ComposerDraftStore {
  const storeRef = useRef(new Map<string, ComposerDraftSnapshot>());

  return useMemo(
    () => ({
      delete: (scopeKey) => {
        storeRef.current.delete(scopeKey);
      },
      get: (scopeKey) => storeRef.current.get(scopeKey),
      set: (scopeKey, snapshot) => {
        storeRef.current.set(scopeKey, snapshot);
      },
    }),
    [],
  );
}
