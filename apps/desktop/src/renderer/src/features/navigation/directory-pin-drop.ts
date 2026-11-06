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

/** A held project's possible anchor, in viewport px. */
export type DirectoryDropBox = { key: string; top: number; bottom: number; pinned: boolean };

/** Where a held project would land, and what the drop does. */
export type DirectoryDropHit =
  /** The insertion line, on the edge of the project `anchorKey`. */
  | { kind: "line"; anchorKey: string; position: "before" | "after"; drop: DirectoryDrop; label?: string }
  /** The divider after the pins, lit as the Unpin target. */
  | { kind: "seam"; drop: DirectoryDrop; label: string }
  /** The ghost Pin slot, offered while nothing is pinned. */
  | { kind: "slot"; drop: DirectoryDrop; label: string };

/**
 * Where a held project lands. The Directories list measures its folded
 * headers and its divider, the project index its names and its hairline;
 * both hand the boxes here so a pointer position means the same drop in each.
 *
 * - Among the pins, the line goes on the nearer edge of the pin under the
 *   pointer. A pin's own edges are no move.
 * - At or below the divider, a held pin unpins. A held unpinned project over
 *   the divider itself joins the pins at the end; below it there is nothing
 *   to drop on, because the rest are in name order.
 * - With no pins, only a drop inside the ghost Pin slot's own box pins.
 */
export function resolveDirectoryDrop(input: {
  y: number;
  source: { key: string; pinned: boolean };
  items: readonly DirectoryDropBox[];
  seam?: { top: number; bottom: number };
  pinSlot?: { top: number; bottom: number };
}): DirectoryDropHit | undefined {
  const { y, source } = input;
  if (input.pinSlot) {
    const slot = input.pinSlot;
    return !source.pinned && y >= slot.top && y <= slot.bottom
      ? { kind: "slot", drop: { kind: "pin" }, label: "Pin" }
      : undefined;
  }
  const pins = input.items.filter((item) => item.pinned);
  if (input.seam && y >= input.seam.top) {
    if (source.pinned) return { kind: "seam", drop: { kind: "unpin" }, label: "Unpin" };
    const last = pins[pins.length - 1];
    if (y > input.seam.bottom || last === undefined) return undefined;
    return {
      kind: "line",
      anchorKey: last.key,
      position: "after",
      drop: { kind: "move", anchorKey: last.key, placement: "after" },
      label: "Pin",
    };
  }
  if (pins.length === 0) return undefined;
  const before = pins.findIndex((pin) => y < (pin.top + pin.bottom) / 2);
  const insertAt = before < 0 ? pins.length : before;
  const sourceIndex = pins.findIndex((pin) => pin.key === source.key);
  if (sourceIndex >= 0 && (insertAt === sourceIndex || insertAt === sourceIndex + 1)) return undefined;
  const anchor = pins[before < 0 ? pins.length - 1 : before]!;
  const placement = before < 0 ? "after" : "before";
  return {
    kind: "line",
    anchorKey: anchor.key,
    position: placement,
    drop: { kind: "move", anchorKey: anchor.key, placement },
    ...(source.pinned ? {} : { label: "Pin" }),
  };
}

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
