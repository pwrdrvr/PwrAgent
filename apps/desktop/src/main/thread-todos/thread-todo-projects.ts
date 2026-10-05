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
 * Resolve the project a thread named ("PwrSnap", a path, or a directory key)
 * against the projects the sidebar lists. Only real directories qualify:
 * Workspaces and unlinked rows are not somewhere work can be sent.
 *
 * A name that matches two projects is refused rather than guessed, since
 * two clones can share a folder name and the card would act in whichever
 * one won.
 */
export function matchThreadTodoProject(
  query: string,
  candidates: readonly ThreadTodoProjectCandidate[],
): ThreadTodoProjectMatch {
  const projects = candidates.filter(
    (candidate): candidate is ThreadTodoProjectCandidate & { path: string } =>
      candidate.kind === "directory" && typeof candidate.path === "string",
  );
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const asPath = canonicalizeNavigationPath(trimmed);
  const exact = projects.filter((project) =>
    project.key === trimmed
    || canonicalizeNavigationPath(project.path) === asPath);
  const byName = exact.length > 0
    ? exact
    : projects.filter((project) =>
        project.label.toLowerCase() === needle
        || basename(project.path).toLowerCase() === needle);
  const matches = [...new Map(byName.map((project) => [project.key, project])).values()];
  if (matches.length === 1) {
    const [project] = matches;
    return {
      ok: true,
      project: { key: project!.key, label: project!.label, path: project!.path },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${trimmed}" matches more than one project: ${matches
        .map((project) => project.path)
        .join(", ")}. Pass the project's path instead.`,
    };
  }
  const known = projects.slice(0, MAX_LISTED_PROJECTS).map((project) => project.label);
  return {
    ok: false,
    message: known.length > 0
      ? `No project named "${trimmed}". Known projects: ${known.join(", ")}.`
      : `No project named "${trimmed}", and PwrAgent lists no projects yet.`,
  };
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
