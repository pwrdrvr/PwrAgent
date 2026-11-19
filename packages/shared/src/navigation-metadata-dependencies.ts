import type { NavigationMetadataDependencies } from "./contracts/navigation";

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
