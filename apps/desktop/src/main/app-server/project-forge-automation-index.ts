import type {
  AppServerBackendKind,
  DirectoryOverlayState,
  LinkedDirectorySummary,
  NavigationDirectorySummary,
  ProjectForgeAutomation,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  classifyDirectory,
  isDefaultProjectForgeAutomation,
  isToolManagedWorktreePath,
  orderByHomePreference,
  resolveProjectForgeAutomation,
} from "@pwragent/shared";

/** A thread's Directories project and that project's Forge Automation. */
export type ProjectForgeAutomationResolution = {
  directoryKey: string;
  label: string;
  automation: ProjectForgeAutomation;
};

/**
 * What the index can classify when the last navigation scan did not list the
 * thread yet, such as a thread created a moment ago.
 */
export type ProjectForgeThreadHint = {
  linkedDirectories?: readonly LinkedDirectorySummary[];
};

export type ProjectForgeThreadRef = {
  backend: AppServerBackendKind;
  threadId: string;
};

const DIRECTORY_KEY_PREFIX = "directory:";

/**
 * The owner's per-project Forge Automation, held in memory so every gate
 * stays O(1): background polling consults it per poll target, Auto-fix and
 * watches per dispatch.
 *
 * Settings come from the state DB overlay (`hydrate`) and each Save (`set`).
 * Thread membership comes from the complete navigation scans
 * (`rememberDirectories`), so a thread belongs to the same project here as
 * in the Directories lens, worktrees included. A thread the last scan did
 * not list is classified from its linked directories with the same
 * `classifyDirectory` rule.
 *
 * Nothing here reads SQLite. While no project stores a setting, every lookup
 * returns before touching a map.
 */
export class ProjectForgeAutomationIndex {
  private readonly automations = new Map<string, ProjectForgeAutomation>();
  private readonly directoryKeyByThreadKey = new Map<string, string>();
  private readonly labelByDirectoryKey = new Map<string, string>();
  /** Label → key for the scan's stable project rows; null when ambiguous. */
  private readonly directoryKeyByLabel = new Map<string, string | null>();
  private hydrated = false;

  /** Load every stored setting. Replaces what the index held. */
  hydrate(overlays: Record<string, DirectoryOverlayState | undefined>): void {
    this.automations.clear();
    for (const [directoryKey, overlay] of Object.entries(overlays)) {
      if (!overlay?.forgeAutomation) continue;
      this.setStored(directoryKey, resolveProjectForgeAutomation(overlay.forgeAutomation));
    }
    this.hydrated = true;
  }

  isHydrated(): boolean {
    return this.hydrated;
  }

  /** Record a Save. Null, or a value equal to the defaults, clears it. */
  set(directoryKey: string, automation: ProjectForgeAutomation | null): void {
    if (!automation) {
      this.automations.delete(directoryKey);
      return;
    }
    this.setStored(directoryKey, automation);
  }

  /** The stored setting, or undefined when the project uses the defaults. */
  get(directoryKey: string): ProjectForgeAutomation | undefined {
    return this.automations.get(directoryKey);
  }

  hasAny(): boolean {
    return this.automations.size > 0;
  }

  /** Every project with a stored setting. */
  entries(): Array<[string, ProjectForgeAutomation]> {
    return [...this.automations.entries()];
  }

  /**
   * Adopt a complete navigation scan's project membership. `replace` drops
   * threads the scan no longer lists; a partial scan only adds.
   */
  rememberDirectories(
    directories: readonly NavigationDirectorySummary[],
    options: { replace: boolean } = { replace: true },
  ): void {
    if (options.replace) {
      this.directoryKeyByThreadKey.clear();
      this.directoryKeyByLabel.clear();
    }
    const labelPaths = new Map<string, Set<string>>();
    for (const directory of directories) {
      if (!isLocalProjectRow(directory)) continue;
      this.labelByDirectoryKey.set(directory.key, directory.label);
      for (const threadKey of directory.threadKeys) {
        this.directoryKeyByThreadKey.set(threadKey, directory.key);
      }
      if (directory.path && !isToolManagedWorktreePath(directory.path)) {
        const keys = labelPaths.get(directory.label) ?? new Set<string>();
        keys.add(directory.key);
        labelPaths.set(directory.label, keys);
      }
      // Before the first hydrate, the scan's own overlay projection is the
      // best source there is. A hydrate or Save after this replaces it.
      if (!this.hydrated && directory.forgeAutomation) {
        this.setStored(directory.key, directory.forgeAutomation);
      }
    }
    for (const [label, keys] of labelPaths) {
      const known = this.directoryKeyByLabel.get(label);
      const key = keys.size === 1 ? [...keys][0]! : null;
      this.directoryKeyByLabel.set(
        label,
        known === undefined || known === key ? key : null,
      );
    }
  }

  /** Display label for a project, from the last scan or its path. */
  label(directoryKey: string): string {
    return this.labelByDirectoryKey.get(directoryKey)
      ?? labelFromDirectoryKey(directoryKey);
  }

  /**
   * The Directories project a thread is filed under, or undefined when it
   * has none (no directory, a Workspaces scratch folder, or unknown).
   */
  directoryKeyForThread(
    ref: ProjectForgeThreadRef,
    lookupHint?: () => ProjectForgeThreadHint | undefined,
  ): string | undefined {
    const threadKey = buildThreadIdentityKey(ref.backend, ref.threadId);
    const listed = this.directoryKeyByThreadKey.get(threadKey);
    if (listed) return listed;
    const linked = lookupHint?.()?.linkedDirectories;
    return linked?.length ? this.directoryKeyForLinkedDirectories(linked) : undefined;
  }

