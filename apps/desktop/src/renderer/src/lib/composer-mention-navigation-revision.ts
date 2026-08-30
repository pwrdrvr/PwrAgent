let revision = 0;

/**
 * A renderer-local generation for the navigation population behind composer
 * `@` and `#` autocomplete. Directory registration changes that population
 * without an agent event, so the shared lazy cache needs an explicit signal.
 */
export function getComposerMentionNavigationRevision(): number {
  return revision;
}

export function notifyComposerMentionNavigationChanged(): void {
  revision += 1;
}
