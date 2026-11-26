import { useEffect, useId, useMemo, useState } from "react";
import {
  EMOJI_AUTOCOMPLETE_LIMIT,
  findEmojiShortcodeTrigger,
  searchEmojiShortcodes,
} from "../../lib/emoji-shortcodes";
import { useEmojiShortcodeCatalog } from "../../lib/useEmojiShortcodeCatalog";
import type { ReactionEmojiEntry } from "../navigation/reaction-picker-model";
import type { ComposerInputHandle, ComposerReferenceTrigger } from "./ComposerInputTypes";

export type ComposerEmojiAutocompleteState = {
  activeIndex: number;
  listboxId: string;
  options: readonly ReactionEmojiEntry[];
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  trigger: ComposerReferenceTrigger | undefined;
};

export function useComposerEmojiAutocomplete(params: {
  draft: string;
  input: ComposerInputHandle | null;
  scopeKey: string;
  selectionStart: number;
}): ComposerEmojiAutocompleteState {
  const listboxId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const trigger = params.input
    ? params.input.getEmojiTrigger()
    : findEmojiShortcodeTrigger(params.draft, params.selectionStart);
  const query = trigger?.query;
  const catalog = useEmojiShortcodeCatalog(trigger !== undefined);

  const options = useMemo(
    () =>
      query === undefined
        ? []
        : searchEmojiShortcodes(query, catalog, EMOJI_AUTOCOMPLETE_LIMIT),
    [catalog, query],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, params.scopeKey]);

  return {
    activeIndex,
    listboxId,
    options,
    setActiveIndex,
    trigger,
  };
}
