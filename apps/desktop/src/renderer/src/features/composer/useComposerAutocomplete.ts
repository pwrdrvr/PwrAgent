import { useCallback, useMemo, useState } from "react";
import { hashReferenceOptionKey, type HashReferenceOption } from "../../lib/hash-references";
import { resolveComposerAutocompleteProjection } from "./composer-autocomplete-projection";

type ComposerAutocompleteInput = Omit<Parameters<typeof resolveComposerAutocompleteProjection>[0],
  "activeHashReferenceIndex" | "hashReferenceCount"> & {
  composerScopeKey: string;
  hashReferenceOptions: readonly HashReferenceOption[];
};

export function useComposerAutocomplete({
  composerScopeKey,
  hashReferenceOptions,
  ...input
}: ComposerAutocompleteInput) {
  const hashReferenceOptionKeys = useMemo(() => hashReferenceOptions.map(hashReferenceOptionKey), [hashReferenceOptions]);
  const query = input.hashReferenceTrigger?.query;
  const scope = query === undefined ? undefined : JSON.stringify([composerScopeKey, query]);
  const [selection, setSelection] = useState<{ scope: string; key: string }>();
  const selectedKey = selection?.scope === scope ? selection?.key : undefined;
  const activeHashReferenceIndex = selectedKey === undefined
    ? 0 : Math.max(0, hashReferenceOptionKeys.indexOf(selectedKey));
  const projection = resolveComposerAutocompleteProjection({
    ...input,
    activeHashReferenceIndex,
    hashReferenceCount: hashReferenceOptions.length,
  });

  // Remember the initial highlight too. A late result can reorder the list
  // before the operator moves the highlight or accepts it with Enter or Tab.
  const visibleKey = projection.autocompleteKind === "hash-references"
    ? hashReferenceOptionKeys[activeHashReferenceIndex] : undefined;
  if (visibleKey !== selection?.key || (visibleKey !== undefined && selection?.scope !== scope)) {
    setSelection(visibleKey !== undefined && scope !== undefined ? { scope, key: visibleKey } : undefined);
  }

  const clearHashReferenceSelection = useCallback(() => setSelection(undefined), []);
  const selectHashReferenceOption = (index: number): void => {
    const key = hashReferenceOptionKeys[index];
    if (key !== undefined && key !== selectedKey && scope !== undefined) {
      setSelection({ scope, key });
    }
  };

  return {
    ...projection,
    activeHashReferenceIndex,
    clearHashReferenceSelection,
    hashReferenceOptionKeys,
    selectHashReferenceOption,
  };
}
