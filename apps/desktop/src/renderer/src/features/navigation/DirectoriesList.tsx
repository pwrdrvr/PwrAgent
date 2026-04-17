import type { LinkedDirectorySummary, NavigationThreadSummary } from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";
import { ThreadMetaChips } from "./ThreadMetaChips";

type DirectoriesListProps = {
  selectedThreadKey?: string;
  threads: NavigationThreadSummary[];
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

type DirectoryGroup = {
  id: string;
  icon: string;
  label: string;
  path?: string;
  threads: NavigationThreadSummary[];
};

type DirectoryGroupDescriptor = Omit<DirectoryGroup, "threads">;
type DirectoryIdentity =
  | {
      kind: "scratch-workspaces";
      path: string;
    }
  | {
      kind: "stable";
      label: string;
      path: string;
    }
  | {
      kind: "codex-worktree";
      label: string;
    };

const DIRECTORY_THREAD_AGE_OUT_MS = 30 * 24 * 60 * 60 * 1000;

export function DirectoriesList(props: DirectoriesListProps) {
  const groups = groupThreadsByDirectory(props.threads);

  if (groups.length === 0) {
    return <p className="sidebar-empty">No directory-linked threads.</p>;
  }

  return (
    <div className="directory-groups">
      {groups.map((group) => (
        <section key={group.id} className="directory-group">
          <header className="directory-group__header">
            <h3 className="directory-group__title">
              <button
                aria-label={`Copy path for ${group.label}`}
                className="directory-group__button path-copy-target tooltip-target"
                data-tooltip={group.path ? formatCopyTooltip(group.path) : undefined}
                type="button"
                onClick={() => {
                  if (group.path) {
                    void copyText(group.path);
                  }
                }}
              >
                <span aria-hidden="true" className="directory-group__icon">
                  {group.icon}
                </span>
                {group.label}
              </button>
            </h3>
            <span className="directory-group__count">
              {group.threads.length} thread{group.threads.length === 1 ? "" : "s"}
            </span>
          </header>

          <div className="sidebar-list sidebar-list--compact" role="list">
            {group.threads.map((thread) => {
              const selected =
                buildThreadIdentityKey(thread.source, thread.id) === props.selectedThreadKey;
              return (
                <button
                  key={`${group.id}:${buildThreadIdentityKey(thread.source, thread.id)}`}
                  aria-pressed={selected}
                  className={`thread-row${selected ? " is-selected" : ""}`}
                  type="button"
                  onClick={() => props.onSelectThread(thread)}
                >
                  <span className="thread-row__header">
                    <span className="thread-row__title">{thread.title}</span>
                    <span className="thread-row__time">
                      {formatRelativeTime(thread.updatedAt)}
                    </span>
                  </span>
                  <ThreadMetaChips thread={thread} />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function groupThreadsByDirectory(threads: NavigationThreadSummary[]): DirectoryGroup[] {
  const groups = new Map<string, DirectoryGroup>();
  const visibleThreads = threads.filter((thread) => shouldShowThreadInDirectories(thread));
  const stablePathByLabel = collectStablePathByLabel(visibleThreads);

  for (const thread of visibleThreads) {
    if (thread.linkedDirectories.length === 0) {
      if (thread.projectKey?.trim()) {
        continue;
      }

      const unlinked = groups.get("unlinked");
      if (unlinked) {
        unlinked.threads.push(thread);
      } else {
        groups.set("unlinked", {
          id: "unlinked",
          icon: "•",
          label: "No linked directory",
          threads: [thread]
        });
      }
      continue;
    }

    for (const directory of thread.linkedDirectories) {
      const descriptor = getDirectoryGroupDescriptor(directory, stablePathByLabel);
      const existing = groups.get(descriptor.id);
      if (existing) {
        existing.threads.push(thread);
        continue;
      }

      groups.set(descriptor.id, {
        ...descriptor,
        threads: [thread]
      });
    }
  }

  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function shouldShowThreadInDirectories(thread: NavigationThreadSummary): boolean {
  if (thread.inbox.inInbox) {
    return true;
  }

  if (!thread.updatedAt) {
    return true;
  }

  return Date.now() - thread.updatedAt < DIRECTORY_THREAD_AGE_OUT_MS;
}

function collectStablePathByLabel(
  threads: NavigationThreadSummary[]
): Map<string, string | undefined> {
  const pathsByLabel = new Map<string, Set<string>>();

  for (const thread of threads) {
    for (const directory of thread.linkedDirectories) {
      const identity = classifyDirectory(directory);
      if (identity.kind !== "stable") {
        continue;
      }

      const paths = pathsByLabel.get(identity.label) ?? new Set<string>();
      paths.add(identity.path);
      pathsByLabel.set(identity.label, paths);
    }
  }

  return new Map(
    [...pathsByLabel.entries()].map(([label, paths]) => [
      label,
      paths.size === 1 ? [...paths][0] : undefined
    ])
  );
}

function getDirectoryGroupDescriptor(
  directory: LinkedDirectorySummary,
  stablePathByLabel: Map<string, string | undefined>
): DirectoryGroupDescriptor {
  const identity = classifyDirectory(directory);

  if (identity.kind === "scratch-workspaces") {
    return {
      id: `workspaces:${identity.path}`,
      icon: "📁",
      label: "Workspaces",
      path: identity.path
    };
  }

  if (identity.kind === "codex-worktree") {
    const stablePath = stablePathByLabel.get(identity.label);
    if (stablePath) {
      return {
        id: `directory:${stablePath}`,
        icon: "📁",
        label: identity.label,
        path: stablePath
      };
    }

    return {
      id: `codex-worktree:${identity.label}`,
      icon: "📁",
      label: identity.label
    };
  }

  return {
    id: `directory:${identity.path}`,
    icon: "📁",
    label: identity.label,
    path: identity.path
  };
}

function classifyDirectory(directory: LinkedDirectorySummary): DirectoryIdentity {
  const scratchWorkspaceMatch = directory.path.match(
    /^(.*[\\/]\.pwragnt[\\/]projects)[\\/][^\\/]+$/
  );
  if (scratchWorkspaceMatch) {
    return {
      kind: "scratch-workspaces",
      path: scratchWorkspaceMatch[1]
    };
  }

  const repoWorktreeMatch = directory.path.match(
    /^(.*)[\\/]\.worktrees[\\/][^\\/]+(?:[\\/].*)?$/
  );
  if (repoWorktreeMatch) {
    const canonicalPath = repoWorktreeMatch[1];
    return {
      kind: "stable",
      label: pathBaseName(canonicalPath),
      path: canonicalPath
    };
  }

  const codexWorktreeMatch = directory.path.match(
    /^[\\/].*[\\/]\.codex[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+)(?:[\\/].*)?$/
  );
  if (codexWorktreeMatch) {
    return {
      kind: "codex-worktree",
      label: codexWorktreeMatch[1]
    };
  }

  return {
    kind: "stable",
    label: directory.label,
    path: directory.path
  };
}

function pathBaseName(pathname: string): string {
  const normalized = pathname.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? pathname;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return "now";
  }

  const deltaMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / (1000 * 60))
  );

  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(timestamp);
}
