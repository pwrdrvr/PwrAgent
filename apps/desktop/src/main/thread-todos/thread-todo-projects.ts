import type {
  DirectorySummaryKind,
  LinkedDirectorySummary,
  ThreadTodoProject,
} from "@pwragent/shared";
import {
  canonicalizeNavigationPath,
  classifyDirectory,
} from "@pwragent/shared";

/** One row of the Directories lens, as the directory-index query lists it. */
export type ThreadTodoProjectCandidate = {
  key: string;
  label: string;
  kind: DirectorySummaryKind;
  path?: string;
};

export type ThreadTodoProjectMatch =
  | { ok: true; project: ThreadTodoProject }
  | { ok: false; message: string };

const MAX_LISTED_PROJECTS = 20;

/**
 * The projects a card can name: the Directories lens rows that are real
 * directories. Workspaces and unlinked rows are not somewhere work can be
 * sent.
 */
export function threadTodoProjectChoices(
  candidates: readonly ThreadTodoProjectCandidate[],
): ThreadTodoProject[] {
  const projects = new Map<string, ThreadTodoProject>();
  for (const candidate of candidates) {
    if (candidate.kind !== "directory" || typeof candidate.path !== "string") continue;
    if (projects.has(candidate.key)) continue;
    projects.set(candidate.key, {
      key: candidate.key,
      label: candidate.label,
      path: candidate.path,
    });
  }
  return [...projects.values()];
}

/**
 * Resolve the project a thread named ("PwrSnap", a path, or a directory key)
 * against the projects the sidebar lists.
 *
 * A path resolves to the project that contains it, so a subdirectory works.
 * A worktree lives outside its project's root, so a path that no project
 * contains falls back to its folder name, which Codex and PwrAgent
 * worktrees keep.
 *
 * A name that matches two projects is refused rather than guessed, since
 * two clones can share a folder name and the card would act in whichever
 * one won.
 */
export function matchThreadTodoProject(
  query: string,
  candidates: readonly ThreadTodoProjectCandidate[],
): ThreadTodoProjectMatch {
  const projects = threadTodoProjectChoices(candidates);
  const trimmed = query.trim();
  const asPath = canonicalizeNavigationPath(trimmed);
  const exact = projects.filter((project) =>
    project.key === trimmed
    || canonicalizeNavigationPath(project.path) === asPath);
  const matches = exact.length > 0
    ? exact
    : looksLikePath(trimmed)
      ? containingProjects(asPath, projects)
      : [];
  const resolved = matches.length > 0
    ? matches
    : projectsNamed(looksLikePath(trimmed) ? basename(trimmed) : trimmed, projects);
  if (resolved.length === 1) {
    return { ok: true, project: resolved[0]! };
  }
  if (resolved.length > 1) {
    return {
      ok: false,
      message: `"${trimmed}" matches more than one project: ${resolved
        .map((project) => project.path)
        .join(", ")}. Pass the project's path instead.`,
    };
  }
  const known = projects.slice(0, MAX_LISTED_PROJECTS).map((project) => project.label);
  return {
    ok: false,
    message: known.length > 0
      ? `No project named "${trimmed}". Known projects: ${known.join(", ")}. list_instance_projects gives each one's projectKey.`
      : `No project named "${trimmed}", and PwrAgent lists no projects yet.`,
  };
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/** The deepest project whose root holds `path`; nested clones are rare. */
function containingProjects(
  path: string,
  projects: readonly ThreadTodoProject[],
): ThreadTodoProject[] {
  let best: ThreadTodoProject[] = [];
  let bestLength = 0;
  for (const project of projects) {
    const root = canonicalizeNavigationPath(project.path);
    if (!root || !path.startsWith(`${root}/`)) continue;
    if (root.length > bestLength) {
      best = [project];
      bestLength = root.length;
    }
  }
  return best;
}

function projectsNamed(
  name: string,
  projects: readonly ThreadTodoProject[],
): ThreadTodoProject[] {
  const needle = name.toLowerCase();
  if (!needle) return [];
  return projects.filter((project) =>
    project.label.toLowerCase() === needle
    || basename(project.path).toLowerCase() === needle);
}

/**
 * The project a thread is filed under, from its first linked directory. The
 * label comes from the sidebar's row when there is one, so the card reads
 * the same as the Directories lens.
 */
export function threadTodoProjectForDirectory(
  directory: LinkedDirectorySummary | undefined,
  candidates: readonly ThreadTodoProjectCandidate[],
): ThreadTodoProject | undefined {
  if (!directory) return undefined;
  const descriptor = classifyDirectory(directory);
  const row = candidates.find((candidate) => candidate.key === descriptor.key);
  return {
    key: descriptor.key,
    label: row?.label ?? descriptor.label,
    path: descriptor.path ?? directory.path,
  };
}

/**
 * A peer's copy of a project, matched by label and then by folder name: a
 * peer keys its projects by its own paths, so a key never matches across
 * machines.
 */
export function findPeerThreadTodoProject(
  project: ThreadTodoProject,
  candidates: readonly ThreadTodoProjectCandidate[],
): ThreadTodoProjectCandidate | undefined {
  const label = project.label.toLowerCase();
  const folder = basename(project.path).toLowerCase();
  const directories = candidates.filter((candidate) => candidate.kind === "directory");
  return directories.find((candidate) => candidate.label.toLowerCase() === label)
    ?? directories.find((candidate) =>
      candidate.path !== undefined && basename(candidate.path).toLowerCase() === folder);
}

function basename(path: string): string {
  const canonical = canonicalizeNavigationPath(path).replace(/\/+$/, "");
  return canonical.slice(canonical.lastIndexOf("/") + 1);
}
