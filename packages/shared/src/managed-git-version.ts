// PwrDrvr Git versions, for main and the renderer alike.

export type ManagedGitVersion = [number, number, number, number];

const MANAGED_GIT_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)-dev-pwrgit\.(\d+)$/u;

/** Base version, then the pwrgit build number. Never publish order. */
export function parseManagedGitVersion(value: string): ManagedGitVersion | undefined {
  const match = MANAGED_GIT_VERSION_PATTERN.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
    : undefined;
}

/** Orders two versions; a version this build cannot read sorts first. */
export function compareManagedGitVersions(left: string, right: string): number {
  const a = parseManagedGitVersion(left);
  const b = parseManagedGitVersion(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
