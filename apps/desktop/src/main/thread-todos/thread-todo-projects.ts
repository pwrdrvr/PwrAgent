import type {
  DirectorySummaryKind,
  LinkedDirectorySummary,
  ProjectRepositoryIdentity,
  ThreadTodoProject,
} from "@pwragent/shared";
import {
  canonicalizeNavigationPath,
  classifyDirectory,
  findPeerCounterpartDirectory,
} from "@pwragent/shared";

/** One row of the Directories lens, as the directory-index query lists it. */
export type ThreadTodoProjectCandidate = ProjectRepositoryIdentity & {
  key: string;
  label: string;
  kind: DirectorySummaryKind;
  path?: string;
  /** Listed only because a thread names it: no checkout to start in. */
  localAvailability?: "unconfigured";
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
  const isPath = looksLikePath(trimmed);
  // Most specific first. macOS and Windows paths ignore case, so a path
  // that matches nothing exactly is tried again without it.
  const lookups: Array<() => ThreadTodoProject[]> = [
    () => projects.filter((project) =>
      project.key === trimmed || samePath(project.path, asPath, false)),
    ...(isPath
      ? [
          () => containingProjects(asPath, projects, false),
          () => projects.filter((project) => samePath(project.path, asPath, true)),
          () => containingProjects(asPath, projects, true),
        ]
      : []),
    () => projectsNamed(isPath ? basename(trimmed) : trimmed, projects),
  ];
  let resolved: ThreadTodoProject[] = [];
  for (const lookup of lookups) {
    resolved = lookup();
    if (resolved.length > 0) break;
  }
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

function comparablePath(path: string, ignoreCase: boolean): string {
  const canonical = canonicalizeNavigationPath(path);
  return ignoreCase ? canonical.toLowerCase() : canonical;
}

function samePath(projectPath: string, path: string, ignoreCase: boolean): boolean {
  return comparablePath(projectPath, ignoreCase) === comparablePath(path, ignoreCase);
}

/** The deepest project whose root holds `path`; nested clones are rare. */
function containingProjects(
  path: string,
  projects: readonly ThreadTodoProject[],
  ignoreCase: boolean,
): ThreadTodoProject[] {
  const target = comparablePath(path, ignoreCase);
  let best: ThreadTodoProject[] = [];
  let bestLength = 0;
  for (const project of projects) {
    const root = comparablePath(project.path, ignoreCase);
    if (!root || !target.startsWith(`${root}/`)) continue;
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
 * The repository a card's project clones, read from this machine's own row
 * for it. The card stores only key, label and path, and a key is a path on
 * this machine, so the row is found by key and then by path.
 */
export function threadTodoProjectIdentity(
  project: ThreadTodoProject,
  candidates: readonly ThreadTodoProjectCandidate[],
): ThreadTodoProject & ProjectRepositoryIdentity {
  const row = candidates.find((candidate) => candidate.key === project.key)
    ?? candidates.find((candidate) =>
      candidate.path !== undefined && samePath(candidate.path, project.path, false));
  return {
    ...project,
    ...(row?.repositoryKey ? { repositoryKey: row.repositoryKey } : {}),
    ...(row?.repositoryKeys?.length ? { repositoryKeys: row.repositoryKeys } : {}),
  };
}

/**
 * Another machine's copy of a project, by the rule every cross-machine
 * project match uses (`findPeerCounterpartDirectory`): the same origin, then
 * a shared fetch remote, then the name when either side has no remote. So
 * `~/src/PwrAgnt` here finds `C:\src\PwrAgent` there when both clone
 * `github.com/pwrdrvr/pwragent`. A peer keys its projects by its own paths,
 * so a key never matches across machines.
 */
export function findPeerThreadTodoProject(
  project: ThreadTodoProject & ProjectRepositoryIdentity,
  candidates: readonly ThreadTodoProjectCandidate[],
): ThreadTodoProjectCandidate | undefined {
  // A peer's request names the project, so keep only well-formed keys.
  const repositoryKey = typeof project.repositoryKey === "string" && project.repositoryKey
    ? project.repositoryKey
    : undefined;
  const repositoryKeys = Array.isArray(project.repositoryKeys)
    ? project.repositoryKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
    : [];
  return findPeerCounterpartDirectory({
    kind: "directory",
    label: project.label,
    path: project.path,
    ...(repositoryKey ? { repositoryKey } : {}),
    ...(repositoryKeys.length ? { repositoryKeys } : {}),
  }, candidates);
}

function basename(path: string): string {
  const canonical = canonicalizeNavigationPath(path).replace(/\/+$/, "");
  return canonical.slice(canonical.lastIndexOf("/") + 1);
}
