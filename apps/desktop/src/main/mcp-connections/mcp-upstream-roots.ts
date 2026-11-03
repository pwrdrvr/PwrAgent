import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Root } from "@modelcontextprotocol/sdk/types.js";

/*
 * MCP roots for a managed connection's thread session.
 *
 * A local command's server asks `roots/list` to learn which directories it
 * may work in. PwrAgent answers with the directories of the thread the
 * session serves. Only a local command is told: a `file://` path means
 * nothing to a remote server, and would hand it the operator's home
 * directory, user name and repository names.
 */

/** The most roots one thread hands a server. */
export const MAX_UPSTREAM_ROOTS = 64;
const MAX_ROOT_NAME_LENGTH = 256;
const MAX_ROOT_URI_LENGTH = 4_096;

/** A directory of a thread, as the thread's own instance reports it. */
export type ThreadRootDirectory = {
  path: string;
  name?: string;
};

/**
 * Roots from a thread's directories, in the order given: the first is the
 * thread's working directory. A relative or repeated path is dropped; a
 * repeat may still supply the name the first one lacked.
 */
export function buildUpstreamRoots(directories: readonly ThreadRootDirectory[]): Root[] {
  const roots: Root[] = [];
  const byUri = new Map<string, Root>();
  for (const directory of directories) {
    const path = typeof directory.path === "string" ? directory.path.trim() : "";
    if (!path || !isAbsolute(path)) continue;
    const uri = pathToFileURL(path).href;
    if (uri.length > MAX_ROOT_URI_LENGTH) continue;
    const name = typeof directory.name === "string"
      ? directory.name.trim().slice(0, MAX_ROOT_NAME_LENGTH)
      : "";
    const existing = byUri.get(uri);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      continue;
    }
    if (roots.length >= MAX_UPSTREAM_ROOTS) continue;
    const root: Root = name ? { uri, name } : { uri };
    byUri.set(uri, root);
    roots.push(root);
  }
  return roots;
}

/**
 * Roots relayed from another instance on the same profile, checked before
 * any server sees them: `file://` URIs only, bounded, no other fields.
 */
export function readRelayedRoots(value: unknown): Root[] {
  if (!Array.isArray(value) || value.length > MAX_UPSTREAM_ROOTS) {
    throw new Error("Invalid MCP roots update.");
  }
  return value.map((entry) => {
    const record = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined;
    const uri = record?.uri;
    const name = record?.name;
    if (typeof uri !== "string" || !uri.startsWith("file://") || uri.length > MAX_ROOT_URI_LENGTH
      || (name !== undefined && (typeof name !== "string" || name.length > MAX_ROOT_NAME_LENGTH))) {
      throw new Error("Invalid MCP roots update.");
    }
    return typeof name === "string" && name ? { uri, name } : { uri };
  });
}

/** Stable text for comparing the roots one session was last given. */
export function rootsFingerprint(roots: readonly Root[]): string {
  return JSON.stringify(roots.map((root) => [root.uri, root.name ?? ""]));
}
