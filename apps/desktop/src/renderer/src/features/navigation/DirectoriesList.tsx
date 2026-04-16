import type { NavigationThreadSummary } from "@pwragnt/shared";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";

type DirectoriesListProps = {
  selectedThreadId?: string;
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

export function DirectoriesList(props: DirectoriesListProps) {
  const groups = groupThreadsByDirectory(props.threads);

  return (
    <div className="directory-groups">
      {groups.map((group) => (
        <section key={group.id} className="directory-group">
          <header className="directory-group__header">
            <h3 className="directory-group__title">
              <button
                aria-label={`Copy path for ${group.label}`}
                className="directory-group__button path-copy-target"
                title={group.path ? formatCopyTooltip(group.path) : undefined}
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
              const selected = thread.id === props.selectedThreadId;
              return (
                <button
                  key={`${group.id}:${thread.id}`}
                  aria-pressed={selected}
                  className={`thread-row thread-row--compact${selected ? " is-selected" : ""}`}
                  type="button"
                  onClick={() => props.onSelectThread(thread)}
                >
                  <span className="thread-row__header">
                    <span className="thread-row__title">{thread.title}</span>
                    <span className="thread-row__time">
                      {formatRelativeTime(thread.updatedAt)}
                    </span>
                  </span>
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

  for (const thread of threads) {
    if (thread.linkedDirectories.length === 0) {
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
      const existing = groups.get(directory.id);
      if (existing) {
        existing.threads.push(thread);
        continue;
      }

      groups.set(directory.id, {
        id: directory.id,
        icon: "📁",
        label: directory.label,
        path: directory.path,
        threads: [thread]
      });
    }
  }

  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
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
