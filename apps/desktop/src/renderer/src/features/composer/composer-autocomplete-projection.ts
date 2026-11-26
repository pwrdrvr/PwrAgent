export type ComposerAutocompleteKind =
  | "directories"
  | "emoji"
  | "hash-references"
  | "skills"
  | "slash";

type TriggerRange = {
  end: number;
  query: string;
  start: number;
};

export type ComposerAutocompleteProjection = {
  activeAutocompleteIndex: number;
  activeAutocompleteOptionId: string | undefined;
  autocompleteKey: string | undefined;
  autocompleteKind: ComposerAutocompleteKind | undefined;
  autocompleteLength: number;
  autocompleteListboxId: string | undefined;
  availableAutocompleteKind: ComposerAutocompleteKind | undefined;
  hasAutocompleteOptions: boolean;
};

export function resolveComposerAutocompleteProjection(params: {
  activeDirectoryRefIndex: number;
  activeEmojiIndex: number;
  activeHashReferenceIndex: number;
  activeSkillIndex: number;
  activeSlashIndex: number;
  directoryRefCount: number;
  directoryRefListboxId: string;
  directoryRefTrigger: TriggerRange | undefined;
  dismissedAutocompleteKey: string | undefined;
  emojiCount: number;
  emojiListboxId: string;
  emojiTrigger: TriggerRange | undefined;
  federatedHashSearchLoading: boolean;
  filteredSkillCount: number;
  hashReferenceCount: number;
  hashReferenceListboxId: string;
  hashReferenceTrigger: TriggerRange | undefined;
  hasEnsureSkillsLoaded: boolean;
  matchingSkillCount: number;
  reviewConfigActive: boolean;
  skillListboxId: string;
  skillTrigger: TriggerRange | undefined;
  slashCount: number;
  slashListboxId: string;
  slashTrigger: TriggerRange | undefined;
}): ComposerAutocompleteProjection {
  const availableAutocompleteKind: ComposerAutocompleteKind | undefined =
    params.skillTrigger && (params.matchingSkillCount > 0 || params.hasEnsureSkillsLoaded)
      ? "skills"
      : params.slashTrigger && params.slashCount > 0
        ? "slash"
        : params.directoryRefTrigger && params.directoryRefCount > 0
          ? "directories"
          : params.emojiTrigger && params.emojiCount > 0
            ? "emoji"
            : params.hashReferenceTrigger
                && (params.hashReferenceCount > 0 || params.federatedHashSearchLoading)
              ? "hash-references"
              : undefined;

  const autocompleteKey =
    availableAutocompleteKind === "skills" && params.skillTrigger
      ? `skills:${params.skillTrigger.start}:${params.skillTrigger.end}:${params.skillTrigger.query}`
      : availableAutocompleteKind === "slash" && params.slashTrigger
        ? `slash:${params.slashTrigger.start}:${params.slashTrigger.end}:/${params.slashTrigger.query}`
        : availableAutocompleteKind === "directories" && params.directoryRefTrigger
          ? `directories:${params.directoryRefTrigger.start}:${params.directoryRefTrigger.end}:@${params.directoryRefTrigger.query}`
          : availableAutocompleteKind === "emoji" && params.emojiTrigger
            ? `emoji:${params.emojiTrigger.start}:${params.emojiTrigger.end}:${params.emojiTrigger.query}`
            : availableAutocompleteKind === "hash-references" && params.hashReferenceTrigger
              ? `hash-references:${params.hashReferenceTrigger.start}:${params.hashReferenceTrigger.end}:#${params.hashReferenceTrigger.query}`
              : undefined;

  const displayedAutocompleteKind =
    autocompleteKey && autocompleteKey === params.dismissedAutocompleteKey
      ? undefined
      : availableAutocompleteKind;
  const autocompleteKind = params.reviewConfigActive
    ? undefined
    : displayedAutocompleteKind;

  const activeAutocompleteIndex =
    autocompleteKind === "skills"
      ? params.activeSkillIndex
      : autocompleteKind === "directories"
        ? params.activeDirectoryRefIndex
        : autocompleteKind === "emoji"
          ? params.activeEmojiIndex
          : autocompleteKind === "hash-references"
            ? params.activeHashReferenceIndex
            : params.activeSlashIndex;

  const autocompleteLength =
    autocompleteKind === "skills"
      ? params.filteredSkillCount
      : autocompleteKind === "directories"
        ? params.directoryRefCount
        : autocompleteKind === "emoji"
          ? params.emojiCount
          : autocompleteKind === "hash-references"
            ? params.hashReferenceCount
            : params.slashCount;

  const hasAutocompleteOptions = Boolean(
    autocompleteKind && autocompleteLength > 0,
  );

  const autocompleteListboxId =
    autocompleteKind === "skills"
      ? params.skillListboxId
      : autocompleteKind === "slash"
        ? params.slashListboxId
        : autocompleteKind === "directories"
          ? params.directoryRefListboxId
          : autocompleteKind === "emoji"
            ? params.emojiListboxId
            : autocompleteKind === "hash-references"
              ? params.hashReferenceListboxId
              : undefined;

  const activeAutocompleteOptionId =
    autocompleteListboxId && autocompleteKind && autocompleteLength > 0
      ? `${autocompleteListboxId}-option-${activeAutocompleteIndex}`
      : undefined;

  return {
    activeAutocompleteIndex,
    activeAutocompleteOptionId,
    autocompleteKey,
    autocompleteKind,
    autocompleteLength,
    autocompleteListboxId,
    availableAutocompleteKind,
    hasAutocompleteOptions,
  };
}
