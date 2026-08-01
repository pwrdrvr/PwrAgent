import {
  buildThreadUrl,
  type LinkedDirectorySummary,
  type ThreadLinkRef,
} from "@pwragent/shared";
import type { ChipContextMenuItem } from "./ChipContextMenu";

export type ThreadChipMenuLink = ThreadLinkRef & {
  gitBranch?: string;
  linkedDirectories?: LinkedDirectorySummary[];
  title?: string;
};

export function threadCopyTargets(
  link: ThreadChipMenuLink,
  label: string,
): ChipContextMenuItem[] {
  const targets: ChipContextMenuItem[] = [
    {
      label: "Copy Thread Link",
      copyValue: buildThreadUrl(link),
    },
    {
      label: "Copy Thread ID",
      copyValue: link.threadId,
      separated: true,
    },
    {
      label: "Copy Thread Name",
      copyValue: label,
    },
  ];

  if (link.gitBranch) {
    targets.push({
      label: "Copy Branch Name",
      copyValue: link.gitBranch,
    });
  }

  const directories = uniqueThreadDirectories(link.linkedDirectories ?? []);
  if (directories.length === 1) {
    targets.push({
      label: "Copy Thread Directory",
      copyValue: directories[0]!.copyPath,
    });
  } else if (directories.length > 1) {
    for (const directory of directories) {
      targets.push({
        label: `Copy Thread Directory — ${directory.label} (${directory.kind})`,
        copyValue: directory.copyPath,
      });
    }
  }

  return targets;
}

function uniqueThreadDirectories(
  directories: LinkedDirectorySummary[],
): Array<{ copyPath: string; kind: LinkedDirectorySummary["kind"]; label: string }> {
  const byCopyPath = new Map<
    string,
    { copyPath: string; kind: LinkedDirectorySummary["kind"]; label: string }
  >();
  for (const directory of directories) {
    const copyPath = directory.kind === "worktree"
      ? directory.worktreePath ?? directory.path
      : directory.path;
    if (!byCopyPath.has(copyPath)) {
      byCopyPath.set(copyPath, {
        copyPath,
        kind: directory.kind,
        label: directory.label,
      });
    }
  }
  return [...byCopyPath.values()];
}
