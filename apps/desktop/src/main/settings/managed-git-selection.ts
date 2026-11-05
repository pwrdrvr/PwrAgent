import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DesktopGitRuntimeChoice } from "@pwragent/shared";
import { MANAGED_GIT_GENERATION_PATTERN } from "../managed-git-verify";
import { parseTomlTables } from "./toml-editor";

/**
 * `[applications.git]` stores the Git the operator chose in three keys:
 * `path` (a manual or installed Git, which wins), `managed` (a downloaded
 * PwrDrvr release) and `managed_previous` (what Roll back returns to).
 */
export function encodeGitRuntimeChoice(choice: DesktopGitRuntimeChoice): string {
  switch (choice.kind) {
    case "bundled":
      return "bundled";
    case "managed":
      return `managed:${choice.generation}`;
    case "path":
      return `path:${choice.path}`;
  }
}

export function decodeGitRuntimeChoice(value: string | undefined): DesktopGitRuntimeChoice | undefined {
  if (!value) return undefined;
  if (value === "bundled") return { kind: "bundled" };
  if (value.startsWith("managed:")) {
    const generation = value.slice("managed:".length);
    return MANAGED_GIT_GENERATION_PATTERN.test(generation) ? { kind: "managed", generation } : undefined;
  }
  if (value.startsWith("path:") && value.length > "path:".length) {
    return { kind: "path", path: value.slice("path:".length) };
  }
  return undefined;
}

/** The choice a profile's config makes, in the order Git resolution reads it. */
export function currentGitRuntimeChoice(git: { path?: string; managed?: string } | undefined): DesktopGitRuntimeChoice {
  const manual = git?.path?.trim();
  if (manual) return { kind: "path", path: manual };
  const managed = git?.managed?.trim();
  if (managed && MANAGED_GIT_GENERATION_PATTERN.test(managed)) return { kind: "managed", generation: managed };
  return { kind: "bundled" };
}

export function sameGitRuntimeChoice(left: DesktopGitRuntimeChoice, right: DesktopGitRuntimeChoice): boolean {
  return encodeGitRuntimeChoice(left) === encodeGitRuntimeChoice(right);
}

/**
 * The config patch for an explicit selection. Selecting writes all three keys
 * at once, so the stored choice and its roll-back target always agree, and
 * the choice being left becomes the roll-back target.
 */
export function gitRuntimeSelectionPatch(
  current: DesktopGitRuntimeChoice,
  next: DesktopGitRuntimeChoice,
): { path: string; managed: string; managedPrevious?: string } {
  return {
    path: next.kind === "path" ? next.path : "",
    managed: next.kind === "managed" ? next.generation : "",
    ...(sameGitRuntimeChoice(current, next) ? {} : { managedPrevious: encodeGitRuntimeChoice(current) }),
  };
}

/** Releases a config names, as the current Git or the roll-back target. */
export function managedGenerationsNamed(git: { managed?: unknown; managedPrevious?: unknown; managed_previous?: unknown } | undefined): string[] {
  const names: string[] = [];
  const managed = typeof git?.managed === "string" ? git.managed.trim() : "";
  if (MANAGED_GIT_GENERATION_PATTERN.test(managed)) names.push(managed);
  const previousRaw = git?.managedPrevious ?? git?.managed_previous;
  const previous = decodeGitRuntimeChoice(typeof previousRaw === "string" ? previousRaw : undefined);
  if (previous?.kind === "managed") names.push(previous.generation);
  return names;
}

/**
 * Every release any profile under this PwrAgent root names. Releases are
 * shared by all profiles, so one profile removing or pruning a release must
 * not break another profile's selection or its roll-back. An unreadable
 * profile config protects nothing and blocks nothing; the release it might
 * name stays protected only while a live process has marked it in use.
 */
export function readProfileManagedGitSelections(pwragentRoot: string): Set<string> {
  const protectedGenerations = new Set<string>();
  const profilesDir = path.join(pwragentRoot, "profiles");
  let names: string[];
  try {
    names = readdirSync(profilesDir);
  } catch {
    return protectedGenerations;
  }
  for (const name of names) {
    const configPath = path.join(profilesDir, name, "config.toml");
    try {
      const tables = parseTomlTables(readFileSync(configPath, "utf8"), configPath);
      for (const generation of managedGenerationsNamed(tables["applications.git"])) {
        protectedGenerations.add(generation);
      }
    } catch {
      // No config, or one that does not parse.
    }
  }
  return protectedGenerations;
}
