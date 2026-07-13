import type { NavigationDirectorySummary } from "@pwragent/shared";
import { getHomeDir, tildifyPath } from "./tildify-path";

/**
 * Composer `@`-directory references.
 *
 * Typing `@` in the composer opens an autocomplete over the tracked
 * directories (the same population as the project picker). Committing a
 * candidate inserts the directory's tilde-shortened path as plain text at
 * the caret — the draft text itself is the source of truth. At send time
 * `listReferencedDirectories` re-scans the draft for any tracked
 * directory's path (inserted via `@`, typed by hand, or pasted) and the
 * caller links those directories to the thread. Deleting the path from the
 * draft removes the reference; no separate token state to keep in sync.
 */

export type DirectoryReferenceTrigger = {
  end: number;
  query: string;
  start: number;
};

/**
 * Match an in-progress `@` token immediately before the caret, mirroring
 * `findSkillTrigger`'s shape for `$` skills. The `@` must start the text
 * or follow whitespace, so email-like text (`user@example.com`) never
 * triggers. Path-ish query characters are allowed for narrowing.
 */
export function findDirectoryReferenceTrigger(
  text: string,
  caret: number,
): DirectoryReferenceTrigger | undefined {
  const prefix = text.slice(0, caret);
  const match = /(?:^|\s)@([A-Za-z0-9._~/-]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }

  const start = prefix.length - match[0].length + match[0].lastIndexOf("@");
  return {
    start,
    end: caret,
    query: match[1] ?? "",
  };
}

const CANDIDATE_LIMIT = 10;

function isReferenceable(directory: NavigationDirectorySummary): boolean {
  // Same exclusion as the project picker's `isPickable`, plus a real
  // filesystem path requirement — a reference is only useful when there
  // is a path to insert into the draft.
  return directory.kind !== "unlinked" && Boolean(directory.path);
}

/**
 * Rank tracked directories for the `@` autocomplete: referenceable
 * entries whose label or path contains the query, most recently updated
 * first, capped at 10. Unlike the project picker (which filters within
 * its top 10 recents), the query searches the full tracked set so an
 * older project is still reachable by name.
 */
export function filterDirectoryReferenceCandidates(
  directories: NavigationDirectorySummary[],
  query: string,
): NavigationDirectorySummary[] {
  const trimmed = query.trim().toLowerCase();
  return directories
    .filter(isReferenceable)
    .filter((directory) => {
      if (!trimmed) {
        return true;
      }
      const label = directory.label.toLowerCase();
      const path = (directory.path ?? "").toLowerCase();
      return (
        label.includes(trimmed)
        || path.includes(trimmed)
        || tildifyPath(directory.path ?? "").toLowerCase().includes(trimmed)
      );
    })
    .sort((left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0))
    .slice(0, CANDIDATE_LIMIT);
}

/** The text committed into the draft for a referenced directory. */
export function buildDirectoryReferenceInsertText(
  directory: Pick<NavigationDirectorySummary, "path">,
  homeDir: string | undefined = getHomeDir(),
): string {
  return tildifyPath(directory.path ?? "", homeDir);
}

/** Hover copy shared by the editor chip and the setup-row pill. */
export function buildDirectoryReferenceTooltip(
  path: string,
  homeDir: string | undefined = getHomeDir(),
): string {
  return `${tildifyPath(path, homeDir)} — linked to the thread when you send`;
}

/**
 * Serialized form of a directory-reference chip in the canonical draft
 * and outgoing text: `[@label](~/path)`. A markdown link keeps the path
 * bounded — text typed flush against the chip cannot glue onto it the
 * way a bare tilde path could — and gives the transcript renderer and
 * `parseSkillMentionParts` a self-describing form to chip/hydrate from.
 */
export function buildDirectoryReferenceMarkdown(
  reference: { label: string; path: string },
  homeDir: string | undefined = getHomeDir(),
): string {
  return `[@${reference.label}](${tildifyPath(reference.path, homeDir)})`;
}

/**
 * Characters that may legally follow a referenced path in prose. A `/`
 * counts so a deeper reference (`~/dev/app/src/index.ts`) still resolves
 * to the tracked repo root it lives under.
 */
const REFERENCE_BOUNDARY = /^[\s.,;:!?)\]}'"/]/;

function draftContainsPath(draft: string, candidate: string): boolean {
  if (!candidate) {
    return false;
  }
  let searchFrom = 0;
  while (searchFrom <= draft.length - candidate.length) {
    const index = draft.indexOf(candidate, searchFrom);
    if (index < 0) {
      return false;
    }
    const after = draft.slice(index + candidate.length);
    if (after.length === 0 || REFERENCE_BOUNDARY.test(after)) {
      return true;
    }
    searchFrom = index + 1;
  }
  return false;
}

/**
 * Scan a draft for tracked directories it references by path — the
 * tilde-shortened form, the absolute form, or a deeper path under either.
 * The result drives which directories get linked to the thread at send
 * time. `excludePaths` drops directories that are already linked (the
 * launchpad's own directory, a thread's existing linked directories).
 */
export function listReferencedDirectories(
  draft: string,
  directories: NavigationDirectorySummary[],
  options?: {
    excludePaths?: string[];
    homeDir?: string;
  },
): NavigationDirectorySummary[] {
  if (!draft) {
    return [];
  }
  const homeDir = options?.homeDir ?? getHomeDir();
  const excluded = new Set(
    (options?.excludePaths ?? [])
      .filter((path): path is string => Boolean(path))
      .map((path) => path.replace(/[/\\]+$/, "")),
  );
  const seenPaths = new Set<string>();
  const referenced: NavigationDirectorySummary[] = [];

  for (const directory of directories) {
    if (!isReferenceable(directory)) {
      continue;
    }
    const path = directory.path!.replace(/[/\\]+$/, "");
    if (!path || seenPaths.has(path) || excluded.has(path)) {
      continue;
    }
    const tilde = tildifyPath(path, homeDir);
    if (
      draftContainsPath(draft, path)
      || (tilde !== path && draftContainsPath(draft, tilde))
    ) {
      seenPaths.add(path);
      referenced.push(directory);
    }
  }

  // Nested tracked repos: `~/dev/app` in the draft also substring-matches
  // a tracked `~/dev`. Keep only the deepest match so the reference
  // resolves to the repo the path actually points into.
  return referenced.filter((directory) => {
    const path = directory.path!.replace(/[/\\]+$/, "");
    return !referenced.some((other) => {
      if (other === directory) {
        return false;
      }
      const otherPath = other.path!.replace(/[/\\]+$/, "");
      return otherPath.startsWith(`${path}/`);
    });
  });
}
