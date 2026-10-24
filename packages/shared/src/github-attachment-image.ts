/** Authored Markdown may fetch public attachments, never arbitrary GitHub routes. */
export function isGitHubAttachmentImageUrl(value: string): boolean {
  // This fixed URL shape also excludes credentials, ports, query strings,
  // fragments, encoded path separators, and lookalike hostnames. Keep it
  // independent of Node/browser URL globals: shared has neither runtime lib.
  return value === value.trim()
    && /^https:\/\/github\.com\/user-attachments\/assets\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
}

export function toGitHubAttachmentImageProtocolUrl(value: string): string {
  return `pwragent-image://github/${encodeURIComponent(value)}`;
}
