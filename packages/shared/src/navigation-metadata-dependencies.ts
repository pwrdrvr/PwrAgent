import type { NavigationDirectoryGitProof, NavigationDirectoryGitRevisions, NavigationMetadataDependencies } from "./contracts/navigation";

export const NAVIGATION_METADATA_DEPENDENCY_MAX_KEYS = 512;
export const NAVIGATION_METADATA_DEPENDENCY_MAX_BYTES = 64 * 1024;

/** The proof is optional: old peers, unknown versions and excess metadata
 * retain ordinary refreshes. Never truncate an authoritative set. */
export function readNavigationMetadataDependencies(value: unknown): NavigationMetadataDependencies | undefined {
  if (!value || typeof value !== "object") return undefined;
  const proof = value as NavigationMetadataDependencies;
  const paths = proof.workingStatePaths;
  if (proof.version !== 1 || !Array.isArray(proof.threadKeys) || !Array.isArray(proof.prKeys)
    || (paths !== undefined && !Array.isArray(paths))
    || proof.threadKeys.length + proof.prKeys.length + (paths?.length ?? 0) > NAVIGATION_METADATA_DEPENDENCY_MAX_KEYS
    || !proof.threadKeys.every((key) => typeof key === "string") || !proof.prKeys.every((key) => typeof key === "string")
    || (paths && !paths.every((path) => typeof path === "string"))) return undefined;
  let bytes = 0;
  for (const char of JSON.stringify(proof)) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > NAVIGATION_METADATA_DEPENDENCY_MAX_BYTES) return undefined;
  }
  return proof;
}

export const DIRECTORY_GIT_PROOF_MAX_KEYS = 32;
export const DIRECTORY_GIT_PROOF_MAX_KEY_LENGTH = 256;

const isGitRevision = (value: unknown): value is string => typeof value === "string" && value.length === 43 && !/[^A-Za-z0-9_-]/.test(value);

export function readDirectoryGitRevisions(value: unknown): NavigationDirectoryGitRevisions | undefined {
  const revisions = value as Partial<NavigationDirectoryGitRevisions> | undefined;
  if (revisions?.version === 1 && isGitRevision(revisions.repository) && isGitRevision(revisions.descriptor)) {
    return { version: 1, repository: revisions.repository, descriptor: revisions.descriptor };
  }
  return undefined;
}

export function readDirectoryGitProof(value: unknown): NavigationDirectoryGitProof | undefined {
  const proof = value as NavigationDirectoryGitProof | undefined;
  if (proof?.version !== 1 || !Array.isArray(proof.directories) || proof.directories.length > DIRECTORY_GIT_PROOF_MAX_KEYS) return undefined;
  const keys = new Set<string>();
  const directories: Array<readonly [string, string]> = [];
  for (const entry of proof.directories) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0]
      || entry[0].length > DIRECTORY_GIT_PROOF_MAX_KEY_LENGTH || keys.has(entry[0]) || !isGitRevision(entry[1])) return undefined;
    keys.add(entry[0]);
    directories.push(Object.freeze([entry[0], entry[1]] as const));
  }
  return Object.freeze({ version: 1, directories: Object.freeze(directories) });
}
