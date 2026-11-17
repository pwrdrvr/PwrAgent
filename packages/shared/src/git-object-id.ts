/** A full git object id: SHA-1 (40) or SHA-256 (64) lowercase hex. */
export function isGitObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}
