let revision = 0;

/**
 * Each BrowserWindow's generation for the navigation population behind
 * composer `@` and `#` autocomplete. The main-process registration broadcast
 * advances this local copy so separate renderer caches become stale together.
 */
export function getComposerMentionNavigationRevision(): number {
  return revision;
}

export function notifyComposerMentionNavigationChanged(): void {
  revision += 1;
}
