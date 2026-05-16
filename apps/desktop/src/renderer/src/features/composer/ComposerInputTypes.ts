import type { JSONContent } from "@tiptap/react";
import type { AppServerSkillSummary } from "@pwragent/shared";

export type ComposerSkillToken = AppServerSkillSummary & {
  id: string;
  index: number;
};

export type ComposerInputChangeMetadata = {
  editorDocument?: JSONContent;
};

export type ComposerInputHandle = {
  deleteSelection: () => void;
  focus: () => void;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly skillTokenCount: number;
  readonly value: string;
  setSelectionRange: (start: number, end: number) => void;
};