  /**
   * The project a set of linked directories files under, by the Directories
   * lens's own classification: worktrees onto their repository, scratch
   * folders nowhere.
   */
  directoryKeyForLinkedDirectories(
    linked: readonly LinkedDirectorySummary[],
  ): string | undefined {
    const descriptors = linked
      .map((directory) => classifyDirectory(directory))
      .filter((descriptor) =>
        descriptor.kind === "directory"
        && descriptor.key.startsWith(DIRECTORY_KEY_PREFIX)
      )
      .map((descriptor) => {
        // A tool-managed worktree folds onto the one project row with its
        // name, as the Directories lens folds it by label.
        if (!descriptor.path || !isToolManagedWorktreePath(descriptor.path)) {
          return descriptor;
        }
        const key = this.directoryKeyByLabel.get(descriptor.label);
        return key ? { ...descriptor, key } : descriptor;
      });
    return orderByHomePreference(descriptors, (descriptor) => descriptor.path)[0]?.key;
  }

  /**
   * The stored setting for a thread's project, or undefined when the thread
   * has no project or its project uses the defaults. This is the hot path.
   */
  automationForThread(
    ref: ProjectForgeThreadRef,
    lookupHint?: () => ProjectForgeThreadHint | undefined,
  ): ProjectForgeAutomation | undefined {
    if (this.automations.size === 0) return undefined;
    const directoryKey = this.directoryKeyForThread(ref, lookupHint);
    return directoryKey ? this.automations.get(directoryKey) : undefined;
  }

  /**
   * The thread's project with its effective setting. Undefined when no
   * project stores a setting or the thread has no project with one, so the
   * callers that only gate can return early.
   */
  resolveThread(
    ref: ProjectForgeThreadRef,
    lookupHint?: () => ProjectForgeThreadHint | undefined,
  ): ProjectForgeAutomationResolution | undefined {
    if (this.automations.size === 0) return undefined;
    const directoryKey = this.directoryKeyForThread(ref, lookupHint);
    const automation = directoryKey ? this.automations.get(directoryKey) : undefined;
    if (!directoryKey || !automation) return undefined;
    return { directoryKey, label: this.label(directoryKey), automation };
  }

  /**
   * The project a working directory files under, with its setting. A path
   * inside a project with a setting, such as a `.worktrees/` checkout or a
   * package folder, counts as that project.
   */
  resolvePath(path: string): ProjectForgeAutomationResolution | undefined {
    if (this.automations.size === 0) return undefined;
    const classified = this.directoryKeyForLinkedDirectories([{
      id: path,
      kind: "local",
      label: labelFromDirectoryKey(path),
      path,
    }]);
    const directoryKey = classified && this.automations.has(classified)
      ? classified
      : this.storedProjectContaining(path) ?? classified;
    const automation = directoryKey ? this.automations.get(directoryKey) : undefined;
    if (!directoryKey || !automation) return undefined;
    return { directoryKey, label: this.label(directoryKey), automation };
  }

  /** Thread keys the last scans filed under this project. */
  threadKeysForDirectory(directoryKey: string): string[] {
    const threadKeys: string[] = [];
    for (const [threadKey, key] of this.directoryKeyByThreadKey) {
      if (key === directoryKey) threadKeys.push(threadKey);
    }
    return threadKeys;
  }

  /** The deepest project with a setting whose folder contains the path. */
  private storedProjectContaining(path: string): string | undefined {
    const target = path.replace(/[\\/]+$/, "");
    let match: string | undefined;
    let matchLength = 0;
    for (const directoryKey of this.automations.keys()) {
      const root = directoryKey.slice(DIRECTORY_KEY_PREFIX.length).replace(/[\\/]+$/, "");
      if (!root || root.length <= matchLength) continue;
      if (
        target === root
        || target.startsWith(`${root}/`)
        || target.startsWith(`${root}\\`)
      ) {
        match = directoryKey;
        matchLength = root.length;
      }
    }
    return match;
  }

  private setStored(directoryKey: string, automation: ProjectForgeAutomation): void {
    if (!directoryKey.startsWith(DIRECTORY_KEY_PREFIX) || isDefaultProjectForgeAutomation(automation)) {
      this.automations.delete(directoryKey);
      return;
    }
    this.automations.set(directoryKey, automation);
  }
}

function isLocalProjectRow(directory: NavigationDirectorySummary): boolean {
  return directory.kind === "directory"
    && directory.key.startsWith(DIRECTORY_KEY_PREFIX)
    && !directory.localAvailability;
}

function labelFromDirectoryKey(directoryKey: string): string {
  const path = directoryKey.startsWith(DIRECTORY_KEY_PREFIX)
    ? directoryKey.slice(DIRECTORY_KEY_PREFIX.length)
    : directoryKey;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** One line for a held wake-up in the resume list. */
export function summarizeProjectHeldWakeup(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "Wake-up";
  return line.length <= 120 ? line : `${line.slice(0, 119).trimEnd()}…`;
}

let sharedIndex: ProjectForgeAutomationIndex | undefined;

/** The owner's one index, shared by the PR coordinators and the registry. */
export function getProjectForgeAutomationIndex(): ProjectForgeAutomationIndex {
  sharedIndex ??= new ProjectForgeAutomationIndex();
  return sharedIndex;
}

/** Tests replace the shared index so settings never leak between cases. */
export function resetProjectForgeAutomationIndexForTests(): void {
  sharedIndex = undefined;
}
