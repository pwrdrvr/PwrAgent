import { moveDirectoryKey, type NavigationRelativePinMove } from "@pwragent/shared";
import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../lib/navigation-loaded-rows";

/**
 * What releasing a held project does. The Directories list's folder drag and
 * the project index both end in one of these, so a project is pinned, moved
 * and unpinned the same way from either.
 */
export type DirectoryDrop =
  | { kind: "move"; anchorKey: string; placement: "before" | "after" }
  | { kind: "unpin" }
  /** The ghost Pin slot, offered only while nothing is pinned. */
  | { kind: "pin" };

/**
 * Apply a drop to the pinned-directory order. A pin moves among the pins; an
 * unpinned project is pinned first and then moved to the line, as the owner
 * places a new pin before any anchor resolves.
 */
export async function applyDirectoryDrop(input: {
  directory: NavigationDirectorySummary;
  drop: DirectoryDrop;
  /** The pinned order as it stood when the drag began. */
  pinnedKeys: readonly string[];
  setPin?: (directory: NavigationDirectorySummary, pinned: boolean) => Promise<void>;
  reorderPins?: (directoryKeys: string[], move?: NavigationRelativePinMove) => Promise<void>;
}): Promise<void> {
  const { directory, drop } = input;
  if (drop.kind === "unpin") {
    await input.setPin?.(directory, false);
    return;
  }
  if (drop.kind === "pin") {
    await input.setPin?.(directory, true);
    return;
  }
  const move = { key: directory.key, anchorKey: drop.anchorKey, placement: drop.placement };
  if (input.pinnedKeys.includes(directory.key)) {
    await input.reorderPins?.(
      moveDirectoryKey([...input.pinnedKeys], directory.key, drop.anchorKey, drop.placement),
      move,
    );
    return;
  }
  await input.setPin?.(directory, true);
  await input.reorderPins?.([], move);
}
