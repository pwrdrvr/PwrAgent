import { buildThreadUrl, type ThreadLinkRef } from "@pwragent/shared";
import type { ChipContextMenuItem } from "./ChipContextMenu";

export function threadCopyTargets(
  link: ThreadLinkRef & { gitBranch?: string; title?: string },
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

  return targets;
}
